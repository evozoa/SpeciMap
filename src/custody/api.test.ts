import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: {}, PHOTO_BUCKET: 'photos' }))

import type { Custody } from '../db/schema'
import { canCurate, canEdit, groupByBatch, type Membership, type Transfer } from './api'

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

describe('groupByBatch', () => {
  it('groups a batch together and keeps single transfers apart', () => {
    const t = (id: string, batch: string | null) => ({ id, batch_id: batch }) as Transfer
    const groups = groupByBatch([t('1', 'B'), t('2', null), t('3', 'B'), t('4', null)])
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([['1', '3'], ['2'], ['4']])
  })
})
