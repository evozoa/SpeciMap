/**
 * Wires the sync engine to its trigger events. Foreground triggers are the
 * baseline (iOS has no Background Sync API); the Background Sync
 * registration in the service worker is a Chromium-only bonus.
 */
import { db } from '../db/schema'
import { supabase } from '../lib/supabase'
import { SyncEngine } from './engine'
import { mergeRemote } from './pull'
import {
  eventTransport,
  fetchRemoteSpecimens,
  specimenTransport,
  scanTransport,
  subsampleTransport,
  supabaseTransport,
} from './supabaseTransport'
import { EventSyncRunner } from '../events/sync'
import { SubsampleSyncRunner } from '../subsamples/sync'
import { ScanSyncRunner } from '../scans/sync'
import { pullSpecimens, pushSpecimens } from '../specimens/store'
import { inatShareRunner } from '../inat/share'
import { taxonResolver } from '../taxa/resolver'

export const syncEngine = new SyncEngine(db, supabaseTransport)
export const eventSync = new EventSyncRunner(db, eventTransport)
export const subsampleSync = new SubsampleSyncRunner(db, subsampleTransport)
export const scanSync = new ScanSyncRunner(db, scanTransport)

/** Push queued records, then pull records captured on other devices. */
export async function syncAll(): Promise<void> {
  try {
    await eventSync.kick()
  } catch (err) {
    console.warn('Event sync failed', err)
  }
  await syncEngine.kick()
  const { data } = await supabase.auth.getSession()
  if (!data.session) return
  try {
    const syncedBeforeFetch = new Set(
      await db.records.where('status').equals('synced').primaryKeys(),
    )
    await mergeRemote(db, await fetchRemoteSpecimens(), {
      collectorId: data.session.user.id,
      syncedBeforeFetch,
    })
  } catch (err) {
    console.warn('Pulling remote records failed', err)
  }
  try {
    await eventSync.pull()
  } catch (err) {
    console.warn('Pulling events failed', err)
  }
  // Subsamples, after the captures of their parent specimens.
  try {
    await subsampleSync.kick()
    await subsampleSync.pull()
  } catch (err) {
    console.warn('Subsample sync failed', err)
  }
  try {
    await scanSync.kick()
    await scanSync.pull()
  } catch (err) {
    console.warn('Location check sync failed', err)
  }
  // Specimen-level fields (individual count, reviews), after the captures
  // that create their server rows.
  try {
    await pushSpecimens(specimenTransport)
    await pullSpecimens(specimenTransport)
  } catch (err) {
    console.warn('Specimen sync failed', err)
  }
  // Then the iNaturalist extras, after the records themselves are safe:
  // check unverified species names, and send optional shares.
  try {
    await taxonResolver.kick()
    await inatShareRunner.kick()
    await syncEngine.kick() // store any new observation ids on the server
  } catch (err) {
    console.warn('iNaturalist sharing failed', err)
  }
}

let wired = false

export function wireSyncTriggers(): void {
  if (wired) return
  wired = true

  const kick = () => {
    if (navigator.onLine) void syncAll()
  }

  window.addEventListener('online', kick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick()
  })
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') kick()
  })
  // App start.
  kick()
}
