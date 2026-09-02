/**
 * Wires the sync engine to its trigger events. Foreground triggers are the
 * baseline (iOS has no Background Sync API); the Background Sync
 * registration in the service worker is a Chromium-only bonus.
 */
import { db } from '../db/schema'
import { SyncEngine } from './engine'
import { supabaseTransport } from './supabaseTransport'

export const syncEngine = new SyncEngine(db, supabaseTransport)

let wired = false

export function wireSyncTriggers(): void {
  if (wired) return
  wired = true

  const kick = () => {
    if (navigator.onLine) void syncEngine.kick()
  }

  window.addEventListener('online', kick)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick()
  })
  // App start.
  kick()
}
