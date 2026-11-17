import { describe, expect, it } from 'vitest'
import { catalogSequence } from './catalog'

describe('catalogSequence', () => {
  it('counts up from the starting number, keeping its format', () => {
    expect(catalogSequence('AUM 12345', 3)).toEqual(['AUM 12345', 'AUM 12346', 'AUM 12347'])
    expect(catalogSequence(' MSST 0099 ', 2)).toEqual(['MSST 0099', 'MSST 0100'])
    expect(catalogSequence('T-9.01a', 2)).toEqual(['T-9.01a', 'T-9.02a'])
  })
  it('repeats text with no number', () => {
    expect(catalogSequence('pending', 2)).toEqual(['pending', 'pending'])
  })
})
