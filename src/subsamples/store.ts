/**
 * Subsamples (dwc:MaterialSample), e.g. a fin clip in a 2 mL tube, linked to
 * the specimen they were taken from. Local-first like everything else: made
 * offline, uploaded by the subsample sync runner (./sync.ts).
 */
import { db as defaultDb, type LocalSubsample, type SpeciMapDB } from '../db/schema'

/** Common choices, offered as suggestions; any text is allowed. */
export const SAMPLE_TYPES = ['Fin clip', 'Muscle', 'Liver', 'Gill', 'Whole body', 'Scales', 'Otolith']
export const PRESERVATIONS = ['95% ethanol', 'RNAlater', 'Frozen −80 °C', 'Dry', 'DMSO buffer']

export interface NewSubsample {
  tagId: string
  parentTagId: string
  createdBy: string
  eventId: string | null
  sampleType: string
  preservation: string
  remarks: string
}

export async function createSubsample(input: NewSubsample, db: SpeciMapDB = defaultDb, now = new Date()) {
  const tagId = input.tagId
  const parent = input.parentTagId
  if (tagId === parent) throw new Error('A tag cannot be a subsample of itself')
  await db.transaction('rw', db.subsamples, db.events, db.records, async () => {
    if (await db.subsamples.get(tagId)) throw new Error('This tag is already a subsample')
    if (await db.events.get(tagId)) throw new Error('This tag is already a collecting event')
    const captures = await db.records.where('tagId').equals(tagId).toArray()
    if (captures.some((r) => r.status !== 'draft')) throw new Error('This tag is already a specimen')
    if (await db.subsamples.get(parent)) throw new Error('The parent is a subsample, not a specimen')
    if (await db.events.get(parent)) throw new Error('The parent is a collecting event, not a specimen')
    const row: LocalSubsample = {
      tagId,
      parentTagId: parent,
      createdBy: input.createdBy,
      eventId: input.eventId,
      sampleType: input.sampleType.trim(),
      preservation: input.preservation.trim(),
      remarks: input.remarks.trim(),
      collectedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    }
    await db.subsamples.add(row)
  })
}

type Editable = Pick<LocalSubsample, 'sampleType' | 'preservation' | 'remarks'>

export async function updateSubsample(tagId: string, changes: Partial<Editable>, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.subsamples, async () => {
    const s = await db.subsamples.get(tagId)
    if (!s) throw new Error('Subsample no longer exists')
    await db.subsamples.update(tagId, {
      ...changes,
      updatedAt: new Date().toISOString(),
      ...(s.status === 'syncing' ? {} : { status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null }),
    })
  })
}

/** "Fin clip, 95% ethanol" */
export function describeSubsample(s: Pick<LocalSubsample, 'sampleType' | 'preservation'>): string {
  return [s.sampleType, s.preservation].filter(Boolean).join(', ') || 'Subsample'
}
