/**
 * When an unauthenticated user lands on /s/:tagId, stash the tag so the
 * capture flow resumes after the sign-in round-trip (which may involve a
 * full-page redirect through the magic link).
 */
const KEY = 'specimap.resumeTag'

export function stashResumeTag(tagId: string): void {
  try {
    sessionStorage.setItem(KEY, tagId)
  } catch {
    // Private browsing quota errors — resume is best-effort.
  }
}

export function resumePath(): string {
  try {
    const tagId = sessionStorage.getItem(KEY)
    if (tagId) {
      sessionStorage.removeItem(KEY)
      return `/s/${tagId}`
    }
  } catch {
    // ignore
  }
  return '/'
}
