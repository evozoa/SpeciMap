import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { resumePath } from './resume'

type Stage = 'email' | 'sent'

/**
 * Passwordless sign-in. The email contains a magic link AND a 6-digit code:
 * the code path matters because magic links opened inside an email app's
 * in-app browser create the session in the wrong browser context.
 */
export default function AuthPage() {
  const [stage, setStage] = useState<Stage>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function sendLink(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    setBusy(false)
    if (error) setError(error.message)
    else setStage('sent')
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: 'email',
    })
    setBusy(false)
    if (error) setError(error.message)
    else navigate(resumePath(), { replace: true })
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Sign in to SpeciMap</h1>
        <p className="mt-1 text-sm text-slate-400">
          Sign in once at home — capturing in the field works offline afterwards.
        </p>
      </div>

      {stage === 'email' && (
        <form onSubmit={sendLink} className="flex flex-col gap-3">
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3"
          />
          <button
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      )}

      {stage === 'sent' && (
        <form onSubmit={verifyCode} className="flex flex-col gap-3">
          <p className="text-sm">
            Check <span className="font-semibold">{email}</span>. Tap the link
            <em> in this browser</em>, or enter the 6-digit code from the email:
          </p>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-center text-xl tracking-widest"
          />
          <button
            disabled={busy || code.trim().length < 6}
            className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify code'}
          </button>
          <button
            type="button"
            onClick={() => setStage('email')}
            className="text-sm text-slate-400 underline"
          >
            Use a different email
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}
