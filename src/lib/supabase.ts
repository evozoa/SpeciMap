import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !anonKey) {
  // Fail loudly in dev; a deployed build must always have these baked in.
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env',
  )
}

export const supabase = createClient(url ?? 'http://localhost:54321', anonKey ?? 'anon', {
  auth: {
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

/** Origin embedded in generated tag QR codes. */
export const APP_ORIGIN =
  (import.meta.env.VITE_APP_ORIGIN as string | undefined) ??
  (typeof window !== 'undefined' ? window.location.origin : 'https://specimap.example.org')

export const PHOTO_BUCKET = 'specimen-photos'
