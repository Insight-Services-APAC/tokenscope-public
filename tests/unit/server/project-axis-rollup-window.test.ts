// @vitest-environment node
/*
 * The rollup path's UTC-midnight window assertion (usage-rollup-lane.md
 * R5b.2). The `ts_event` half-open window and the rollup's `day` range are
 * equivalent ONLY for exact-midnight bounds — a mid-day bound would silently
 * drop or admit part of a day — so `projectAxisRows` must THROW on a
 * non-midnight bound BEFORE touching the database (a programmer error, never
 * an undercount), and the view path must be unaffected.
 */
import { describe, it, expect } from 'vitest'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  completeProjectAxisSpend,
  completeProjectAxisPopulation,
} from '../../../server/usage/complete-spend'

/** A db whose only job is to prove the assertion fired FIRST. */
const unreachableDb = {
  execute: async () => {
    throw new Error('the db was reached — the midnight assertion did not fire first')
  },
} as never

/** A db that answers every query with zero rows (the no-throw paths). */
const emptyDb = { execute: async () => [] } as never

/** A db that records every query so its bound params can be inspected
 *  (the vendor.test.ts PgDialect render pattern — no DB needed). */
const capturingDb = (): { db: never; queries: SQL[] } => {
  const queries: SQL[] = []
  return {
    db: {
      execute: async (q: SQL) => {
        queries.push(q)
        return []
      },
    } as never,
    queries,
  }
}

const paramsOf = (q: SQL): unknown[] => new PgDialect().sqlToQuery(q).params

const MIDNIGHTS = { startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-09-11T00:00:00.000Z' }

describe("projectAxisRows source: 'rollup' — the UTC-midnight assertion", () => {
  it.each([
    ['an hour offset', '2026-09-01T17:00:00.000Z'],
    ['a minute offset', '2026-09-01T00:30:00.000Z'],
    ['a second offset', '2026-09-01T00:00:01.000Z'],
    ['a millisecond offset', '2026-09-01T00:00:00.001Z'],
    ['an unparseable instant', 'not-a-date'],
  ])('throws on %s in startIso, before any db call', async (_what, startIso) => {
    await expect(
      completeProjectAxisSpend(unreachableDb, { startIso, endIso: MIDNIGHTS.endIso }, {
        scope: sql`TRUE`,
        source: 'rollup',
      }),
    ).rejects.toThrow(/UTC-midnight.*startIso/)
  })

  it('throws on a non-midnight endIso, naming the bound', async () => {
    await expect(
      completeProjectAxisSpend(
        unreachableDb,
        { startIso: MIDNIGHTS.startIso, endIso: '2026-09-11T23:59:59.000Z' },
        { scope: sql`TRUE`, source: 'rollup' },
      ),
    ).rejects.toThrow(/UTC-midnight.*endIso/)
  })

  it('the population variant forwards source and asserts identically', async () => {
    await expect(
      completeProjectAxisPopulation(
        unreachableDb,
        { startIso: '2026-09-01T09:00:00.000Z', endIso: MIDNIGHTS.endIso },
        { scope: sql`TRUE`, source: 'rollup' },
      ),
    ).rejects.toThrow(/UTC-midnight.*startIso/)
  })

  it('exact midnights pass through to the query', async () => {
    await expect(
      completeProjectAxisSpend(emptyDb, MIDNIGHTS, { scope: sql`TRUE`, source: 'rollup' }),
    ).resolves.toEqual([])
  })

  it('an OFFSET-formatted UTC midnight passes AND binds the PARSED UTC day, never the raw digits', async () => {
    // Both bounds are exact UTC midnights written with a non-Z offset, so
    // their raw first-ten characters name the WRONG day: the assertion
    // validates the parsed instant, and the day bound must come from the same
    // parsed instant or the window silently shifts a full day (R5b.2).
    const { db, queries } = capturingDb()
    await expect(
      completeProjectAxisSpend(
        db,
        {
          startIso: '2026-09-01T23:00:00-01:00', // = 2026-09-02T00:00:00Z; raw slice says 09-01
          endIso: '2026-09-11T22:00:00-02:00', // = 2026-09-12T00:00:00Z; raw slice says 09-11
        },
        { scope: sql`TRUE`, source: 'rollup' },
      ),
    ).resolves.toEqual([])
    expect(queries.length).toBe(1)
    const params = paramsOf(queries[0]!)
    expect(params).toContain('2026-09-02')
    expect(params).toContain('2026-09-12')
    expect(params).not.toContain('2026-09-01')
    expect(params).not.toContain('2026-09-11')
  })

  it('Z-formatted midnights bind their own UTC days (the derivation is an identity on canonical input)', async () => {
    const { db, queries } = capturingDb()
    await completeProjectAxisSpend(db, MIDNIGHTS, { scope: sql`TRUE`, source: 'rollup' })
    const params = paramsOf(queries[0]!)
    expect(params).toContain('2026-09-01')
    expect(params).toContain('2026-09-11')
  })

  it('the VIEW path never asserts — a non-midnight window is its normal diet', async () => {
    await expect(
      completeProjectAxisSpend(
        emptyDb,
        { startIso: '2026-09-01T09:15:00.000Z', endIso: '2026-09-11T17:30:00.000Z' },
        { scope: sql`TRUE` },
      ),
    ).resolves.toEqual([])
  })
})
