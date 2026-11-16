import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'
import InatSettings from '../inat/InatSettings'
import { setPrefs, usePrefs } from '../lib/prefs'

function CollectorSettings() {
  const { recordedBy } = usePrefs('exportPrefs')
  const { fieldNumberPrefix } = usePrefs('collectorPrefs')
  const yy = String(new Date().getFullYear()).slice(-2)
  return (
    <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="font-semibold">Collector</h2>
      <label className="flex flex-col gap-1">
        Name <span className="text-xs text-slate-500">recordedBy on your events and exports</span>
        <input
          value={recordedBy}
          onChange={(e) => void setPrefs('exportPrefs', { recordedBy: e.target.value })}
          placeholder="Name as it should appear on records"
          className="rounded bg-slate-800 px-3 py-2"
        />
      </label>
      <label className="flex flex-col gap-1">
        Field number prefix{' '}
        <span className="text-xs text-slate-500">
          New events are numbered {fieldNumberPrefix.trim() ? `${fieldNumberPrefix.trim()} ` : ''}
          {yy}-001, {yy}-002…
        </span>
        <input
          value={fieldNumberPrefix}
          onChange={(e) => void setPrefs('collectorPrefs', { fieldNumberPrefix: e.target.value.toUpperCase().slice(0, 8) })}
          placeholder="Your initials"
          className="rounded bg-slate-800 px-3 py-2 font-mono"
        />
      </label>
    </section>
  )
}

function VoucherSettings() {
  const { fullRes } = usePrefs('capturePrefs')
  return (
    <section className="rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="font-semibold">Photo vouchers</h2>
      <label className="mt-2 flex items-start gap-3">
        <input
          type="checkbox"
          checked={fullRes}
          onChange={(e) => void setPrefs('capturePrefs', { fullRes: e.target.checked })}
          className="mt-0.5 h-5 w-5 accent-emerald-500"
        />
        <span>
          Keep full-resolution photos
          <span className="mt-1 block text-slate-400">
            For photos a museum will catalog as vouchers. Originals are kept
            untouched (3-8 MB each instead of ~0.5 MB), so uploads are slower and
            use more storage. On iPhone, use the <b>Camera app</b> button on the
            capture screen for full resolution.
          </span>
        </span>
      </label>
      <Link to="/export" className="mt-3 inline-block text-emerald-400 underline">
        Export Darwin Core for a museum →
      </Link>
    </section>
  )
}

export default function SettingsPage() {
  const { session } = useAuth()
  const [persisted, setPersisted] = useState<boolean | null>(null)

  useEffect(() => {
    if (navigator.storage?.persisted) {
      void navigator.storage.persisted().then(setPersisted)
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-xl font-bold">Settings</h1>
      </header>

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Offline storage</h2>
        <p className="mt-1 text-slate-400">
          {persisted === true &&
            'Persistent storage is granted — queued records are protected from eviction.'}
          {persisted === false &&
            'Persistent storage is NOT granted. On iOS, add SpeciMap to your Home Screen to protect queued field data from being evicted.'}
          {persisted === null && 'Persistence status unknown on this browser.'}
        </p>
        {persisted === false && (
          <button
            onClick={() => void navigator.storage.persist().then(setPersisted)}
            className="mt-3 rounded bg-slate-700 px-3 py-1.5 font-semibold"
          >
            Request persistence
          </button>
        )}
      </section>

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Account</h2>
        {session ? (
          <>
            <p className="mt-1 text-slate-400">
              Signed in as {session.user.email}
            </p>
            <button
              onClick={() => void supabase.auth.signOut()}
              className="mt-3 rounded bg-slate-700 px-3 py-1.5 font-semibold"
            >
              Sign out
            </button>
            <p className="mt-2 text-xs text-amber-400">
              Don't sign out with unsynced records — they need your account to
              upload.
            </p>
          </>
        ) : (
          <Link to="/auth" className="mt-2 inline-block text-emerald-400 underline">
            Sign in
          </Link>
        )}
      </section>

      <CollectorSettings />

      <VoucherSettings />

      <InatSettings />

      <p className="text-center text-xs text-slate-600">
        SpeciMap {__APP_VERSION__} — free & open source (MIT)
      </p>
    </div>
  )
}
