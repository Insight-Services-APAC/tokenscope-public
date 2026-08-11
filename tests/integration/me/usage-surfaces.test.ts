// @vitest-environment node
/*
 * #142 — /api/v1/me/home `surfaces` section (§B display-only, non-Code Claude
 * surfaces), against real Postgres via the REAL handler (per AGENTS.md §"Never
 * mock Drizzle").
 *
 * Contract under test (server/utils/me-queries.ts getMySurfaceSpend):
 *   - per non-Code surface tool → { tool, label, mtd_usd, days } from
 *     actual_spend, REQUESTER-scoped and month-scoped (MTD);
 *   - the filter derives from NON_CODE_CLAUDE_TOOLS: claude-code and
 *     copilot-cli rows NEVER appear (Code is §A; Copilot is pooled);
 *   - zero-total surfaces are elided; order = canonical display order;
 *   - another teammate's surface spend never leaks into the caller's view;
 *   - RBAC: no session → 401 (the endpoint is cookie-auth only).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { NON_CODE_CLAUDE_TOOLS } from '../../../shared/usage/surface'
import usageHandler from '../../../server/api/v1/me/home.get'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let priyaId = ''
let aniId = ''

function ev(session?: Session) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/x',
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, cookie: '' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  if (session) injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof usageHandler>[0]
}

const sess = (teammateId: string): Session =>
  ({
    teammateId,
    email: 'p@surf.test',
    displayName: 'P',
    role: 'developer',
    regionId,
    orgPath: 'surf',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

// All seeds land in the CURRENT month (the handler windows on runtime now()).
const now = new Date()
const day = (d: number) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d)).toISOString().slice(0, 10)

async function spend(teammateId: string, tool: string, costUsd: string, onDay: string) {
  await t.db.insert(schema.actualSpend).values({
    teammateId,
    date: onDay,
    tool,
    inputTokens: 100n,
    outputTokens: 100n,
    costUsd,
    source: 'anthropic-analytics-api',
  })
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'surfaces-test-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'surfaces-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'surf', displayName: 'Surf' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'surf', code: 'surf', displayName: 'Surf', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-surf-p', email: 'p@surf.test', regionId, orgUnitId })
    .returning()
  priyaId = priya!.id
  const [ani] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-surf-a', email: 'a@surf.test', regionId, orgUnitId })
    .returning()
  aniId = ani!.id

  // Priya (the requester): two claude-ai days + one claude-slack day (both
  // non-Code surfaces), PLUS rows that must NOT appear in `surfaces`:
  // claude-code (§A lane), copilot-cli (pooled), and a zero-cost claude-design
  // day (elided as an all-zero surface).
  await spend(priyaId, 'claude-ai', '3.50', day(3))
  await spend(priyaId, 'claude-ai', '1.25', day(5))
  await spend(priyaId, 'claude-slack', '0.75', day(4))
  await spend(priyaId, 'claude-code', '10.00', day(3))
  await spend(priyaId, 'copilot-cli', '4.00', day(3))
  await spend(priyaId, 'claude-design', '0.00', day(3))
  // Ani's surface spend must never leak into Priya's view.
  await spend(aniId, 'claude-ai', '99.00', day(3))
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

describe('/me/home surfaces (§B non-Code Claude lanes, #142)', () => {
  it('returns the requester-only per-surface MTD totals + per-day series, canonical order, zero surfaces elided', async () => {
    const res = await usageHandler(ev(sess(priyaId)))

    expect(res.surfaces.map((s) => s.tool)).toEqual(['claude-ai', 'claude-slack'])
    // Every returned tool is a member of the canonical non-Code set — the
    // filter derives from NON_CODE_CLAUDE_TOOLS, never hand-copied literals.
    for (const s of res.surfaces) {
      expect(NON_CODE_CLAUDE_TOOLS).toContain(s.tool)
    }

    const ai = res.surfaces[0]!
    expect(ai.label).toBe('Claude Chat')
    expect(ai.mtd_usd).toBe('4.75') // 3.50 + 1.25 — Ani's 99.00 never leaks
    expect(ai.days).toEqual([
      { day: day(3), usd: '3.50' },
      { day: day(5), usd: '1.25' },
    ])

    const slack = res.surfaces[1]!
    expect(slack.label).toBe('Claude in Slack')
    expect(slack.mtd_usd).toBe('0.75')
    expect(slack.days).toEqual([{ day: day(4), usd: '0.75' }])
  })

  it('never folds surface spend into the §A totals (claude-code stays out of surfaces; surfaces stay out of buckets)', async () => {
    const res = await usageHandler(ev(sess(priyaId)))
    // No claude-code / copilot-cli surface rows…
    expect(res.surfaces.some((s) => s.tool === 'claude-code' || s.tool === 'copilot-cli')).toBe(false)
    // …and the zero-cost claude-design day is elided, not a $0.00 row.
    expect(res.surfaces.some((s) => s.tool === 'claude-design')).toBe(false)
  })

  it('a teammate with no surface spend gets an empty surfaces array (not an error)', async () => {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: 'oid-surf-none', email: 'none@surf.test', regionId, orgUnitId })
      .returning()
    const res = await usageHandler(ev(sess(tm!.id)))
    expect(res.surfaces).toEqual([])
  })

  it('rejects an unauthenticated caller with 401', async () => {
    await expect(usageHandler(ev())).rejects.toMatchObject({ statusCode: 401 })
  })
})
