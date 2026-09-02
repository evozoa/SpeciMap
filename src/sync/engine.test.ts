import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SpeciMapDB, type LocalRecord } from '../db/schema'
import { SyncEngine, TerminalSyncError, type SyncTransport } from './engine'

let dbCounter = 0

function makeDb(): SpeciMapDB {
  return new SpeciMapDB(`test-${++dbCounter}`)
}

function makeRecord(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId: '7Q4MK2XRC',
    collectorId: 'user-1',
    lat: 1.23,
    lng: 4.56,
    gpsAccuracyM: 8,
    locationAdjusted: false,
    capturedAt: new Date().toISOString(),
    notes: '',
    focusScore: null,
    status: 'queued',
    syncStep: 'ensure-tag',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    ...overrides,
  }
}

interface CallLog {
  ensureTag: string[]
  upsertSpecimen: string[]
  uploadPhoto: string[]
  upsertPhotoRow: string[]
}

function makeTransport(
  failures: Partial<Record<keyof CallLog, () => Error | null>> = {},
): { transport: SyncTransport; calls: CallLog } {
  const calls: CallLog = {
    ensureTag: [],
    upsertSpecimen: [],
    uploadPhoto: [],
    upsertPhotoRow: [],
  }
  const maybeFail = (key: keyof CallLog) => {
    const err = failures[key]?.()
    if (err) throw err
  }
  const transport: SyncTransport = {
    async ensureTag(tagId) {
      calls.ensureTag.push(tagId)
      maybeFail('ensureTag')
    },
    async upsertSpecimen(r) {
      calls.upsertSpecimen.push(r.id)
      maybeFail('upsertSpecimen')
    },
    async uploadPhoto(_r, p) {
      calls.uploadPhoto.push(p.id)
      maybeFail('uploadPhoto')
    },
    async upsertPhotoRow(_r, p) {
      calls.upsertPhotoRow.push(p.id)
      maybeFail('upsertPhotoRow')
    },
  }
  return { transport, calls }
}

async function addPhoto(db: SpeciMapDB, recordId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.photos.add({
    id,
    recordId,
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    width: 10,
    height: 10,
    bytes: 1,
    uploaded: 0,
  })
  return id
}

describe('SyncEngine', () => {
  let db: SpeciMapDB

  beforeEach(() => {
    db = makeDb()
  })

  it('syncs a queued record through all steps', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const photoId = await addPhoto(db, record.id)

    const { transport, calls } = makeTransport()
    const engine = new SyncEngine(db, transport)
    const summary = await engine.kick()

    expect(summary).toEqual({ synced: 1, retried: 0, failed: 0 })
    expect(calls.ensureTag).toEqual([record.tagId])
    expect(calls.upsertSpecimen).toEqual([record.id])
    expect(calls.uploadPhoto).toEqual([photoId])
    expect(calls.upsertPhotoRow).toEqual([photoId])
    const stored = await db.records.get(record.id)
    expect(stored?.status).toBe('synced')
    expect(stored?.syncStep).toBe('done')
    expect((await db.photos.get(photoId))?.uploaded).toBe(1)
  })

  it('retries with backoff on transient failure and resumes at the failed step', async () => {
    const record = makeRecord()
    await db.records.add(record)
    await addPhoto(db, record.id)

    let failuresLeft = 1
    const { transport, calls } = makeTransport({
      uploadPhoto: () => (failuresLeft-- > 0 ? new Error('network down') : null),
    })
    let clock = 1_000_000
    const engine = new SyncEngine(db, transport, {
      baseDelayMs: 100,
      now: () => clock,
    })

    const first = await engine.kick()
    expect(first).toEqual({ synced: 0, retried: 1, failed: 0 })
    let stored = await db.records.get(record.id)
    expect(stored?.status).toBe('queued')
    expect(stored?.syncStep).toBe('upload-photos')
    expect(stored?.nextAttemptAt).toBe(clock + 100)
    expect(stored?.lastError).toContain('network down')

    // Not due yet: nothing happens.
    const early = await engine.kick()
    expect(early).toEqual({ synced: 0, retried: 0, failed: 0 })

    // Advance past backoff: resumes at upload-photos, does NOT redo earlier steps.
    clock += 101
    const second = await engine.kick()
    expect(second).toEqual({ synced: 1, retried: 0, failed: 0 })
    expect(calls.ensureTag).toHaveLength(1)
    expect(calls.upsertSpecimen).toHaveLength(1)
    expect(calls.uploadPhoto).toHaveLength(2)
    stored = await db.records.get(record.id)
    expect(stored?.status).toBe('synced')
  })

  it('doubles backoff per attempt up to the cap', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const { transport } = makeTransport({
      ensureTag: () => new Error('offline'),
    })
    let clock = 0
    const engine = new SyncEngine(db, transport, {
      baseDelayMs: 100,
      maxDelayMs: 250,
      now: () => clock,
    })

    const delays: number[] = []
    for (let i = 0; i < 4; i++) {
      await engine.kick()
      const stored = await db.records.get(record.id)
      delays.push(stored!.nextAttemptAt - clock)
      clock = stored!.nextAttemptAt + 1
    }
    expect(delays).toEqual([100, 200, 250, 250])
  })

  it('marks terminal errors as needs-attention and never retries them', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const { transport, calls } = makeTransport({
      upsertSpecimen: () => new TerminalSyncError('RLS denied'),
    })
    const engine = new SyncEngine(db, transport)

    const summary = await engine.kick()
    expect(summary).toEqual({ synced: 0, retried: 0, failed: 1 })
    const stored = await db.records.get(record.id)
    expect(stored?.status).toBe('error')
    expect(stored?.lastError).toBe('RLS denied')

    // Subsequent passes skip errored records entirely.
    await engine.kick()
    expect(calls.upsertSpecimen).toHaveLength(1)

    // Until the user explicitly retries.
    await engine.retryRecord(record.id)
    await engine.kick()
    expect(calls.upsertSpecimen).toHaveLength(2)
  })

  it('is idempotent: re-running a synced queue makes no transport calls', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const { transport, calls } = makeTransport()
    const engine = new SyncEngine(db, transport)
    await engine.kick()
    await engine.kick()
    await engine.kick()
    expect(calls.ensureTag).toHaveLength(1)
    expect(calls.upsertSpecimen).toHaveLength(1)
  })

  it('skips already-uploaded photos when resuming', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const p1 = await addPhoto(db, record.id)
    const p2 = await addPhoto(db, record.id)

    let call = 0
    const { transport, calls } = makeTransport({
      // Fail whichever photo is attempted second, on its first attempt only.
      uploadPhoto: () => (++call === 2 ? new Error('flaky') : null),
    })
    let clock = 0
    const engine = new SyncEngine(db, transport, {
      baseDelayMs: 10,
      now: () => clock,
    })

    await engine.kick()
    clock += 11
    await engine.kick()

    // Three calls total: the photo uploaded before the failure is marked
    // uploaded and never re-sent; only the failed one is retried. (Dexie
    // returns photos in UUID order, so which of p1/p2 fails is arbitrary.)
    expect(calls.uploadPhoto).toHaveLength(3)
    const attempts = (id: string) => calls.uploadPhoto.filter((x) => x === id).length
    expect([attempts(p1), attempts(p2)].sort()).toEqual([1, 2])
    expect((await db.records.get(record.id))?.status).toBe('synced')
  })

  it('coalesces concurrent kicks (single-flight)', async () => {
    const record = makeRecord()
    await db.records.add(record)
    const { transport, calls } = makeTransport()
    const engine = new SyncEngine(db, transport)
    await Promise.all([engine.kick(), engine.kick(), engine.kick()])
    expect(calls.upsertSpecimen).toHaveLength(1)
  })
})
