/**
 * Subsample upload rows and the runner that syncs them (see ../sync/rows.ts).
 */
import type { LocalSubsample, SpeciMapDB } from '../db/schema'
import { RowSyncRunner, type RowSyncOptions } from '../sync/rows'

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

export type SubsampleSyncOptions = RowSyncOptions

/** Uploads subsamples; pulls ones made on the collector's other devices. */
export class SubsampleSyncRunner extends RowSyncRunner<LocalSubsample, RemoteSubsample> {
  constructor(db: SpeciMapDB, transport: SubsampleTransport, opts: SubsampleSyncOptions = {}) {
    super(
      db,
      {
        table: (d) => d.subsamples,
        key: (s) => s.tagId,
        remoteKey: (r) => r.tag_id,
        upsert: (s) => transport.upsert(s),
        fetchAll: () => transport.fetchAll(),
        fromRemote,
      },
      opts,
    )
  }
}
