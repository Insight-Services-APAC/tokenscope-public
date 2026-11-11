// @vitest-environment node
/*
 * #593: the Activity list reads a recent window first. The window is an
 * optimisation that must never change an answer, so every case here walks the
 * pages twice, once with the request clock on the data (the window applies) and
 * once with no day on the clock (the read skips the window on every page, cursor
 * or not), and asserts the two walks are row-identical.
 *
 * The third fixture also pins the phase-2 and model-mix change: a page WITH a
 * legacy (instance-keyed) conversation still gets it, whole.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/me/activity.get'
import type { ActivityListResponse, ActivityRow } from '../../../shared/schemas/activity'

const TODAY = '2026-09-30'
/** No day on the clock: the module then reads the whole history. */
const NO_WINDOW = undefined
const NOON = Date.parse(`${TODAY}T12:00:00.000Z`)
const daysAgo = (d: number) => new Date(NOON - d * 86_400_000)

let t: TestDb
let regionId = ''
let ouId = ''
const people: Record<'full' | 'widen' | 'fallback' | 'legacy', string> = { full: '', widen: '', fallback: '', legacy: '' }
let rc: { id: string; version: number }

function sessionOf(teammateId: string): Session {
  return {
    teammateId,
    email: `${teammateId}@x.test`,
    displayName: 'Recent window',
    role: 'developer',
    regionId,
    orgPath: 'rw.svc',
  } as unknown as Session
}

function ev(teammateId: string, query: string, today: string | undefined) {
  const url = `/x?${query}`
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    // The request clock, pinned: the route reads only `today` from it.
    context: { params: {}, serverClock: { now: `${TODAY}T12:00:00.000Z`, today } },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], sessionOf(teammateId))
  return e as unknown as Parameters<typeof listHandler>[0]
}

async function walk(teammateId: string, today: string | undefined, limit: number, query = ''): Promise<ActivityRow[]> {
  const out: ActivityRow[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const q = [query, `limit=${limit}`, cursor ? `cursor=${encodeURIComponent(cursor)}` : ''].filter(Boolean).join('&')
    const page = (await listHandler(ev(teammateId, q, today))) as ActivityListResponse
    out.push(...page.rows)
    if (!page.has_more) return out
    cursor = page.next_cursor
  }
  throw new Error('pagination did not terminate')
}

async function person(key: keyof typeof people) {
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: `oid-rw-${key}`, email: `rw-${key}@x.test`, role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  people[key] = d!.id
  const instanceId = randomUUID()
  await t.db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-rw-${key}`,
    teammateId: d!.id,
    tool: 'claude-code',
    sessionTokenHash: `h-rw-${key}`,
    regionId,
    orgUnitId: ouId,
    attestationState: 'unassigned',
  })
  return { teammateId: d!.id, instanceId }
}

function rec(
  p: { teammateId: string; instanceId: string },
  conv: string | null,
  at: Date,
  over: { model?: string; cost?: string } = {},
) {
  return {
    instanceId: p.instanceId,
    claudeSessionId: conv,
    teammateId: p.teammateId,
    projectId: null,
    regionId,
    orgUnitId: ouId,
    costOwningUnitId: null,
    tool: 'claude-code',
    model: over.model ?? 'claude-sonnet-4-6',
    tokenType: 'input',
    tokens: BigInt(100),
    costUsd: over.cost ?? '1.000000',
    rateCardId: rc.id,
    rateCardVersion: rc.version,
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: at,
  }
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'rw-r', displayName: 'RW' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rw.svc', code: 'rw-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [card] = await t.db.select({ id: schema.rateCard.id, version: schema.rateCard.version }).from(schema.rateCard).limit(1)
  rc = card!

  // A full page inside 14 days, one conversation straddling the window's edge
  // (a row 60 days back that the window leaves out), and older ones below.
  const full = await person('full')
  const fullRows = [
    ...Array.from({ length: 30 }, (_, i) => rec(full, `full-${i}`, daysAgo((i % 10) + 0.1 * i))),
    rec(full, 'full-straddle', daysAgo(60), { cost: '7.000000', model: 'claude-opus-4-1' }),
    rec(full, 'full-straddle', daysAgo(1)),
    ...Array.from({ length: 5 }, (_, i) => rec(full, `full-old-${i}`, daysAgo(100 + i))),
  ]

  // Too few in 14 days; the 56-day widening fills the page.
  const widen = await person('widen')
  const widenRows = [
    ...Array.from({ length: 3 }, (_, i) => rec(widen, `wide-new-${i}`, daysAgo(2 + i))),
    ...Array.from({ length: 30 }, (_, i) => rec(widen, `wide-${i}`, daysAgo(15 + i))),
  ]

  // Too few inside 56 days: the page needs the whole history. A legacy
  // conversation sits among the old ones.
  const fallback = await person('fallback')
  const fallbackRows = [
    rec(fallback, 'fall-new', daysAgo(3)),
    rec(fallback, 'fall-mid', daysAgo(30)),
    ...Array.from({ length: 30 }, (_, i) => rec(fallback, `fall-old-${i}`, daysAgo(90 + i))),
    rec(fallback, null, daysAgo(95)),
  ]

  // A legacy conversation (no claude_session_id) on the first page, two models.
  const legacy = await person('legacy')
  const legacyRows = [
    rec(legacy, null, daysAgo(2), { model: 'claude-opus-4-1', cost: '3.000000' }),
    rec(legacy, null, daysAgo(2.1), { cost: '2.000000' }),
    rec(legacy, 'legacy-neighbour', daysAgo(1)),
  ]

  await t.db.insert(schema.attributionRecord).values([...fullRows, ...widenRows, ...fallbackRows, ...legacyRows])
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('Activity recent window (#593)', () => {
  it('a full page inside the window equals the whole-history page, on every page', async () => {
    const windowed = await walk(people.full, TODAY, 25)
    expect(windowed).toEqual(await walk(people.full, NO_WINDOW, 25))
    expect(windowed).toHaveLength(36)
  })

  it('a conversation straddling the window keeps its whole total and first event', async () => {
    const rows = await walk(people.full, TODAY, 25)
    const straddle = rows.find((r) => r.id === 'full-straddle')!
    expect(straddle.kind).toBe('session')
    expect(Number(straddle.cost_usd)).toBe(8)
    if (straddle.kind === 'session') expect(Date.parse(straddle.ts_first)).toBe(daysAgo(60).getTime())
  })

  it('the widened page equals the whole-history page', async () => {
    const windowed = await walk(people.widen, TODAY, 25)
    expect(windowed).toEqual(await walk(people.widen, NO_WINDOW, 25))
    expect(windowed).toHaveLength(33)
  })

  it('a page needing the fallback equals the whole-history page', async () => {
    const windowed = await walk(people.fallback, TODAY, 25)
    expect(windowed).toEqual(await walk(people.fallback, NO_WINDOW, 25))
    expect(windowed).toHaveLength(33)
  })

  it('a date range and a tool filter give the same rows through the window', async () => {
    const q = `from=2026-09-20&to=${TODAY}&tool=claude-code`
    expect(await walk(people.full, TODAY, 10, q)).toEqual(await walk(people.full, NO_WINDOW, 10, q))
  })

  it('a page with a legacy conversation still gets it, whole, with its model mix', async () => {
    const rows = await walk(people.legacy, TODAY, 25)
    expect(rows).toHaveLength(2)
    const legacy = rows.find((r) => r.id !== 'legacy-neighbour')!
    expect(Number(legacy.cost_usd)).toBe(5)
    expect(rows).toEqual(await walk(people.legacy, NO_WINDOW, 25))
    expect(JSON.stringify(legacy)).toContain('claude-opus-4-1')
  })

  it('a legacy conversation found only by the fallback is still returned', async () => {
    const rows = await walk(people.fallback, TODAY, 40)
    expect(rows.filter((r) => !String(r.id).startsWith('fall-'))).toHaveLength(1)
  })
})
