import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: {}, PHOTO_BUCKET: 'photos' }))

import type { Custody } from '../db/schema'
import { canCurate, canEdit, type Membership } from './api'

const held = (over: Partial<Custody>): Custody => ({
  custodianUser: null,
  custodianOrg: null,
  visibility: 'private',
  generalizePublic: true,
  catalogNumber: null,
  ...over,
})
const org = (role: Membership['role']): Membership[] => [{ id: 'aum', name: 'Auburn', code: 'AUM', role }]

describe('custody permissions', () => {
  it('lets the custodian person edit and curate', () => {
    expect(canEdit(held({ custodianUser: 'me' }), 'me', [])).toBe(true)
    expect(canCurate(held({ custodianUser: 'me' }), 'me', [])).toBe(true)
    expect(canEdit(held({ custodianUser: 'you' }), 'me', [])).toBe(false)
  })

  it('gives collection roles their powers', () => {
    const c = held({ custodianOrg: 'aum' })
    expect([canEdit(c, 'me', org('curator')), canCurate(c, 'me', org('curator'))]).toEqual([true, true])
    expect([canEdit(c, 'me', org('staff')), canCurate(c, 'me', org('staff'))]).toEqual([true, false])
    expect([canEdit(c, 'me', org('viewer')), canCurate(c, 'me', org('viewer'))]).toEqual([false, false])
    expect(canEdit(c, 'me', [])).toBe(false)
  })

  it('treats records not yet uploaded as the creator\'s', () => {
    expect(canEdit(undefined, 'me', [])).toBe(true)
  })
})
