// @vitest-environment node
/*
 * visuals-iter2 §I3 — /api/v1/me/consumption hero + provider-truth MTD, against
 * real Postgres via the REAL handler (AGENTS.md §"Never mock Drizzle").
 *
 * Conservation contract under test (design §Conservation, r1-F8):
 *   - per-lane MTD == its OWN source, one test per basis:
 *       claude (telemetry)      == Σ attribution_aggregate MTD
 *       copilot lanes (telemetry) == Σ reconciliation_record per-category MTD
 *                                    (live-row lifecycle: superseded excluded)
 *       billed lanes            == Σ actual_spend per non-Code surface MTD
 *   - NO cross-basis scalar exists anywhere in the payload;
 *   - provider_truth.mtd_usd == Σ actual_spend (non-copilot tools) + Σ copilot
 *     reconciliation usage — and a copilot-cli row smuggled into actual_spend
 *     never double-counts (the mig-0086 exclusion);
 *   - grain conservation: hero claude weekly Σ == the daily series Σ (same
 *     window, same source);
 *   - requester-scoped: another teammate's rows never leak; RBAC: 401 unauth.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import consumptionHandler from '../../../server/api/v1/me/consumption.get'
import type { HeroBasisGroup } from '../../../server/utils/me-queries'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let priyaId = ''
let aniId = ''
// Freshness (LEAST) fixtures — see the provider-feed freshness describe.
let staleAnthId = ''
let soloGhId = ''
let emptyId = ''
const INSTANCE = randomUUID()
/** The stale Anthropic pull's age: 3 days = 4320 minutes. */
const STALE_MS = 3 * 86_400_000
const STALE_MIN = STALE_MS / 60_000

function ev(session?: Session) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: '/x?window=30',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/x?window=30',
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
  return e as unknown as Parameters<typeof consumptionHandler>[0]
}

const sess = (teammateId: string): Session =>
  ({
    teammateId,
    email: 'p@hero.test',
    displayName: 'P',
    role: 'developer',
    regionId,
    orgPath: 'hero',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

// Seeds anchored to TODAY (UTC) so every row lands in the current month AND
// the 30d window on any calendar date (the consumption-readmodel convention).
const now = new Date()
const todayIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  .toISOString()
  .slice(0, 10)

async function spend(teammateId: string, tool: string, costUsd: string, onDay = todayIso) {
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

async function recon(
  teammateId: string,
  category: 'copilot_interactive' | 'copilot_coding_agent',
  actualUsd: string,
  status: 'proposed' | 'applied' | 'superseded',
  onDay = todayIso,
) {
  await t.db.insert(schema.reconciliationRecord).values({
    teammateId,
    provider: 'github',
    enterpriseRef: 'ent-hero',
    periodDate: onDay,
    category,
    scope: 'teammate',
    regionId,
    orgUnitId,
    actualUsd,
    otelAttributedUsd: '0',
    deltaUsd: actualUsd,
    spendClass: 'billed',
    disposition: 'ingest_only',
    status,
  })
}

// Seeded expectations (independent of the handler's SQL).
const CLAUDE_ATTRIBUTED = 3.0 // 3 × $1.00 attribution rows → aggregate
const COPILOT_INTERACTIVE = 7.5 // 5.00 applied + 2.50 proposed (99 superseded excluded)
const COPILOT_AGENT = 4.0
const CLAUDE_AI = 43.07 // 33.07 + 10.00
const CLAUDE_COWORK = 17.16
const CLAUDE_CODE_BILL = 3.1 // actual_spend claude-code (provider truth ≠ attributed 3.00)
const PROVIDER_TRUTH =
  CLAUDE_CODE_BILL + COPILOT_INTERACTIVE + COPILOT_AGENT + CLAUDE_AI + CLAUDE_COWORK // 74.83

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'hero-test-secret-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'hero-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'hero', displayName: 'Hero' }).returning()
  regionId = r!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'hero', code: 'hero', displayName: 'Hero', unitType: 'bu' })
    .returning()
  orgUnitId = bu!.id
  const mk = async (oid: string, email: string) => {
    const [tm] = await t.db.insert(schema.teammate).values({ entraOid: oid, email, regionId, orgUnitId }).returning()
    return tm!.id
  }
  priyaId = await mk('oid-hero-p', 'p@hero.test')
  aniId = await mk('oid-hero-a', 'a@hero.test')

  // §A telemetry: 3 attribution rows for priya at noon today → the aggregate.
  await t.db.insert(schema.instanceAttestation).values({
    instanceId: INSTANCE,
    principalOid: 'oid-hero-p',
    teammateId: priyaId,
    projectCodeHash: 'h-hero',
    rawProjectCode: 'HERO',
    tool: 'claude-code',
    sessionTokenHash: 'tok-hero-' + INSTANCE,
    tsStart: new Date(),
    regionId,
    orgUnitId,
    costOwningUnitId: orgUnitId,
  })
  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  const anchorMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12)
  for (let i = 0; i < 3; i++) {
    await t.db.insert(schema.attributionRecord).values({
      instanceId: INSTANCE,
      claudeSessionId: `conv-hero-${i}`,
      teammateId: priyaId,
      projectId: null,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-fable-5',
      tokenType: 'input',
      tokens: 1_000n,
      costUsd: '1.000000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(anchorMs - (i + 1) * 60_000),
      sourceRunId: `run-${i}`,
    })
  }
  await runAggregateRollup(t.db)

  // §A copilot usage truth (reconciliation_record): live rows + a superseded
  // decoy on the SAME logical key as the applied interactive row.
  await recon(priyaId, 'copilot_interactive', '99.00', 'superseded')
  await recon(priyaId, 'copilot_interactive', '5.00', 'applied')
  const yesterdayIso = new Date(Date.parse(todayIso) - 86_400_000).toISOString().slice(0, 10)
  // Yesterday may fall in the previous month on the 1st — month-clamp it.
  const inMonthDay = yesterdayIso.slice(0, 7) === todayIso.slice(0, 7) ? yesterdayIso : todayIso
  await recon(priyaId, 'copilot_interactive', '2.50', 'proposed', inMonthDay)
  await recon(priyaId, 'copilot_coding_agent', '4.00', 'applied')

  // §B provider bill: non-Code surfaces + the claude-code bill line, plus a
  // copilot-cli row smuggled into actual_spend (must NOT double-count).
  await spend(priyaId, 'claude-ai', '33.07')
  await spend(priyaId, 'claude-ai', '10.00', inMonthDay)
  await spend(priyaId, 'claude-cowork', '17.16')
  await spend(priyaId, 'claude-code', '3.10')
  await spend(priyaId, 'copilot-cli', '99.00')

  // Another teammate's rows — must never leak into priya's payload.
  await spend(aniId, 'claude-ai', '100.00')
  await recon(aniId, 'copilot_interactive', '50.00', 'applied')

  // Freshness (LEAST — stalest sub-feed wins) fixtures:
  //   staleAnthId — a 3-day-old Anthropic pull BESIDE a fresh GitHub pull
  //                 (the fresh sibling must not hide the stale one);
  //   soloGhId    — GitHub only (LEAST skips the NULL Anthropic operand);
  //   emptyId     — neither feed (leg is null).
  staleAnthId = await mk('oid-hero-s', 's@hero.test')
  soloGhId = await mk('oid-hero-g', 'g@hero.test')
  emptyId = await mk('oid-hero-e', 'e@hero.test')
  await t.db.insert(schema.actualSpend).values({
    teammateId: staleAnthId,
    date: todayIso,
    tool: 'claude-ai',
    inputTokens: 1n,
    outputTokens: 1n,
    costUsd: '1.00',
    source: 'anthropic-analytics-api',
    pulledAt: new Date(Date.now() - STALE_MS),
  })
  await recon(staleAnthId, 'copilot_interactive', '1.00', 'applied') // fresh computed_at
  await recon(soloGhId, 'copilot_interactive', '1.00', 'applied') // fresh computed_at
})

afterAll(async () => {
  await stopTestDb(t)
})

type Resp = Awaited<ReturnType<typeof consumptionHandler>>

async function fetchPage(): Promise<Resp> {
  return await consumptionHandler(ev(sess(priyaId)))
}

const groupOf = (resp: Resp, id: string): HeroBasisGroup => {
  const g = resp.hero.groups.find((x: HeroBasisGroup) => x.id === id)
  expect(g).toBeDefined()
  return g!
}
const laneMtd = (g: HeroBasisGroup, lane: string) =>
  Number(g.lanes.find((l) => l.lane === lane)?.mtd_usd ?? NaN)

describe('/me/consumption hero — per-lane MTD == its own source (per basis)', () => {
  it('telemetry basis: claude lane MTD == Σ attribution_aggregate MTD (never the bill)', async () => {
    const resp = await fetchPage()
    const tel = groupOf(resp, 'telemetry')
    expect(laneMtd(tel, 'claude')).toBeCloseTo(CLAUDE_ATTRIBUTED, 6)
    // Distinct from the provider's claude-code bill line ($3.10) — the lane is
    // attributed telemetry, not §B.
    expect(laneMtd(tel, 'claude')).not.toBeCloseTo(CLAUDE_CODE_BILL, 6)
  })

  it('telemetry basis: copilot lanes MTD == reconciliation usage truth (lifecycle-aware)', async () => {
    const resp = await fetchPage()
    const tel = groupOf(resp, 'telemetry')
    expect(laneMtd(tel, 'copilot')).toBeCloseTo(COPILOT_INTERACTIVE, 6) // superseded 99 excluded
    expect(laneMtd(tel, 'copilot-agent')).toBeCloseTo(COPILOT_AGENT, 6)
  })

  it('billed basis: each non-Code surface MTD == Σ actual_spend; §A tools never appear', async () => {
    const resp = await fetchPage()
    const billed = groupOf(resp, 'billed')
    expect(laneMtd(billed, 'claude-ai')).toBeCloseTo(CLAUDE_AI, 6)
    expect(laneMtd(billed, 'claude-cowork')).toBeCloseTo(CLAUDE_COWORK, 6)
    const lanes = billed.lanes.map((l) => l.lane)
    expect(lanes).not.toContain('claude-code')
    expect(lanes).not.toContain('copilot-cli')
    expect(lanes).not.toContain('copilot')
    expect(lanes).not.toContain('claude-slack') // zero surface elided
  })

  it('NO cross-basis scalar exists in the hero payload (r1-F1)', async () => {
    const resp = await fetchPage()
    // The hero carries groups + lanes + the as_of anchor only — no total field
    // at any level. as_of is the SERVER's UTC today (the client's partial-week
    // anchor — the page never calls `new Date()`, iter2 r1).
    expect(Object.keys(resp.hero).sort()).toEqual(['as_of', 'groups', 'window_days'])
    expect(resp.hero.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (const g of resp.hero.groups) {
      expect(Object.keys(g).sort()).toEqual(['basis', 'id', 'label', 'lanes'])
    }
  })
})

describe('/me/consumption — provider-truth MTD (the one honest number)', () => {
  it('equals Σ actual_spend (non-copilot) + Σ copilot reconciliation usage', async () => {
    const resp = await fetchPage()
    expect(Number(resp.provider_truth.mtd_usd)).toBeCloseTo(PROVIDER_TRUTH, 2)
  })

  it('a copilot-cli row in actual_spend never double-counts (mig-0086 exclusion)', async () => {
    const resp = await fetchPage()
    // The smuggled $99 copilot-cli actual_spend row is excluded — copilot
    // truth comes from reconciliation only.
    expect(Number(resp.provider_truth.mtd_usd)).toBeLessThan(PROVIDER_TRUTH + 99)
    expect(Number(resp.provider_truth.mtd_usd)).toBeCloseTo(PROVIDER_TRUTH, 2)
  })

  it('run-rate is computed on the provider-truth MTD', async () => {
    const resp = await fetchPage()
    const rr = resp.provider_truth.run_rate
    const expected = (PROVIDER_TRUTH * rr.days_in_month) / rr.days_elapsed
    expect(Number(rr.projected_month_end_usd)).toBeCloseTo(expected, 1)
  })
})

describe('/me/consumption hero — grain conservation (weekly Σ == daily Σ)', () => {
  it('hero claude weekly Σ == the daily series Σ (same window, same source)', async () => {
    const resp = await fetchPage()
    const tel = groupOf(resp, 'telemetry')
    const weeklySum = tel.lanes
      .find((l) => l.lane === 'claude')!
      .weekly.reduce((a, w) => a + Number(w.usd), 0)
    const dailySum = resp.series.reduce((a: number, d: { cost_usd: string }) => a + Number(d.cost_usd), 0)
    expect(weeklySum).toBeCloseTo(dailySum, 6)
  })
})

describe('/me/consumption — scoping, freshness, RBAC', () => {
  it("another teammate's spend never leaks into the requester's hero or MTD", async () => {
    const resp = await fetchPage()
    const billed = groupOf(resp, 'billed')
    // Ani's $100 claude-ai and $50 copilot are absent everywhere.
    expect(laneMtd(billed, 'claude-ai')).toBeCloseTo(CLAUDE_AI, 6)
    expect(laneMtd(groupOf(resp, 'telemetry'), 'copilot')).toBeCloseTo(COPILOT_INTERACTIVE, 6)
    expect(Number(resp.provider_truth.mtd_usd)).toBeCloseTo(PROVIDER_TRUTH, 2)
  })

  it('page_freshness carries the provider-feed leg and a worst-of value', async () => {
    const resp = await fetchPage()
    const f = resp.page_freshness
    expect(f.provider_feed_minutes_ago).not.toBeNull()
    expect(f.provider_feed_minutes_ago).toBeGreaterThanOrEqual(0)
    expect(f.worst_minutes_ago).not.toBeNull()
    const legs = [f.telemetry_minutes_ago, f.aggregate_minutes_ago, f.provider_feed_minutes_ago].filter(
      (m): m is number => m != null,
    )
    expect(f.worst_minutes_ago).toBe(Math.max(...legs))
  })

  it('rejects an unauthenticated request (401)', async () => {
    await expect(consumptionHandler(ev())).rejects.toMatchObject({ statusCode: 401 })
  })
})

describe('/me/consumption — provider-feed freshness = STALEST sub-feed (LEAST, iter2 r1)', () => {
  const fetchAs = async (id: string) => await consumptionHandler(ev(sess(id)))

  it('a fresh GitHub pull never hides a 3-day-old Anthropic pull; page worst-of reflects it', async () => {
    const resp = await fetchAs(staleAnthId)
    const f = resp.page_freshness
    // The stale Anthropic pull (~4320m) wins over the fresh GitHub sibling (~0m).
    expect(f.provider_feed_minutes_ago).toBeGreaterThanOrEqual(STALE_MIN)
    expect(f.provider_feed_minutes_ago).toBeLessThanOrEqual(STALE_MIN + 5)
    // …and the page-level worst-of-sources line surfaces exactly this leg.
    expect(f.worst_minutes_ago).toBe(f.provider_feed_minutes_ago)
  })

  it('one feed absent → the other feed wins (Postgres LEAST skips NULL operands)', async () => {
    const resp = await fetchAs(soloGhId)
    const m = resp.page_freshness.provider_feed_minutes_ago
    expect(m).not.toBeNull()
    expect(m).toBeLessThanOrEqual(5) // the fresh GitHub pull, minutes-old at most
  })

  it('both feeds absent → null (no provider feed has landed anything yet)', async () => {
    const resp = await fetchAs(emptyId)
    expect(resp.page_freshness.provider_feed_minutes_ago).toBeNull()
  })
})
