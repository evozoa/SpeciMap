/**
 * Upload-and-pull for simple local rows (subsamples, location checks): each
 * row is uploaded by one idempotent upsert. Same guarantees as the capture
 * sync: backoff on transient errors, terminal errors stop retrying, a row
 * edited mid-upload is sent again (detected by `updatedAt`), and a pull never
 * overwrites a row with changes still waiting to upload.
 */
import type { Table } from 'dexie'
import type { SpeciMapDB } from '../db/schema'
import { TerminalSyncError } from './engine'

export interface SyncedRow {
  updatedAt: string
  status: 'queued' | 'syncing' | 'synced' | 'error'
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

export interface RowSyncOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
}

export interface RowSyncSpec<T extends SyncedRow, R> {
  // The insert type varies by table (EntityTable), and only reads and updates happen here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: (db: SpeciMapDB) => Table<T, string, any>
  key: (row: T) => string
  remoteKey: (r: R) => string
  upsert: (row: T) => Promise<void>
  fetchAll: () => Promise<R[]>
  fromRemote: (r: R) => T
}

export class RowSyncRunner<T extends SyncedRow, R> {
  private running: Promise<void> | null = null

  constructor(
    protected db: SpeciMapDB,
    private spec: RowSyncSpec<T, R>,
    private opts: RowSyncOptions = {},
  ) {}

  private get table() {
    return this.spec.table(this.db)
  }

  kick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Send a failed row again. */
  async retry(key: string): Promise<void> {
    await this.table.update(key, { status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null } as never)
  }

  private async pass(): Promise<void> {
    const now = this.opts.now ?? Date.now
    await this.table.where('status').equals('syncing').modify({ status: 'queued' } as never)
    const due = await this.table
      .where('status')
      .equals('queued')
      .filter((r) => r.nextAttemptAt <= now())
      .toArray()
    for (const row of due) await this.syncOne(row)
  }

  private async syncOne(row: T): Promise<void> {
    const now = this.opts.now ?? Date.now
    const key = this.spec.key(row)
    await this.table.update(key, { status: 'syncing' } as never)
    try {
      await this.spec.upsert(row)
      await this.db.transaction('rw', this.table, async () => {
        const fresh = await this.table.get(key)
        if (!fresh) return
        const edited = fresh.updatedAt !== row.updatedAt
        await this.table.update(key, {
          status: edited ? 'queued' : 'synced',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        } as never)
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof TerminalSyncError) {
        await this.table.update(key, { status: 'error', lastError: message } as never)
        return
      }
      const attempts = row.attempts + 1
      const base = this.opts.baseDelayMs ?? 60_000
      const cap = this.opts.maxDelayMs ?? 3_600_000
      await this.table.update(key, {
        status: 'queued',
        attempts,
        nextAttemptAt: now() + Math.min(base * 2 ** (attempts - 1), cap),
        lastError: message,
      } as never)
    }
  }

  /** Adds rows from other devices; refreshes ones with nothing to upload. */
  async pull(): Promise<void> {
    const remote = await this.spec.fetchAll()
    await this.db.transaction('rw', this.table, async () => {
      const local = await this.table.bulkGet(remote.map(this.spec.remoteKey))
      await this.table.bulkPut(
        remote.filter((_, i) => !local[i] || local[i]!.status === 'synced').map(this.spec.fromRemote),
      )
    })
  }
}
