import { describe, expect, it } from 'vitest'
import {
  checkSymbol,
  DATA_ALPHABET,
  formatTagId,
  generateTagId,
  isValidTagId,
  normalizeTagId,
  parseTagId,
  tagUrl,
} from './tagid'

describe('checkSymbol', () => {
  it('computes known Crockford mod-37 vectors', () => {
    // value("0") = 0 -> '0'; value("1") = 1 -> '1'
    expect(checkSymbol('0')).toBe('0')
    expect(checkSymbol('1')).toBe('1')
    // "Z" = 31 -> 'Z'
    expect(checkSymbol('Z')).toBe('Z')
    // "10" = 32 -> index 32 -> '*'
    expect(checkSymbol('10')).toBe('*')
    // "14" = 36 -> 'U'
    expect(checkSymbol('14')).toBe('U')
    // "15" = 37 -> 0 -> '0'
    expect(checkSymbol('15')).toBe('0')
  })

  it('rejects characters outside the data alphabet', () => {
    expect(() => checkSymbol('AB!')).toThrow()
    expect(() => checkSymbol('ABCU')).toThrow() // U is check-only
  })
})

describe('generateTagId / isValidTagId', () => {
  it('generates valid 9-char IDs from the data alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateTagId()
      expect(id).toHaveLength(9)
      for (const c of id.slice(0, 8)) expect(DATA_ALPHABET).toContain(c)
      expect(isValidTagId(id)).toBe(true)
    }
  })

  it('detects a corrupted character', () => {
    const id = generateTagId()
    const pos = 3
    const original = id[pos]
    const swapped =
      DATA_ALPHABET[(DATA_ALPHABET.indexOf(original) + 1) % 32]
    const corrupted = id.slice(0, pos) + swapped + id.slice(pos + 1)
    expect(isValidTagId(corrupted)).toBe(false)
  })

  it('rejects wrong lengths', () => {
    expect(isValidTagId('')).toBe(false)
    expect(isValidTagId('ABC')).toBe(false)
    expect(isValidTagId(generateTagId() + '0')).toBe(false)
  })
})

describe('normalizeTagId / parseTagId', () => {
  it('strips hyphens and spaces, uppercases', () => {
    const id = generateTagId()
    expect(parseTagId(formatTagId(id).toLowerCase())).toBe(id)
    expect(parseTagId(` ${id.slice(0, 4)} ${id.slice(4)} `)).toBe(id)
  })

  it('folds ambiguous characters O→0 and I/L→1', () => {
    expect(normalizeTagId('oIl')).toBe('011')
    // Build an ID containing 0 and 1, then re-enter it with O and L
    const data = '01AB2CD3'
    const id = data + checkSymbol(data)
    expect(parseTagId('OLAB2CD3' + checkSymbol(data))).toBe(id)
  })

  it('returns null for garbage', () => {
    expect(parseTagId('not-a-tag')).toBeNull()
    expect(parseTagId('')).toBeNull()
  })
})

describe('formatTagId / tagUrl', () => {
  it('groups as XXXX-XXXX-C', () => {
    expect(formatTagId('7Q4MK2XRC')).toBe('7Q4M-K2XR-C')
  })
  it('builds the capture URL without double slashes', () => {
    expect(tagUrl('https://specimap.app/', '7Q4MK2XRC')).toBe(
      'https://specimap.app/s/7Q4MK2XRC',
    )
  })
})
