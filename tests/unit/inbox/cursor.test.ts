/*
 * The inbox page cursor (#569) accepts only what the server mints: a real UTC
 * instant with microseconds and a uuid. An impossible date is refused here, so
 * it is a 400 and never reaches Postgres as a 500 (external review, round 2).
 */
import { describe, it, expect } from 'vitest'
import { parseInboxCursor } from '../../../server/inbox/filters'

const ID = '9a1e0000-0000-4000-8000-000000000001'

describe('parseInboxCursor', () => {
  it('reads a cursor the server minted', () => {
    expect(parseInboxCursor(`2026-11-10T21:00:00.123456Z_${ID}`)).toEqual({ createdAt: '2026-11-10T21:00:00.123456Z', id: ID })
  })
  it.each([
    [`2026-02-31T00:00:00.000000Z_${ID}`],
    [`2026-11-10T25:00:00.000000Z_${ID}`],
    [`2026-11-10T21:00:00Z_${ID}`],
    ['2026-11-10T21:00:00.000000Z_not-a-uuid'],
    [`2026-11-10T21:00:00.000000Z_${ID}' OR 1=1`],
    [''],
  ])('refuses %s', (raw) => {
    expect(parseInboxCursor(raw)).toBeNull()
  })
})
