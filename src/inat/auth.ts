/**
 * iNaturalist sign-in (OAuth 2 authorization code + PKCE, no client secret)
 * and API tokens. Everything stays on this device:
 *   - the OAuth access token (long-lived) in the Dexie `meta` table;
 *   - the API JWT (valid ~24 h) cached there and refreshed from the token.
 * iNaturalist's endpoints allow browser (CORS) requests, so no server is
 * involved.
 */
import { db } from '../db/schema'
import type { InatGeoprivacy } from '../db/schema'

export const INAT_CLIENT_ID: string | undefined = import.meta.env.VITE_INAT_CLIENT_ID
export const INAT_WEB = 'https://www.inaturalist.org'
export const INAT_API = 'https://api.inaturalist.org/v1'

const VERIFIER_KEY = 'specimap.inat.pkce'
const JWT_MAX_AGE_MS = 12 * 3_600_000

export interface InatAccount {
  accessToken: string
  login: string | null
  connectedAt: string
}

export interface InatPrefs {
  geoprivacy: InatGeoprivacy
  shareOnCapture: boolean
}

export const DEFAULT_PREFS: InatPrefs = { geoprivacy: 'obscured', shareOnCapture: false }

export function inatConfigured(): boolean {
  return !!INAT_CLIENT_ID
}

function redirectUri(): string {
  return `${window.location.origin}/inat/callback`
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Send the browser to iNaturalist to approve SpeciMap. */
export async function startInatConnect(): Promise<void> {
  if (!INAT_CLIENT_ID) throw new Error('iNaturalist sharing is not configured')
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  // localStorage (not sessionStorage): the redirect may come back in a new tab.
  localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }))
  const url = new URL(`${INAT_WEB}/oauth/authorize`)
  url.search = new URLSearchParams({
    client_id: INAT_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  window.location.assign(url.toString())
}

/** Finish sign-in on the /inat/callback page. */
export async function finishInatConnect(params: URLSearchParams): Promise<InatAccount> {
  const error = params.get('error')
  if (error) throw new Error(params.get('error_description') ?? error)
  const code = params.get('code')
  const saved = localStorage.getItem(VERIFIER_KEY)
  if (!code || !saved) {
    throw new Error(
      'This sign-in started in a different browser window. Open SpeciMap the way you usually do (e.g. from your Home Screen) and connect again.',
    )
  }
  const { verifier, state } = JSON.parse(saved) as { verifier: string; state: string }
  if (params.get('state') !== state) throw new Error('Sign-in check failed; please try again.')
  localStorage.removeItem(VERIFIER_KEY)

  const res = await fetch(`${INAT_WEB}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: INAT_CLIENT_ID,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`iNaturalist sign-in failed (${res.status})`)
  const { access_token } = (await res.json()) as { access_token: string }
  const account: InatAccount = {
    accessToken: access_token,
    login: null,
    connectedAt: new Date().toISOString(),
  }
  await db.meta.put({ key: 'inatAccount', value: account })
  await db.meta.delete('inatJwt')
  try {
    const me = await fetch(`${INAT_API}/users/me`, {
      headers: { Authorization: await getInatJwt() },
    })
    const body = (await me.json()) as { results?: { login?: string }[] }
    account.login = body.results?.[0]?.login ?? null
    await db.meta.put({ key: 'inatAccount', value: account })
  } catch {
    // The login name is cosmetic; sharing works without it.
  }
  return account
}

export async function getInatAccount(): Promise<InatAccount | null> {
  return ((await db.meta.get('inatAccount'))?.value as InatAccount | undefined) ?? null
}

export async function disconnectInat(): Promise<void> {
  await db.meta.bulkDelete(['inatAccount', 'inatJwt'])
}

export async function getInatPrefs(): Promise<InatPrefs> {
  const v = (await db.meta.get('inatPrefs'))?.value as Partial<InatPrefs> | undefined
  return { ...DEFAULT_PREFS, ...v }
}

export async function setInatPrefs(changes: Partial<InatPrefs>): Promise<void> {
  await db.meta.put({ key: 'inatPrefs', value: { ...(await getInatPrefs()), ...changes } })
}

/** Thrown when the stored iNaturalist sign-in no longer works. */
export class InatAuthError extends Error {}

/** A current API JWT, fetched with the stored access token when needed. */
export async function getInatJwt(forceRefresh = false): Promise<string> {
  const account = await getInatAccount()
  if (!account) throw new InatAuthError('Not connected to iNaturalist')
  const cached = (await db.meta.get('inatJwt'))?.value as
    | { token: string; fetchedAt: number }
    | undefined
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWT_MAX_AGE_MS) {
    return cached.token
  }
  const res = await fetch(`${INAT_WEB}/users/api_token`, {
    headers: { Authorization: `Bearer ${account.accessToken}`, Accept: 'application/json' },
  })
  if (res.status === 401 || res.status === 403) {
    throw new InatAuthError('iNaturalist sign-in expired; reconnect in Settings')
  }
  if (!res.ok) throw new Error(`iNaturalist token request failed (${res.status})`)
  const { api_token } = (await res.json()) as { api_token: string }
  await db.meta.put({ key: 'inatJwt', value: { token: api_token, fetchedAt: Date.now() } })
  return api_token
}
