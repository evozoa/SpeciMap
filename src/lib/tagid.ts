/**
 * SpeciMap tag identifiers.
 *
 * Format: 8 Crockford Base32 data characters + 1 Crockford check symbol
 * (mod 37). Canonical URL/DB form is the bare 9 characters ("7Q4MK2XRC");
 * display form groups them as "7Q4M-K2XR-C".
 *
 * Crockford Base32 deliberately omits I, L, O and U from the data alphabet
 * so hand-copied IDs are unambiguous; the check symbol may additionally be
 * one of "*~$=U".
 */
import { customAlphabet } from 'nanoid'

export const DATA_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CHECK_ALPHABET = DATA_ALPHABET + '*~$=U'
export const DATA_LENGTH = 8
export const TAG_LENGTH = DATA_LENGTH + 1

const randomData = customAlphabet(DATA_ALPHABET, DATA_LENGTH)

/** Map visually-ambiguous characters onto their canonical Crockford digit. */
function canonicalizeChar(c: string): string {
  switch (c) {
    case 'O':
      return '0'
    case 'I':
    case 'L':
      return '1'
    default:
      return c
  }
}

/**
 * Uppercase, strip hyphens/spaces, and fold ambiguous characters (O→0, I/L→1).
 * Does NOT validate — feed the result to isValidTagId.
 */
export function normalizeTagId(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .split('')
    .map(canonicalizeChar)
    .join('')
}

/** Crockford mod-37 check symbol for a string of data characters. */
export function checkSymbol(data: string): string {
  let value = 0
  for (const c of data) {
    const digit = DATA_ALPHABET.indexOf(c)
    if (digit < 0) throw new Error(`invalid data character: ${c}`)
    value = (value * 32 + digit) % 37
  }
  return CHECK_ALPHABET[value]
}

/** True if `id` (already normalized) is a well-formed tag ID with a valid check symbol. */
export function isValidTagId(id: string): boolean {
  if (id.length !== TAG_LENGTH) return false
  const data = id.slice(0, DATA_LENGTH)
  const check = id[DATA_LENGTH]
  for (const c of data) {
    if (!DATA_ALPHABET.includes(c)) return false
  }
  if (!CHECK_ALPHABET.includes(check)) return false
  return checkSymbol(data) === check
}

/** Normalize free-form input and return the canonical tag ID, or null if invalid. */
export function parseTagId(input: string): string | null {
  const id = normalizeTagId(input)
  return isValidTagId(id) ? id : null
}

/** Generate a new random tag ID (canonical 9-character form). */
export function generateTagId(): string {
  const data = randomData()
  return data + checkSymbol(data)
}

/** Display form: "7Q4M-K2XR-C". */
export function formatTagId(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}`
}

/** Absolute capture URL encoded into the tag's QR code. */
export function tagUrl(origin: string, id: string): string {
  return `${origin.replace(/\/$/, '')}/s/${id}`
}
