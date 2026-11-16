/**
 * Sharing records to iNaturalist (optional, per record).
 *
 * Works like the Supabase sync engine: a share request is stored on the
 * record (offline is fine) and a single-flight runner sends queued shares
 * when online. Each share is resumable and never duplicates:
 *   1. find-or-create the observation, keyed by a client-generated UUID
 *      (a retry after an ambiguous failure finds the first attempt's);
 *   2. attach each photo once (sent photo ids are stored on the record);
 *   3. store the observation id, and requeue the record's Supabase sync so
 *      every device of the collector shows it as shared.
 */
import { db, type InatShare, type LocalPhoto, type LocalRecord, type SpeciMapDB } from '../db/schema'
import { serverEdit } from '../db/drafts'
import { formatTagId } from '../lib/tagid'
import { PHOTO_BUCKET, supabase } from '../lib/supabase'
import { INAT_API, InatAuthError, getInatJwt } from './auth'

export interface NewObservation {
  uuid: string
  species_guess?: string
  taxon_id?: number
  observed_on_string: string
  latitude: number
  longitude: number
  positional_accuracy?: number
  geoprivacy: InatShare['geoprivacy']
  description: string
  tag_list: string
}

/** The iNaturalist calls the runner needs; injected so tests can fake them. */
export interface InatClient {
  findObservationByUuid(uuid: string): Promise<number | null>
  matchTaxon(name: string): Promise<number | null>
  createObservation(obs: NewObservation): Promise<number>
  addPhoto(observationId: number, photo: Blob, filename: string): Promise<void>
  photoBlob(photo: LocalPhoto): Promise<Blob>
}

/** A failure that retrying won't fix (shown to the collector). */
export class InatTerminalError extends Error {}

export function observationDescription(record: LocalRecord): string {
  const parts = [record.notes.trim(), `SpeciMap tag ${formatTagId(record.tagId)}`]
  return parts.filter(Boolean).join('\n\n')
}

export function observationFor(record: LocalRecord, taxonId: number | null): NewObservation {
  const share = record.inat!
  const species = record.species?.trim()
  return {
    uuid: share.uuid,
    ...(species ? { species_guess: species } : {}),
    ...(taxonId ? { taxon_id: taxonId } : {}),
    observed_on_string: record.capturedAt,
    latitude: record.lat,
    longitude: record.lng,
    ...(record.gpsAccuracyM != null
      ? { positional_accuracy: Math.max(1, Math.round(record.gpsAccuracyM)) }
      : {}),
    geoprivacy: share.geoprivacy,
    description: observationDescription(record),
    tag_list: 'SpeciMap',
  }
}

export interface ShareOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
}

export class InatShareRunner {
  private running = false
  private rerun = false

  constructor(
    private db: SpeciMapDB,
    private client: InatClient,
    private opts: ShareOptions = {},
  ) {}

  async kick(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return
    }
    this.running = true
    try {
      do {
        this.rerun = false
        await this.pass()
      } while (this.rerun)
    } finally {
      this.running = false
    }
  }

  private async pass(): Promise<void> {
    const now = this.opts.now ?? Date.now
    const due = await this.db.records
      .filter(
        (r) =>
          !!r.inat &&
          (r.inat.status === 'queued' || r.inat.status === 'sharing') &&
          r.inat.nextAttemptAt <= now(),
      )
      .toArray()
    for (const record of due) {
      const stop = await this.shareOne(record)
      if (stop) return // signed out of iNaturalist: no point trying the rest
    }
  }

  private async patch(id: string, changes: Partial<InatShare>): Promise<InatShare | undefined> {
    return this.db.transaction('rw', this.db.records, async () => {
      const r = await this.db.records.get(id)
      if (!r?.inat) return undefined
      const inat = { ...r.inat, ...changes }
      const extra =
        changes.observationId !== undefined && changes.observationId !== r.inat.observationId
          ? serverEdit(r, {})
          : {}
      await this.db.records.update(id, { ...extra, inat })
      return inat
    })
  }

  /** Returns true when the runner should stop (iNaturalist sign-in lost). */
  private async shareOne(record: LocalRecord): Promise<boolean> {
    const now = this.opts.now ?? Date.now
    let share = await this.patch(record.id, { status: 'sharing' })
    if (!share) return false
    try {
      let observationId = share.observationId
      if (!observationId) {
        observationId = await this.client.findObservationByUuid(share.uuid)
      }
      if (!observationId) {
        const species = record.species?.trim()
        const taxonId =
          record.taxon?.id ?? (species ? await this.client.matchTaxon(species) : null)
        observationId = await this.client.createObservation(
          observationFor({ ...record, inat: share }, taxonId),
        )
      }
      share = (await this.patch(record.id, { observationId }))!

      const photos = await this.db.photos.where('recordId').equals(record.id).toArray()
      for (const photo of photos) {
        if (share.sharedPhotoIds.includes(photo.id)) continue
        const blob = await this.client.photoBlob(photo)
        await this.client.addPhoto(observationId, blob, `${photo.id}.jpg`)
        share = (await this.patch(record.id, {
          sharedPhotoIds: [...share.sharedPhotoIds, photo.id],
        }))!
      }

      // A rescan may have added photos while this ran; the next pass sends them.
      const fresh = await this.db.photos.where('recordId').equals(record.id).count()
      const done = fresh <= share.sharedPhotoIds.length
      await this.patch(record.id, {
        status: done ? 'shared' : 'queued',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      })
      if (!done) this.rerun = true
      return false
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof InatAuthError || err instanceof InatTerminalError) {
        await this.patch(record.id, { status: 'error', lastError: message })
        return err instanceof InatAuthError
      }
      const attempts = (share?.attempts ?? 0) + 1
      const base = this.opts.baseDelayMs ?? 60_000
      const cap = this.opts.maxDelayMs ?? 3_600_000
      await this.patch(record.id, {
        status: 'queued',
        attempts,
        nextAttemptAt: now() + Math.min(base * 2 ** (attempts - 1), cap),
        lastError: message,
      })
      return false
    }
  }
}

// ---- The real iNaturalist client --------------------------------------

async function inatFetch(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const jwt = await getInatJwt(retried)
  const res = await fetch(`${INAT_API}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: jwt, Accept: 'application/json' },
  })
  if (res.status === 401 && !retried) return inatFetch(path, init, true)
  if (res.status === 401 || res.status === 403) {
    throw new InatAuthError('iNaturalist refused the request; reconnect in Settings')
  }
  if (res.status === 422 || res.status === 400) {
    throw new InatTerminalError(`iNaturalist rejected the observation: ${await res.text()}`)
  }
  if (!res.ok) throw new Error(`iNaturalist error ${res.status}`)
  return res
}

function firstId(body: unknown): number | null {
  const obj = Array.isArray(body) ? body[0] : body
  const results = (obj as { results?: { id: number }[] })?.results
  const id = results ? results[0]?.id : (obj as { id?: number })?.id
  return typeof id === 'number' ? id : null
}

export const inatClient: InatClient = {
  async findObservationByUuid(uuid) {
    const res = await inatFetch(`/observations?uuid=${encodeURIComponent(uuid)}&per_page=1`)
    return firstId(await res.json())
  },

  async matchTaxon(name) {
    const res = await inatFetch(
      `/taxa/autocomplete?q=${encodeURIComponent(name)}&per_page=10&is_active=true`,
    )
    const { results } = (await res.json()) as { results: { id: number; name: string }[] }
    const want = name.trim().toLowerCase()
    return results.find((t) => t.name.toLowerCase() === want)?.id ?? null
  },

  async createObservation(obs) {
    const res = await inatFetch('/observations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observation: obs }),
    })
    const id = firstId(await res.json())
    if (!id) throw new Error('iNaturalist did not return an observation id')
    return id
  },

  async addPhoto(observationId, photo, filename) {
    const form = new FormData()
    form.append('observation_photo[observation_id]', String(observationId))
    form.append('file', photo, filename)
    await inatFetch('/observation_photos', { method: 'POST', body: form })
  },

  async photoBlob(photo) {
    if (photo.blob) return photo.blob
    if (!photo.storagePath) throw new InatTerminalError('Photo is missing')
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .download(photo.storagePath)
    if (error || !data) throw new Error(error?.message ?? 'Photo download failed')
    return data
  },
}

export const inatShareRunner = new InatShareRunner(db, inatClient)
