/**
 * Uploads subsamples and pulls ones made on the collector's other devices.
 * Same guarantees as the event sync: idempotent upserts keyed by tag, backoff,
 * and a subsample edited mid-upload is sent again.
 */
import type { LocalSubsample, SpeciMapDB } from '../db/schema'
import { TerminalSyncError } from '../sync/engine'

export interface RemoteSubsample {
  tag_id: string
  parent_tag_id: string
  created_by: string
  event_id: string | null
  sample_type: string | null
  preservation: string | null
  remarks: string | null
  collected_at: string
  updated_at: string
}

export interface SubsampleTransport {
  /** Upload one subsample (registering its tags and event first). */
  upsert(s: LocalSubsample): Promise<void>
  fetchAll(): Promise<RemoteSubsample[]>
}

export function subsampleRow(s: LocalSubsample): RemoteSubsample {
  const t = (v: string) => v.trim() || null
  return {
    tag_id: s.tagId,
    parent_tag_id: s.parentTagId,
    created_by: s.createdBy,
    event_id: s.eventId,
    sample_type: t(s.sampleType),
    preservation: t(s.preservation),
    remarks: t(s.remarks),
    collected_at: s.collectedAt,
    updated_at: s.updatedAt,
  }
}

export function fromRemote(r: RemoteSubsample): LocalSubsample {
  return {
    tagId: r.tag_id,
    parentTagId: r.parent_tag_id,
    createdBy: r.created_by,
    eventId: r.event_id,
    sampleType: r.sample_type ?? '',
    preservation: r.preservation ?? '',
    remarks: r.remarks ?? '',
    collectedAt: new Date(r.collected_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    status: 'synced',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }
}

export interface SubsampleSyncOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
}

export class SubsampleSyncRunner {
  private running: Promise<void> | null = null

  constructor(
    private db: SpeciMapDB,
    private transport: SubsampleTransport,
    private opts: SubsampleSyncOptions = {},
  ) {}

  kick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Send a failed subsample again. */
  async retry(tagId: string): Promise<void> {
    await this.db.subsamples.update(tagId, { status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null })
  }

  private async pass(): Promise<void> {
    const now = this.opts.now ?? Date.now
    await this.db.subsamples.where('status').equals('syncing').modify({ status: 'queued' })
    const due = await this.db.subsamples
      .where('status')
      .equals('queued')
      .filter((s) => s.nextAttemptAt <= now())
      .toArray()
    for (const s of due) await this.syncOne(s)
  }

  private async syncOne(s: LocalSubsample): Promise<void> {
    const now = this.opts.now ?? Date.now
    await this.db.subsamples.update(s.tagId, { status: 'syncing' })
    try {
      await this.transport.upsert(s)
      await this.db.transaction('rw', this.db.subsamples, async () => {
        const fresh = await this.db.subsamples.get(s.tagId)
        if (!fresh) return
        const edited = fresh.updatedAt !== s.updatedAt
        await this.db.subsamples.update(s.tagId, {
          status: edited ? 'queued' : 'synced',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof TerminalSyncError) {
        await this.db.subsamples.update(s.tagId, { status: 'error', lastError: message })
        return
      }
      const attempts = s.attempts + 1
      const base = this.opts.baseDelayMs ?? 60_000
      const cap = this.opts.maxDelayMs ?? 3_600_000
      await this.db.subsamples.update(s.tagId, {
        status: 'queued',
        attempts,
        nextAttemptAt: now() + Math.min(base * 2 ** (attempts - 1), cap),
        lastError: message,
      })
    }
  }

  /** Adds subsamples from other devices; refreshes ones with nothing to upload. */
  async pull(): Promise<void> {
    const remote = await this.transport.fetchAll()
    await this.db.transaction('rw', this.db.subsamples, async () => {
      const local = await this.db.subsamples.bulkGet(remote.map((r) => r.tag_id))
      await this.db.subsamples.bulkPut(
        remote.filter((_, i) => !local[i] || local[i]!.status === 'synced').map(fromRemote),
      )
    })
  }
}
