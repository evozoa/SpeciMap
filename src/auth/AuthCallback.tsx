import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { resumePath } from './resume'

/**
 * Magic-link landing. supabase-js (detectSessionInUrl + PKCE) exchanges the
 * code automatically; we just wait for the session and resume.
 */
export default function AuthCallback() {
  const { session, loading } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (loading) return
    navigate(session ? resumePath() : '/auth', { replace: true })
  }, [session, loading, navigate])

  return (
    <div className="flex min-h-full items-center justify-center text-slate-400">
      Signing you in…
    </div>
  )
}
