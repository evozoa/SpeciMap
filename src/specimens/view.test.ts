import { describe, expect, it } from 'vitest'
import type { LocalRecord } from '../db/schema'
import { buildSpecimens, distanceMetres, specimenView } from './view'

let n = 0
function cap(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: `c${++n}`,
    tagId: '7Q4MK2XRC',
    collectorId: 'me',
    lat: 33.45,
    lng: -88.79,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-11-01T15:00:00.000Z',
    notes: '',
    species: '',
    focusScore: null,
    status: 'synced',
    syncStep: 'done',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    ...overrides,
  }
}

describe('specimenView', () => {
  it('takes date and place from the earliest capture, whatever order they arrive in', () => {
    const late = cap({ capturedAt: '2026-11-01T15:10:00.000Z', lat: 33.4501 })
    const early = cap({ capturedAt: '2026-11-01T15:00:00.000Z' })
    const v = specimenView([late, early])
    expect(v.first).toBe(early)
    expect(v.latestAt).toBe(late.capturedAt)
    expect(v.reuseSuspects).toEqual([])
  })

  it('uses the most recent identification and flags different taxa', () => {
    const a = cap({ species: 'Lepomis megalotis', identifiedAt: '2026-11-01T15:00:00.000Z' })
    const b = cap({ species: 'Lepomis macrochirus', identifiedAt: '2026-11-01T16:00:00.000Z' })
    const v = specimenView([a, b])
    expect(v.species).toBe('Lepomis macrochirus')
    expect(v.disagreement?.sort()).toEqual(['Lepomis macrochirus', 'Lepomis megalotis'])
  })

  it('treats names linked to the same taxon as agreeing', () => {
    const t = { id: 58635, name: 'Lepomis megalotis', rank: 'species' }
    const v = specimenView([
      cap({ species: 'Lepomis megalotis', taxon: t }),
      cap({ species: 'longear sunfish', taxon: t }),
      cap({ species: '' }),
    ])
    expect(v.disagreement).toBeNull()
  })

  it('flags captures far in time or space as possible tag reuse until confirmed', () => {
    const first = cap()
    const nextDay = cap({ capturedAt: '2026-11-02T15:00:00.000Z' })
    const farAway = cap({ capturedAt: '2026-11-01T15:30:00.000Z', lat: 33.6 })
    const nearby = cap({ capturedAt: '2026-11-01T16:00:00.000Z', lat: 33.451 })
    const v = specimenView([first, nextDay, farAway, nearby])
    expect(v.reuseSuspects.map((r) => r.id).sort()).toEqual([nextDay.id, farAway.id].sort())

    const reviewed = specimenView([first, nextDay, farAway, nearby], {
      tagId: first.tagId,
      individualCount: 1,
      confirmedCaptureIds: [nextDay.id],
      dirty: 0,
    })
    expect(reviewed.reuseSuspects.map((r) => r.id)).toEqual([farAway.id])
  })

  it('reports the least settled status', () => {
    expect(specimenView([cap(), cap({ status: 'queued' })]).status).toBe('queued')
    expect(specimenView([cap({ status: 'queued' }), cap({ status: 'error' })]).status).toBe('error')
  })
})

describe('buildSpecimens', () => {
  it('groups captures by tag, skips drafts, newest first, with specimen fields', () => {
    const list = buildSpecimens(
      [
        cap({ tagId: 'A', capturedAt: '2026-11-01T10:00:00.000Z' }),
        cap({ tagId: 'B', capturedAt: '2026-11-02T10:00:00.000Z' }),
        cap({ tagId: 'A', capturedAt: '2026-11-01T10:05:00.000Z' }),
        cap({ tagId: 'C', status: 'draft' }),
      ],
      [{ tagId: 'A', individualCount: 12, confirmedCaptureIds: [], dirty: 0 }],
    )
    expect(list.map((v) => [v.tagId, v.captures.length, v.individualCount])).toEqual([
      ['B', 1, 1],
      ['A', 2, 12],
    ])
  })
})

describe('distanceMetres', () => {
  it('is roughly right for a small offset', () => {
    expect(distanceMetres({ lat: 33.45, lng: -88.79 }, { lat: 33.46, lng: -88.79 })).toBeCloseTo(1112, -1)
  })
})
