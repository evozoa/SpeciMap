/** Box and placement upload rows and their runners (see ../sync/rows.ts). */
import type { Custody, LocalBox, LocalPlacement, SpeciMapDB } from '../db/schema'
import { custodyFrom } from '../specimens/store'
import { RowSyncRunner, type RowSyncOptions } from '../sync/rows'

export interface RemoteBox {
  tag_id: string
  size: LocalBox['size']
  label: string | null
  capacity: number
  created_by: string
  updated_at: string
  custodian_user?: string | null
  custodian_org?: string | null
  visibility?: Custody['visibility']
  generalize_public?: boolean
}

export interface RemotePlacement {
  item_tag: string
  box_tag: string
  position: string
  placed_by: string
  placed_at: string
  updated_at: string
}

export interface BoxTransport {
  upsertBox(b: LocalBox): Promise<void>
  fetchBoxes(): Promise<RemoteBox[]>
  /** Upload a placement, or delete it if removed. */
  upsertPlacement(p: LocalPlacement): Promise<void>
  fetchPlacements(): Promise<RemotePlacement[]>
}

export const boxRow = (b: LocalBox) => ({
  tag_id: b.tagId,
  size: b.size,
  label: b.label.trim() || null,
  capacity: b.capacity,
  created_by: b.createdBy,
  updated_at: b.updatedAt,
})

export const placementRow = (p: LocalPlacement): RemotePlacement => ({
  item_tag: p.itemTagId,
  box_tag: p.boxTagId,
  position: p.position,
  placed_by: p.placedBy,
  placed_at: p.placedAt,
  updated_at: p.updatedAt,
})

const synced = { status: 'synced' as const, attempts: 0, nextAttemptAt: 0, lastError: null }

export function boxFromRemote(r: RemoteBox): LocalBox {
  return {
    tagId: r.tag_id,
    size: r.size,
    label: r.label ?? '',
    capacity: r.capacity,
    createdBy: r.created_by,
    custody: custodyFrom({ ...r, catalog_number: null }),
    updatedAt: new Date(r.updated_at).toISOString(),
    ...synced,
  }
}

export function placementFromRemote(r: RemotePlacement): LocalPlacement {
  return {
    itemTagId: r.item_tag,
    boxTagId: r.box_tag,
    position: r.position,
    placedBy: r.placed_by,
    placedAt: new Date(r.placed_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    ...synced,
  }
}

export class BoxSyncRunner extends RowSyncRunner<LocalBox, RemoteBox> {
  constructor(db: SpeciMapDB, t: BoxTransport, opts: RowSyncOptions = {}) {
    super(db, { table: (d) => d.boxes, key: (b) => b.tagId, remoteKey: (r) => r.tag_id, upsert: (b) => t.upsertBox(b), fetchAll: () => t.fetchBoxes(), fromRemote: boxFromRemote }, opts)
  }
}

export class PlacementSyncRunner extends RowSyncRunner<LocalPlacement, RemotePlacement> {
  constructor(db: SpeciMapDB, t: BoxTransport, opts: RowSyncOptions = {}) {
    super(
      db,
      {
        table: (d) => d.placements,
        key: (p) => p.itemTagId,
        remoteKey: (r) => r.item_tag,
        upsert: (p) => t.upsertPlacement(p),
        fetchAll: () => t.fetchPlacements(),
        fromRemote: placementFromRemote,
      },
      opts,
    )
  }
}
