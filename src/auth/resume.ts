/**
 * When an unauthenticated user lands on /s/:tagId, stash the tag so the
 * capture flow resumes after the sign-in round-trip (which may involve a
 * full-page redirect through the magic link).
 */
const KEY = 'specimap.resumeTag'

export function stashResumeTag(tagId: string): void {
  stashResumePath(`/s/${tagId}`)
}

/** Any in-app path to return to after signing in (e.g. a field sheet /e/…). */
export function stashResumePath(path: string): void {
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Private browsing quota errors — resume is best-effort.
  }
}

export function resumePath(): string {
  try {
    const stashed = sessionStorage.getItem(KEY)
    if (stashed) {
      sessionStorage.removeItem(KEY)
      // Older builds stashed a bare tag ID.
      return stashed.startsWith('/') ? stashed : `/s/${stashed}`
    }
  } catch {
    // ignore
  }
  return '/'
}
