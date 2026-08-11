// @vitest-environment node
/*
 * T3 — the `TimeZone: 'UTC'` pin is asserted, and the integration helper carries it.
 *
 * ── WHY THIS TEST REPLACES 23 QUERY REWRITES ────────────────────────────────
 * `clock-rot-audit.md` §A counts ~23 bare `timestamptz` day-bucket casts —
 * `date_trunc('day', u.ts_event)::date`, `to_char(MAX(ts_event), 'YYYY-MM-DD')`,
 * `u.ts_event::date` — including the canonical §A daily series that feeds every
 * sparkline. Each one buckets in the SESSION timezone. They are all correct
 * today, and correct for exactly one reason: `server/db/index.ts` pins
 * `connection: { TimeZone: 'UTC' }` on the pool that serves every request and
 * every in-process worker.
 *
 * They are therefore LATENT, not broken. The honest fix is to make that one
 * line load-bearing IN THE SUITE rather than in a review comment — not to
 * rewrite 23 queries, which is the expensive way to buy what one assertion buys
 * and would leave the 24th unprotected anyway.
 *
 * ── THE TWO HALVES, AND WHY BOTH ARE NEEDED ─────────────────────────────────
 * §G-a: no test asserted the pin. Deleting the line turned all 23 sites into
 *       live day-boundary defects and failed NOTHING.
 * §F-d: `tests/integration/helpers/db.ts` created its client WITHOUT the pin, so
 *       237 integration tests did not run production's connection config. They
 *       inherited the container default (coincidentally UTC), which means they
 *       could not have caught a session-TZ bug even in principle.
 *
 * Both halves are asserted here: production's pin, and the helper's.
 *
 * ── GUARD THE GUARD ─────────────────────────────────────────────────────────
 * Modelled on `tests/integration/usage/ab-decomposition.test.ts:496`: this file
 * proves a non-UTC startup parameter really TAKES on this server before it
 * trusts a UTC reading, because if the parameter were being ignored every
 * assertion below would pass by running at UTC and prove nothing. That test's
 * own comment records that the underlying defect shipped and was fixed TWICE
 * while the suite stayed green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('the session TimeZone pin', () => {
  it('GUARDS THE GUARD — a non-UTC startup parameter really takes on this server', async () => {
    // Without this, "TimeZone is UTC" could mean "the parameter is ignored".
    const c = postgres(t.url, { max: 1, idle_timeout: 5, connection: { TimeZone: 'Pacific/Midway' } })
    try {
      const [row] = await c<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
      expect(row!.tz).toBe('Pacific/Midway')
    } finally {
      await c.end({ timeout: 5 })
    }
  })

  it('getDb() serves connections pinned to UTC', async () => {
    // Import lazily: getDb() reads DATABASE_URL at first call, set in beforeAll.
    const { getDb } = await import('../../../server/db/index')
    const db = getDb()
    const { sql } = await import('drizzle-orm')
    const rows = await db.execute<{ tz: string }>(sql`SELECT current_setting('TimeZone') AS tz`)
    expect([...rows][0]!.tz).toBe('UTC')
  })

  it('the production pool declares the pin in source — delete the line and this goes red', async () => {
    /*
     * The runtime assertion above proves the CURRENT connection is UTC; it would
     * still pass on a server whose own default happened to be UTC. This one is
     * about the line that makes it true everywhere, including on Azure Flexible
     * Server where `timezone` is not managed by IaC (§G-c) and a portal change
     * would persist through every subsequent deployment with nothing detecting it.
     */
    const src = readFileSync(resolve(__dirname, '../../../server/db/index.ts'), 'utf8')
    expect(src).toMatch(/connection:\s*\{\s*TimeZone:\s*'UTC'\s*\}/)
  })

  it('the INTEGRATION HELPER runs production\'s connection config too (§F-d)', async () => {
    // The 237 integration tests used to run an unpinned client. This asserts the
    // suite is now capable of catching a session-TZ regression at all.
    const [row] = await t.client<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`
    expect(row!.tz).toBe('UTC')
  })

  it('a bare `timestamptz::date` cast is only correct BECAUSE of the pin', async () => {
    /*
     * The mechanism, made concrete, so the two assertions above read as a
     * consequence rather than a convention. 22:00Z on the 15th is the 15th in
     * UTC and the 16th at UTC+14 — the same row, two different days, and every
     * §A daily chart is built on exactly this cast.
     */
    const ts = '2026-06-15T22:00:00Z'
    const [utc] = await t.client<{ d: string }[]>`
      SELECT to_char(${ts}::timestamptz::date, 'YYYY-MM-DD') AS d`
    expect(utc!.d).toBe('2026-06-15')

    const east = postgres(t.url, {
      max: 1,
      idle_timeout: 5,
      connection: { TimeZone: 'Pacific/Kiritimati' }, // UTC+14
    })
    try {
      const [shifted] = await east<{ d: string }[]>`
        SELECT to_char(${ts}::timestamptz::date, 'YYYY-MM-DD') AS d`
      // The unpinned answer. One day out — silently, on every chart, for every
      // reader, with no error anywhere.
      expect(shifted!.d).toBe('2026-06-16')
      expect(shifted!.d).not.toBe(utc!.d)
    } finally {
      await east.end({ timeout: 5 })
    }
  })
})
