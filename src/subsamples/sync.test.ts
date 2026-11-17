import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SpeciMapDB, type LocalSubsample } from '../db/schema'
import { TerminalSyncError } from '../sync/engine'
import { createSubsample, updateSubsample } from './store'
import { SubsampleSyncRunner, fromRemote, subsampleRow, type SubsampleTransport } from './sync'

let n = 0
const fresh = () => new SpeciMapDB(`subsync-${++n}`)
const base = { tagId: 'TUBE00001', parentTagId: 'SPEC00001', createdBy: 'me', eventId: null, sampleType: 'Fin clip', preservation: '', remarks: '' }

function transport(): SubsampleTransport & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  return {
    rows,
    upsert: vi.fn(async (s: LocalSubsample) => void rows.set(s.tagId, subsampleRow(s))),
    fetchAll: vi.fn(async () => []),
  }
}

describe('SubsampleSyncRunner', () => {
  it('uploads once and maps blanks to null', async () => {
    const db = fresh()
    await createSubsample(base, db)
    const t = transport()
    const runner = new SubsampleSyncRunner(db, t)
    await runner.kick()
    await runner.kick()
    expect(t.upsert).toHaveBeenCalledTimes(1)
    expect((await db.subsamples.get('TUBE00001'))?.status).toBe('synced')
    expect(t.rows.get('TUBE00001')).toMatchObject({ parent_tag_id: 'SPEC00001', sample_type: 'Fin clip', preservation: null })
  })

  it('re-sends an edit made during upload', async () => {
    const db = fresh()
    await createSubsample(base, db)
    const t = transport()
    let started!: () => void
    let finish!: () => void
    const uploading = new Promise<void>((r) => (started = r))
    t.upsert = vi.fn(async () => {
      started()
      await new Promise<void>((r) => (finish = r))
    })
    const runner = new SubsampleSyncRunner(db, t)
    const pass = runner.kick()
    await uploading
    await new Promise((r) => setTimeout(r, 2)) // a later timestamp than the upload's copy
    await updateSubsample('TUBE00001', { remarks: 'edited' }, db)
    finish()
    await pass
    expect((await db.subsamples.get('TUBE00001'))?.status).toBe('queued')
  })

  it('backs off on transient errors and stops on terminal ones', async () => {
    const db = fresh()
    await createSubsample(base, db)
    const t = transport()
    t.upsert = vi.fn(async () => {
      throw new Error('offline')
    })
    const runner = new SubsampleSyncRunner(db, t, { now: () => 1000, baseDelayMs: 100 })
    await runner.kick()
    expect(await db.subsamples.get('TUBE00001')).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: 1100 })
    t.upsert = vi.fn(async () => {
      throw new TerminalSyncError('23503: foreign key')
    })
    await db.subsamples.update('TUBE00001', { nextAttemptAt: 0 })
    await runner.kick()
    expect(await db.subsamples.get('TUBE00001')).toMatchObject({ status: 'error' })
  })

  it('pulls subsamples from other devices without overwriting pending edits', async () => {
    const db = fresh()
    await createSubsample(base, db)
    const remote = [
      { ...subsampleRow({ ...(await db.subsamples.get('TUBE00001'))!, remarks: 'server' }) },
      { ...subsampleRow({ ...(await db.subsamples.get('TUBE00001'))!, tagId: 'TUBE00002' }) },
    ]
    const t = transport()
    t.fetchAll = vi.fn(async () => remote)
    await new SubsampleSyncRunner(db, t).pull()
    expect((await db.subsamples.get('TUBE00001'))?.remarks).toBe('') // local edit pending
    expect(await db.subsamples.get('TUBE00002')).toMatchObject({ status: 'synced', parentTagId: 'SPEC00001' })
    expect(fromRemote(remote[1]).tagId).toBe('TUBE00002')
  })
})
