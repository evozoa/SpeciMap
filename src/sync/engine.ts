/**
 * Offline sync engine.
 *
 * A single-flight loop that walks queued records through ordered, idempotent
 * steps. Retrying any step can never duplicate data: specimen and photo rows
 * are upserted by client-generated UUIDs, and photo uploads overwrite a
 * deterministic storage path. A per-record step pointer means a failure at
 * photo upload resumes there, not from the start.
 *
 * The transport is injected so tests can drive the engine with fakes.
 */
import type { LocalPhoto, LocalRecord, SpeciMapDB, SyncStep } from '../db/schema'

export interface SyncTransport {
  /** Insert the tag if unknown (ON CONFLICT DO NOTHING semantics). */
  ensureTag(tagId: string): Promise<void>
  /** Upsert the specimen row by its client UUID. */
  upsertSpecimen(record: LocalRecord): Promise<void>
  /** Upload one photo blob to its deterministic path (upsert: true). */
  uploadPhoto(record: LocalRecord, photo: LocalPhoto): Promise<void>
  /** Upsert the photo metadata row by its client UUID. */
  upsertPhotoRow(record: LocalRecord, photo: LocalPhoto): Promise<void>
}

/** Errors the transport marks as terminal are surfaced, never retried. */
export class TerminalSyncError extends Error {}

export interface SyncOptions {
  /** Base backoff delay in ms (doubles per attempt). */
  baseDelayMs?: number
  /** Backoff cap in ms. */
  maxDelayMs?: number
  now?: () => number
}

export interface SyncSummary {
  synced: number
  retried: number
  failed: number
}

const STEP_ORDER: SyncStep[] = [
  'ensure-tag',
  'upsert-specimen',
  'upload-photos',
  'upsert-photo-rows',
  'done',
]

function nextStep(step: SyncStep): SyncStep {
  return STEP_ORDER[Math.min(STEP_ORDER.indexOf(step) + 1, STEP_ORDER.length - 1)]
}

export class SyncEngine {
  private running = false
  private rerunRequested = false
  private listeners = new Set<() => void>()

  constructor(
    private db: SpeciMapDB,
    private transport: SyncTransport,
    private opts: SyncOptions = {},
  ) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  /**
   * Kick the sync loop. Single-flight: concurrent kicks coalesce into one
   * extra pass after the current one finishes.
   */
  async kick(): Promise<SyncSummary> {
    if (this.running) {
      this.rerunRequested = true
      return { synced: 0, retried: 0, failed: 0 }
    }
    this.running = true
    try {
      let summary = await this.pass()
      while (this.rerunRequested) {
        this.rerunRequested = false
        const again = await this.pass()
        summary = {
          synced: summary.synced + again.synced,
          retried: summary.retried + again.retried,
          failed: summary.failed + again.failed,
        }
      }
      return summary
    } finally {
      this.running = false
    }
  }

  private async pass(): Promise<SyncSummary> {
    const now = this.opts.now ?? Date.now
    const summary: SyncSummary = { synced: 0, retried: 0, failed: 0 }
    const due = await this.db.records
      .where('status')
      .anyOf('queued', 'error')
      .filter((r) => r.status === 'queued' && r.nextAttemptAt <= now())
      .toArray()

    for (const record of due) {
      const result = await this.syncOne(record)
      summary[result]++
      this.emit()
    }
    return summary
  }

  private async syncOne(record: LocalRecord): Promise<keyof SyncSummary> {
    const now = this.opts.now ?? Date.now
    await this.db.records.update(record.id, { status: 'syncing' })
    let step = record.syncStep
    try {
      while (step !== 'done') {
        await this.runStep(record, step)
        step = nextStep(step)
        await this.db.records.update(record.id, { syncStep: step })
      }
      await this.db.records.update(record.id, {
        status: 'synced',
        lastError: null,
      })
      return 'synced'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof TerminalSyncError) {
        await this.db.records.update(record.id, {
          status: 'error',
          syncStep: step,
          lastError: message,
        })
        return 'failed'
      }
      const attempts = record.attempts + 1
      const base = this.opts.baseDelayMs ?? 60_000
      const cap = this.opts.maxDelayMs ?? 3_600_000
      const delay = Math.min(base * 2 ** (attempts - 1), cap)
      await this.db.records.update(record.id, {
        status: 'queued',
        syncStep: step,
        attempts,
        nextAttemptAt: now() + delay,
        lastError: message,
      })
      return 'retried'
    }
  }

  private async runStep(record: LocalRecord, step: SyncStep): Promise<void> {
    switch (step) {
      case 'ensure-tag':
        await this.transport.ensureTag(record.tagId)
        return
      case 'upsert-specimen':
        await this.transport.upsertSpecimen(record)
        return
      case 'upload-photos': {
        const photos = await this.db.photos
          .where('recordId')
          .equals(record.id)
          .toArray()
        for (const photo of photos) {
          if (photo.uploaded) continue
          await this.transport.uploadPhoto(record, photo)
          await this.db.photos.update(photo.id, { uploaded: 1 })
        }
        return
      }
      case 'upsert-photo-rows': {
        const photos = await this.db.photos
          .where('recordId')
          .equals(record.id)
          .toArray()
        for (const photo of photos) {
          await this.transport.upsertPhotoRow(record, photo)
        }
        return
      }
      case 'done':
        return
    }
  }

  /** Requeue a terminally-failed record after the user addresses the cause. */
  async retryRecord(id: string): Promise<void> {
    await this.db.records.update(id, {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    })
  }
}
