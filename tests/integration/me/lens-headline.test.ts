// @vitest-environment node
/*
 * ADR 0012 — the personal-surface LENS seam (server/utils/me-lens.ts).
 *
 * The defect this closes was a cross-lane quotient: on /usage a
 * "Quota used 221%" bar sat beside a "$1,449.70" headline, where the 221% was
 * `6,846.35 / 3,100` — the OTHER lane's numerator, deliberately hidden to
 * satisfy a "one MTD scalar" rule while its quotient still rendered.
 *
 * `buildMeHeadline` makes that unrepresentable rather than merely forbidden:
 * it returns ONE figure and every statistic derived from it, so a caller cannot
 * pair the scalar of one lane with the quotient of another. These tests hold it
 * to that, and to the ADR's other server-side commitments:
 *
 *   D1 — usage is the default lens, and it is the §A attributed figure;
 *   D2 — the billing figure exists but only under a selected lens;
 *   D4 — no quota under the chargeback lens (a quota measures attributed usage);
 *   D5 — the declared-personal disclosure is a genuine subset of the figure it
 *        explains, and "material" means what the over-emission detector means.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import homeHandler from '../../../server/api/v1/me/home.get'
import usageHandler from '../../../server/api/v1/me/usage.get'
import {
  buildMeHeadline,
  buildMeLensDisclosure,
  classifyToolGap,
  gapIsMaterial,
  getMyChargeableMtd,
  getMyDeclaredPersonal,
  getMyToolGaps,
} from '../../../server/utils/me-lens'
import {
  OVER_EMISSION_MIN_USD,
  OVER_EMISSION_NO_BILL_FLOOR_USD,
  OVER_EMISSION_REL,
} from '../../../server/usage/over-emission-detection'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let otherTeammateId = ''
let projectId = ''
let instanceId = ''

/** Fixed clock: mid-month, so "later this month" is a reachable state. */
const NOW = new Date('2026-06-15T12:00:00.000Z')
const MONTH = '2026-06'

/** A minimal h3 event carrying `url` (so `getQuery` sees `?lane=`) + a session. */
function ev(session: Session, url: string) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url,
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof homeHandler>[0]
}

const sess = (): Session =>
  ({
    teammateId,
    email: 'ml@x.test',
    displayName: 'ML',
    role: 'developer',
    regionId,
    orgPath: 'ml',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'lens-headline-test-padded-to-32-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'lens-headline-test-hmac-key-padded-beyond-32-chars'
  const [r] = await t.db.insert(schema.region).values({ code: 'ml', displayName: 'ML' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'ml',
      code: 'ml-bu',
      displayName: 'ML',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  orgUnitId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ml', email: 'ml@x.test', displayName: 'ML', regionId, orgUnitId })
    .returning()
  teammateId = tm!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-ml2', email: 'ml2@x.test', displayName: 'ML2', regionId, orgUnitId })
    .returning()
  otherTeammateId = other!.id
  const [pr] = await t.db
    .insert(schema.project)
    .values({
      code: 'ml-proj',
      codeHash: 'h-ml-proj',
      displayName: 'ML Project',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = pr!.id

  await t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p-ml', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${orgUnitId}::uuid, 'h', 'P')`
  const [inst] = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
  instanceId = inst!.id
})

afterAll(async () => {
  await stopTestDb(t)
})

/**
 * An OTel emission (the §A arm the usage lens totals). `project` = false emits
 * UNALLOCATED spend — the lane that sits outside the budgeted headline and has
 * its own soft cap on the dashboard.
 */
async function emit(
  tsIso: string,
  costUsd: number,
  session: string,
  opts: { tool?: string; project?: boolean } = {},
): Promise<void> {
  const project = opts.project === false ? null : projectId
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type,
       tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${teammateId}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
            ${project}::uuid, ${opts.tool ?? 'claude-code'}, 'claude-sonnet-4-6', 'input', 100, ${costUsd},
            'tier-1', 'estimated', ${tsIso}::timestamptz, ${session})`
}

/** A provider bill row (the §B arm the chargeback lens totals). */
async function bill(
  day: string,
  costUsd: number,
  opts: {
    tool?: string
    exempt?: boolean
    teammate?: string
    /**
     * WHY the row is exempt. Only `governance:tracked` means "the org's
     * agreement says do not bill this" — `unresolved` means the governance key
     * could not be resolved, which is not evidence of an NFR agreement.
     */
    source?: string
  } = {},
): Promise<void> {
  await t.db.insert(schema.actualSpend).values({
    teammateId: opts.teammate ?? teammateId,
    date: day,
    tool: opts.tool ?? 'claude-code',
    inputTokens: BigInt(10),
    outputTokens: BigInt(10),
    costUsd: String(costUsd),
    chargebackExempt: opts.exempt ?? false,
    ...(opts.source ? { governanceVerdictSource: opts.source } : {}),
  })
}

const headline = (lane: 'usage' | 'chargeback', usd: string) =>
  buildMeHeadline(t.db, {
    teammateId,
    lane,
    attributedUsageUsd: usd,
    baseAllowanceUsd: '100.00',
    allocationUsd: '3000.00',
    quotaUsd: '3100.00',
    now: NOW,
  })

describe('the chargeback figure (§B cost of record, per teammate)', () => {
  beforeAll(async () => {
    await bill('2026-06-02', 6.12)
    await bill('2026-06-03', 500, { exempt: true }) // NFR / exempt — showback only
    await bill('2026-06-04', 250, { tool: 'copilot-cli' }) // §A tool: firewalled out
    await bill('2026-06-05', 999, { teammate: otherTeammateId }) // someone else's bill
    await bill('2026-05-31', 40) // last month
    await bill('2026-06-20', 70) // later this month
  })

  it('totals only this teammate’s chargeable Anthropic bill, month to date', async () => {
    expect(Number(await getMyChargeableMtd(t.db, teammateId, NOW))).toBeCloseTo(6.12, 2)
  })

  it('excludes chargeback-exempt rows — NFR is showback, never a charge', async () => {
    // The $500 exempt row would be the dominant figure if the view were showback.
    expect(Number(await getMyChargeableMtd(t.db, teammateId, NOW))).toBeLessThan(500)
  })

  it('excludes the GitHub lanes — Copilot §B is pooled per cost centre, not per person', async () => {
    expect(Number(await getMyChargeableMtd(t.db, teammateId, NOW))).toBeLessThan(250)
  })

  it("never totals another teammate's bill", async () => {
    expect(Number(await getMyChargeableMtd(t.db, otherTeammateId, NOW))).toBeCloseTo(999, 2)
    expect(Number(await getMyChargeableMtd(t.db, teammateId, NOW))).toBeCloseTo(6.12, 2)
  })

  it('is month-TO-DATE: a row dated later this month is not spent yet', async () => {
    // 6.12 alone, not 76.12 — the same bound the §A seam took in PR #217.
    expect(Number(await getMyChargeableMtd(t.db, teammateId, NOW))).toBeCloseTo(6.12, 2)
  })
})

describe('buildMeHeadline — one figure, and everything beside it derived from it', () => {
  it('defaults to §A attributed usage, with the quota measured against THAT figure', async () => {
    const h = await headline('usage', '6846.35')
    expect(h.lane).toBe('usage')
    expect(h.month).toBe(MONTH)
    expect(h.mtd_usd).toBe('6846.35')
    expect(h.quota).not.toBeNull()
    expect(h.quota!.total_usd).toBe('3100.00')
    // 6846.35 / 3100 = 221% — the quotient the UI renders, now over the figure
    // it prints beside it rather than over the other lane's.
    expect(Number(h.mtd_usd) / Number(h.quota!.total_usd)).toBeCloseTo(2.209, 2)
    expect(h.quota!.projection).toEqual({ state: 'exhausted', over_usd: '3746.35' })
  })

  it('derives the run rate from its OWN mtd_usd, in both lanes', async () => {
    const usage = await headline('usage', '6846.35')
    const charge = await headline('chargeback', '6846.35')
    // Day 15 of 30 → 2x. Each lane scales its own figure and never the other's.
    expect(Number(usage.run_rate.projected_month_end_usd)).toBeCloseTo(6846.35 * 2, 1)
    expect(Number(charge.run_rate.projected_month_end_usd)).toBeCloseTo(
      Number(charge.mtd_usd) * 2,
      2,
    )
    expect(charge.mtd_usd).not.toBe(usage.mtd_usd)
  })

  it('carries NO quota under the chargeback lens (D4)', async () => {
    /*
     * The whole defect in one field. A quota is allowance + allocations
     * measured against attributed usage; handing the UI a quota alongside a §B
     * scalar is handing it the two operands of the cross-lane quotient.
     */
    const h = await headline('chargeback', '6846.35')
    expect(h.lane).toBe('chargeback')
    expect(h.quota).toBeNull()
    expect(Number(h.mtd_usd)).toBeCloseTo(6.12, 2)
  })

  it('the chargeback headline IS the chargeable read — not a re-labelled usage figure', async () => {
    const h = await headline('chargeback', '6846.35')
    expect(h.mtd_usd).toBe(await getMyChargeableMtd(t.db, teammateId, NOW))
  })
})

describe('the declared-personal disclosure (D5)', () => {
  /** Budgeted §A usage on the declared tool — inside the usage-lens headline. */
  const BUDGETED = 6800
  /** UNALLOCATED §A usage on the SAME tool — outside it, with its own soft cap. */
  const UNALLOCATED = 120.94

  beforeAll(async () => {
    await emit('2026-06-10T00:00:00.000Z', BUDGETED, 'sess-a')
    await emit('2026-06-11T00:00:00.000Z', UNALLOCATED, 'sess-unalloc', { project: false })
    await t.client`INSERT INTO personal_subscription_declaration
        (teammate_id, tool, subscription_type, monthly_cost_usd, declared_at)
      VALUES (${teammateId}::uuid, 'claude-code', 'Claude Max 20', 200, '2026-05-30T09:00:00Z')`
  })

  it('covers only the time the declaration was ACTIVE, not the whole month', async () => {
    /*
     * A declaration made on the 30th must not claim what was spent on the 1st.
     * The window was bounded by the MONTH alone, so declaring a Max plan late
     * retroactively relabelled every dollar since the 1st as personal — the
     * reader is told $6,800 sits on a subscription that did not exist for most
     * of those days, and the figure feeds the disclosure decision 5 owes them.
     *
     * The admin view already intersected the declaration's own interval
     * (admin/governance/personal-subscriptions.get.ts) — a sibling that was
     * right while this one was wrong. Found by external review.
     */
    await t.client`UPDATE personal_subscription_declaration
                      SET declared_at = '2026-06-10T12:00:00Z'
                    WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    try {
      const [late] = await getMyDeclaredPersonal(t.db, teammateId, NOW)
      // The 10th at 00:00 is BEFORE the declaration; the 11th is after it.
      expect(Number(late!.usage_mtd_usd)).toBeCloseTo(UNALLOCATED, 2)
      expect(Number(late!.usage_mtd_usd)).not.toBeCloseTo(BUDGETED + UNALLOCATED, 2)
    } finally {
      await t.client`UPDATE personal_subscription_declaration
                        SET declared_at = '2026-05-30T09:00:00Z'
                      WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    }
    // Guard the guard: restored, the same call sees the whole month again, so
    // the assertion above pins the INTERVAL rather than a permanently small sum.
    const [back] = await getMyDeclaredPersonal(t.db, teammateId, NOW)
    expect(Number(back!.usage_mtd_usd)).toBeCloseTo(BUDGETED + UNALLOCATED, 2)
  })

  it('a declaration dated in the FUTURE does not render a $0.00 row', async () => {
    /*
     * The interval fix bounded the USAGE but not the row: a declaration dated
     * after the window still returned, its subquery empty and its COALESCE
     * reporting $0.00 — a plan that has not started, quoting zero as if it
     * were a measurement.
     */
    await t.client`UPDATE personal_subscription_declaration
                      SET declared_at = '2026-06-20T00:00:00Z'
                    WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    try {
      expect(await getMyDeclaredPersonal(t.db, teammateId, NOW)).toEqual([])
    } finally {
      await t.client`UPDATE personal_subscription_declaration
                        SET declared_at = '2026-05-30T09:00:00Z'
                      WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    }
    // Guard the guard: restored, it renders again — so the assertion pins the
    // overlap predicate and not a permanently empty result.
    expect((await getMyDeclaredPersonal(t.db, teammateId, NOW)).length).toBe(1)
  })

  it('a revoked declaration disappears entirely — there is no partial-month bound', async () => {
    await t.client`UPDATE personal_subscription_declaration
                      SET revoked_at = '2026-06-10T12:00:00Z'
                    WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    try {
      /*
       * `revoked_at IS NULL` gates the ROW, so a revocation removes the
       * declaration outright rather than shortening its window. That is the
       * shipped behaviour and this pins it. It also means an upper interval
       * bound on the usage subquery would be unreachable — I wrote one, and an
       * external reviewer proved it dead by deleting it with the suite green.
       *
       * WORTH AN OWNER DECISION, not silently changed here: a plan held for ten
       * days of the month and then revoked currently discloses nothing at all
       * for those ten days.
       */
      expect(await getMyDeclaredPersonal(t.db, teammateId, NOW)).toEqual([])
    } finally {
      await t.client`UPDATE personal_subscription_declaration SET revoked_at = NULL
                      WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    }
  })

  it('names the plan, its price and the usage sitting behind it', async () => {
    const [d] = await getMyDeclaredPersonal(t.db, teammateId, NOW)
    expect(d!.tool).toBe('claude-code')
    expect(d!.label).toBe('Claude Code')
    expect(d!.subscription_type).toBe('Claude Max 20')
    expect(d!.monthly_cost_usd).toBe('200.00')
    /*
     * BUDGETED **plus** UNALLOCATED — every §A row for the declared tool.
     *
     * It used to be budgeted only, justified by the usage-lens headline being
     * the sum of the developer's project buckets. Decision 1a retired that: both
     * callers of buildMeLensDisclosure now pass budgeted + unallocated, so a
     * clamped declared figure would understate the declared-personal share of
     * the very number it is printed under, and understate it by exactly the
     * unallocated Claude spend a personal subscription is most likely to carry.
     */
    expect(Number(d!.usage_mtd_usd)).toBeCloseTo(BUDGETED + UNALLOCATED, 2)
    // Guard the guard: the two are genuinely different numbers in this fixture,
    // so the assertion above is a choice between bases and not a tautology.
    expect(UNALLOCATED).toBeGreaterThan(0)
    expect(Number(d!.usage_mtd_usd)).not.toBeCloseTo(BUDGETED, 2)
  })

  it('is a genuine SUBSET of the figure it is rendered under', async () => {
    /*
     * The disclosure says "$X of this month's attributed usage is on <tool>".
     * X and the figure above it therefore have to be measured on ONE basis, and
     * since decision 1a that basis is ALL of the developer's §A usage this
     * month — budgeted plus unallocated. Measuring X over every §A row while the
     * figure above it counted only project buckets would have quoted a number
     * LARGER than the one it explains; measuring it over project buckets while
     * the figure above counts everything quotes one that is too small.
     *
     * This fixture makes both errors reachable: the same tool carries budgeted
     * spend AND unallocated spend in the same month.
     */
    const [all] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM v_complete_usage
       WHERE teammate_id = ${teammateId}::uuid
         AND ts_event >= '2026-06-01T00:00:00.000Z'::timestamptz
         AND ts_event <  ${NOW.toISOString()}::timestamptz`
    const [budgeted] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total
        FROM v_complete_usage
       WHERE teammate_id = ${teammateId}::uuid
         AND project_id IS NOT NULL
         AND ts_event >= '2026-06-01T00:00:00.000Z'::timestamptz
         AND ts_event <  ${NOW.toISOString()}::timestamptz`
    // The two bases really are different here, or neither assertion below bites.
    expect(Number(all!.total)).toBeGreaterThan(Number(budgeted!.total))

    const disclosure = await buildMeLensDisclosure(t.db, {
      teammateId,
      // What BOTH endpoints pass: budgeted + unallocated (see
      // server/api/v1/me/home.get.ts and .../usage.get.ts).
      attributedUsageUsd: all!.total,
      providerReportedUsd: '1449.70',
      now: NOW,
    })
    expect(Number(disclosure.declared_personal_usage_usd)).toBeLessThanOrEqual(
      Number(disclosure.attributed_usage_usd) + 0.005,
    )
    // …and not trivially a subset by being far too small: the declared tool is
    // the only tool in this fixture, so it accounts for the whole figure.
    expect(Number(disclosure.declared_personal_usage_usd)).toBeCloseTo(
      Number(disclosure.attributed_usage_usd),
      2,
    )
  })

  it('a revoked declaration disappears from the disclosure', async () => {
    await t.client`UPDATE personal_subscription_declaration SET revoked_at = now()
                    WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    try {
      expect(await getMyDeclaredPersonal(t.db, teammateId, NOW)).toEqual([])
    } finally {
      await t.client`UPDATE personal_subscription_declaration SET revoked_at = NULL
                      WHERE teammate_id = ${teammateId}::uuid AND tool = 'claude-code'`
    }
  })

  it('carries all three quantities so the reader can see WHY they differ', async () => {
    const d = await buildMeLensDisclosure(t.db, {
      teammateId,
      attributedUsageUsd: '6846.35',
      providerReportedUsd: '1449.70',
      now: NOW,
    })
    expect(d.attributed_usage_usd).toBe('6846.35')
    expect(d.provider_reported_usd).toBe('1449.70')
    expect(Number(d.chargeable_usd)).toBeCloseTo(6.12, 2)
    // ...and the tool behind the gap is named, classified against its OWN
    // declaration rather than an account-wide verdict.
    const claude = d.tool_gaps.find((g) => g.tool === 'claude-code')!
    expect(claude.state).toBe('declared')
    expect(gapIsMaterial(Number(claude.attributed_usage_usd), Number(claude.provider_reported_usd)))
      .toBe(true)
  })
})

/*
 * The endpoint fixtures' current-month amounts. Declared at module scope because
 * two describes below read the SAME seeded rows — a second copy of these numbers
 * is a second thing to keep in step with one beforeAll.
 *
 * The handlers window on the RUNTIME clock, not the fixed NOW the seam tests pass
 * in, so they need their own current-month rows. All three figures differ so the
 * lanes are distinguishable: if an endpoint ever answered the chargeback lane
 * with the §A total (a silent substitution), $250 would show up where $6.12
 * belongs.
 */
const CURRENT_ATTRIBUTED = 250
const CURRENT_UNALLOCATED = 17.5
const CURRENT_CHARGEABLE = 6.12

describe('the endpoints actually honour ?lane (the wiring, not just the seam)', () => {
  beforeAll(async () => {
    const now = Date.now()
    const monthStart = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      1,
    )
    // Strictly inside [month start, now) — the month-to-date window's own bound.
    const at = new Date(Math.max(monthStart, now - 3_600_000)).toISOString()
    await emit(at, CURRENT_ATTRIBUTED, 'sess-current')
    // UNALLOCATED (project: false) — spend with no project claim. Without this
    // the dashboard and /usage headlines coincide and the 1a assertion
    // below certifies nothing.
    await emit(at, CURRENT_UNALLOCATED, 'sess-current-untagged', { project: false })
    await bill(new Date(now).toISOString().slice(0, 10), CURRENT_CHARGEABLE)
  })

  it('/me/home defaults to the usage lens and carries the disclosure', async () => {
    const resp = await homeHandler(ev(sess(), '/api/v1/me/home'))
    expect(resp.headline.lane).toBe('usage')
    expect(resp.headline.quota).not.toBeNull()
    // The §A figure the hero prints IS getMyUsage's own budgeted total — one
    // source, so the hero and the buckets under it cannot disagree.
    expect(resp.headline.mtd_usd).toBe(Number(resp.total_cost_usd).toFixed(2))
    expect(resp.disclosure.declared_personal.map((d) => d.tool)).toContain('claude-code')
  })

  it('/me/home IGNORES ?lane — it is the §A surface and cannot be talked out of it', async () => {
    /*
     * This assertion is the INVERSE of the one it replaces, and the inversion
     * is the point.
     *
     * /me/home used to honour ?lane=chargeback. No surface ever sent it: Home's
     * hero is entirely §A constructs — budgets, the soft cap, pace — and under
     * the other lane the quota goes null and the page has no denominator left
     * to draw. So the endpoint could answer a question no caller asked and no
     * screen could render, and the only thing exercising it was this test.
     *
     * ADR 0012 D2 as amended forbids SILENT SUBSTITUTION, not the absence of a
     * toggle. A surface unambiguous about its lens, with a route to the other
     * one (/me/usage carries the lane), satisfies it. Home is that surface.
     *
     * Three assertions, so a reinstated parse goes red on all three rather than
     * on a lane string alone.
     */
    const resp = await homeHandler(ev(sess(), '/api/v1/me/home?lane=chargeback'))
    expect(resp.headline.lane).toBe('usage')
    expect(resp.headline.quota).not.toBeNull()
    expect(Number(resp.headline.mtd_usd)).toBeCloseTo(CURRENT_ATTRIBUTED, 2)
    /*
     * Guard the guard. If the fixture's two figures coincided, "ignored the
     * lane" and "honoured the lane" would be indistinguishable here and the
     * test above would certify nothing.
     */
    expect(CURRENT_CHARGEABLE).not.toBeCloseTo(CURRENT_ATTRIBUTED, 2)
  })

  it('/me/usage DOES carry the lane — the capability moved, it was not dropped', async () => {
    /*
     * The other half of the pair above, and the reason removing it from Home is
     * a relocation rather than a loss of function. Without this assertion the
     * test above is satisfied by deleting lane support everywhere.
     */
    const resp = await usageHandler(ev(sess(), '/api/v1/me/usage?lane=chargeback'))
    expect(resp.headline.lane).toBe('chargeback')
    expect(resp.headline.quota).toBeNull()
    expect(Number(resp.headline.mtd_usd)).toBeCloseTo(CURRENT_CHARGEABLE, 2)
  })

  it('the two surfaces headline DIFFERENT sums, and each is the right one (ADR 0012 1a)', async () => {
    /*
     * The dashboard is the TIMESHEET: its hero renders budgeted and unallocated
     * as two halves, so its headline is the BUDGETED total.
     *
     * /usage is the PATTERNS surface (D7). It has no budget axis, so it
     * has no reason to show only the budgeted slice — its headline is TOTAL
     * attributed usage, budgeted plus unallocated. A headline reading "your own
     * sessions" over a project-buckets-only figure was false.
     *
     * Both surfaces therefore account for the SAME total; one splits it, one
     * sums it. This asserts the difference is real and in the right direction —
     * with unallocated spend on the fixture, so the two figures cannot
     * coincide and the assertion cannot pass by accident.
     */
    const homeResp = await homeHandler(ev(sess(), '/api/v1/me/home'))
    const usageResp = await usageHandler(ev(sess(), '/api/v1/me/usage'))

    const budgeted = Number(homeResp.total_cost_usd)
    const unallocated = Number(homeResp.unallocated.total_cost_usd)
    // Guard the guard: with no unallocated spend the two headlines would agree
    // and this test would certify nothing.
    expect(unallocated).toBeGreaterThan(0)

    expect(Number(homeResp.headline.mtd_usd)).toBeCloseTo(budgeted, 2)
    expect(Number(usageResp.headline.mtd_usd)).toBeCloseTo(budgeted + unallocated, 2)
    expect(Number(usageResp.headline.mtd_usd)).toBeGreaterThan(
      Number(homeResp.headline.mtd_usd),
    )
  })

  it('the quota denominator contains the allowance the numerator now covers (1a)', async () => {
    /*
     * The premise of decision 1a. The component divides headline.mtd_usd by
     * quota.total_usd — that is the D4 fix, the operand IS the printed figure.
     * This pins the OTHER half: total_usd includes the base allowance, and that
     * allowance is the allowance for UNALLOCATED spend. A budgeted-only
     * numerator over a denominator containing it was mismatched, which is why
     * 1a moved the numerator rather than the label.
     */
    const resp = await usageHandler(ev(sess(), '/api/v1/me/usage'))
    const q = resp.headline.quota!
    expect(q).not.toBeNull()
    expect(Number(q.total_usd)).toBeCloseTo(
      Number(q.base_allowance_usd) + Number(q.allocation_usd),
      2,
    )
    expect(Number(q.base_allowance_usd)).toBeGreaterThan(0)
  })

  it('/me/home coerces a nonsense lane to the default rather than erroring', async () => {
    const resp = await homeHandler(ev(sess(), '/api/v1/me/home?lane=showback'))
    expect(resp.headline.lane).toBe('usage')
  })

  it('/me/usage honours ?lane alongside ?window', async () => {
    const usage = await usageHandler(ev(sess(), '/api/v1/me/usage?window=30'))
    expect(usage.headline.lane).toBe('usage')
    expect(usage.headline.quota).not.toBeNull()
    expect(usage.window_days).toBe(30)

    const charge = await usageHandler(
      ev(sess(), '/api/v1/me/usage?window=90&lane=chargeback'),
    )
    expect(charge.headline.lane).toBe('chargeback')
    expect(charge.headline.quota).toBeNull()
    expect(charge.window_days).toBe(90)
    expect(Number(charge.headline.mtd_usd)).toBeLessThan(Number(usage.headline.mtd_usd))
  })

  it('/me/usage keeps the provider figure as a reference, not a headline', async () => {
    const resp = await usageHandler(ev(sess(), '/api/v1/me/usage?window=30'))
    // Still on the payload (its conservation invariants are pinned elsewhere),
    // and it is what the disclosure quotes — but the headline is §A.
    expect(resp.disclosure.provider_reported_usd).toBe(
      Number(resp.provider_truth.mtd_usd).toFixed(2),
    )
    expect(resp.headline.mtd_usd).not.toBe(resp.provider_truth.mtd_usd)
  })
})

describe('/usage headlines COMPLETE §A usage, not just arms 1 and 2', () => {
  /*
   * ADR 0012 decision 1a says the patterns surface headlines TOTAL attributed
   * usage. "Total" was arms 1 and 2 only: the unallocated read was hand-rolled
   * off `attribution_record` UNION `unaccounted_usage`, so the third §A arm
   * (mig 0101 — usage that can never be OTel-emitted or reconciled into a
   * taggable row) reached the reporting surfaces and never the developer's own
   * headline. Asserted through the ENDPOINT, on the runtime clock, because the
   * seam-level tests cannot see a handler summing the wrong two operands.
   *
   * The CODING-AGENT lane is the fixture on purpose. It is arm-3 usage whose §B
   * bill is pooled per cost centre and firewalled out of the per-person
   * chargeable view (mig 0085), so it moves the usage lane and must leave the
   * chargeback lane untouched — which makes the two independently readable in
   * one fixture.
   */
  const AGENT_USD = 31.25

  beforeAll(async () => {
    const day = new Date().toISOString().slice(0, 10)
    await t.client`INSERT INTO reconciliation_record
        (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id,
         cost_owning_unit_id, actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd,
         spend_class, disposition, status)
      VALUES (${teammateId}::uuid, 'github', 'ent-ml', ${day}::date, 'copilot_coding_agent',
              'teammate', ${regionId}::uuid, ${orgUnitId}::uuid, ${orgUnitId}::uuid,
              '12', 'ai-credits', ${String(AGENT_USD)}, '0', ${String(AGENT_USD)},
              'indicative', 'ingest_only', 'proposed')`
  })

  it('the untaggable arm lands in the unallocated summary, and not in the queue', async () => {
    const resp = await homeHandler(ev(sess(), '/api/v1/me/home'))
    expect(Number(resp.unallocated.untaggable_cost_usd)).toBeCloseTo(AGENT_USD, 2)
    // It is real unallocated usage…
    expect(Number(resp.unallocated.total_cost_usd)).toBeCloseTo(
      CURRENT_UNALLOCATED + AGENT_USD,
      2,
    )
    // …and it is NOT work the developer owes: there is no session and no
    // `unaccounted_usage` row on it to attach a project or an activity to.
    // (The Copilot-agent half IS sourced from reconciliation_record — the row it
    // lacks is the taggable one, not a reconciled one.)
    expect(Number(resp.unallocated.untagged_cost_usd)).toBeCloseTo(CURRENT_UNALLOCATED, 2)
    expect(Number(resp.unallocated.untagged_cost_usd)).not.toBeCloseTo(
      CURRENT_UNALLOCATED + AGENT_USD,
      2,
    )
    // Guard the guard: the queue is non-empty, so "arm 3 stayed out of it" is a
    // claim that can fail rather than one an empty queue satisfies for free.
    expect(resp.unallocated.needs_tagging_count).toBeGreaterThan(0)
  })

  it('the headline is the sum that includes it', async () => {
    const homeResp = await homeHandler(ev(sess(), '/api/v1/me/home'))
    const usageResp = await usageHandler(ev(sess(), '/api/v1/me/usage'))

    const budgeted = Number(homeResp.total_cost_usd)
    const unallocated = Number(homeResp.unallocated.total_cost_usd)
    const untaggable = Number(homeResp.unallocated.untaggable_cost_usd)
    expect(untaggable).toBeGreaterThan(0)

    expect(Number(usageResp.headline.mtd_usd)).toBeCloseTo(budgeted + unallocated, 2)
    // Arms 1 + 2 alone — the figure this surface reported before the third arm
    // was read, and a real amount short rather than a rounding difference.
    expect(Number(usageResp.headline.mtd_usd)).not.toBeCloseTo(
      budgeted + unallocated - untaggable,
      2,
    )
  })

  it('leaves the chargeback lane alone — §A completeness is not a §B change', async () => {
    /*
     * Copilot is billed POOLED per cost centre, so `v_finance_bill_chargeback`
     * excludes the whole GitHub lane set (mig 0085). The fixture's entire
     * chargeable month is $6.12 and this arm is $31.25, so a leak across the
     * lanes would put the chargeback headline above the arm's own amount.
     */
    const charge = await usageHandler(ev(sess(), '/api/v1/me/usage?lane=chargeback'))
    expect(charge.headline.lane).toBe('chargeback')
    expect(Number(charge.headline.mtd_usd)).toBeLessThan(AGENT_USD)
    expect(Number(charge.headline.mtd_usd)).toBeCloseTo(CURRENT_CHARGEABLE, 2)
  })
})

describe('"material" means what the over-emission detector means', () => {
  it('uses the detector’s own floor and ratio, not a second threshold', () => {
    // Just under the relative gate (over must EXCEED 1.0 x reported).
    expect(gapIsMaterial(2 * 1000, 1000)).toBe(false)
    expect(gapIsMaterial(2 * 1000 + 0.01, 1000)).toBe(true)
    // The absolute floor still applies when the reported figure is tiny but REAL.
    // over must EXCEED the floor: 26 - 0.01 = 25.99 > 25.
    expect(gapIsMaterial(26, 0.01)).toBe(true)
    expect(gapIsMaterial(OVER_EMISSION_MIN_USD, 0.01)).toBe(false)
    // And it is derived from the constants, not a copy of their values.
    expect(gapIsMaterial(OVER_EMISSION_REL * 40 + 40 + 0.01, 40)).toBe(true)
    // The real case: 4.72x with a declared subscription behind it.
    expect(gapIsMaterial(6846.35, 1449.7)).toBe(true)
  })

  it('is NOT material when the provider reported nothing at all (ADR 0012 5a)', () => {
    /*
     * The detector requires api_usd > 0 DELIBERATELY: an unreconciled provider
     * org reports $0, indistinguishable from "spent nothing". Without the same
     * guard the disclosure fires while the detector stays silent, and the copy
     * promising such days "are raised for review" is false.
     *
     * This assertion previously ran the OTHER way — it asserted material at
     * providerReported === 0, under a describe claiming agreement with the
     * detector. It disagreed with the detector at exactly that input.
     */
    expect(gapIsMaterial(300, 0)).toBe(false)
    expect(gapIsMaterial(1e6, 0)).toBe(false)
    // A single cent of provider truth is enough to make the comparison real.
    expect(gapIsMaterial(300, 0.01)).toBe(true)
  })

  it('classifies the api=0 branch on the detector’s own no-bill floor', () => {
    /*
     * Decision 5a's other half. `gapIsMaterial` is false at a provider-reported
     * $0 by design, so the api=0 branch needs its OWN answer rather than
     * silence. It reuses OVER_EMISSION_NO_BILL_FLOOR_USD — the constant the
     * detector's no-bill lane already uses for "no bill to corroborate against,
     * and the OTel total is worth a developer's attention" — instead of minting
     * a second threshold, which is the drift decision 5a exists to prevent.
     */
    const at = (attributedUsd: number, providerReportedUsd = 0, isDeclared = false) =>
      classifyToolGap({ attributedUsd, providerReportedUsd, isDeclared })

    expect(at(OVER_EMISSION_NO_BILL_FLOOR_USD + 0.01)).toBe('provider_record_missing')
    // Derived from the constant, not a copy of its value — and the floor must
    // be EXCEEDED, matching the detector's own `over_usd > floor`.
    expect(at(OVER_EMISSION_NO_BILL_FLOOR_USD)).toBe('nothing_to_disclose')
    // A declaration on the tool answers the question before the floor is asked.
    expect(at(1e6, 0, true)).toBe('declared')
    // ...and with a REAL provider figure the api>0 branch decides instead.
    expect(at(1e6, 1)).toBe('material_gap')
    expect(at(1.5, 1)).toBe('nothing_to_disclose')
  })
})

describe('a declaration explains only the tool it names (D5, per tool)', () => {
  /*
   * THE DEFECT. The disclosure asked ONE account-wide question — "is the gap
   * between attributed usage and provider-reported usage material?" — while
   * gating the warning on "does this person hold ANY declaration". A developer
   * with a declared Claude Max subscription and an UNDECLARED Copilot
   * over-emission therefore saw the Claude footnote and nothing else: the
   * declaration masked a gap it says nothing about.
   *
   * `personal_subscription_declaration` is scoped to one tool, and so is the
   * carve-out the over-emission detector applies to it, so the classification
   * is per tool here too.
   *
   * Each scenario gets its OWN teammate: these read whole-month totals per
   * tool, so sharing the fixture teammate above would let one scenario's
   * dollars decide another's classification.
   */
  const DAY = '2026-06-10T00:00:00.000Z'
  const BILL_DAY = '2026-06-05'

  /** declared Claude + undeclared Copilot, with an open review on the Copilot. */
  let mixed = { id: '', instanceId: '' }
  /** one undeclared material gap whose review row state is the variable. */
  let unraised = { id: '', instanceId: '' }
  /** usage with no provider record behind it at all. */
  let noRecord = { id: '', instanceId: '' }

  async function makeTeammate(tag: string): Promise<{ id: string; instanceId: string }> {
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: `oid-${tag}`,
        email: `${tag}@x.test`,
        displayName: tag,
        regionId,
        orgUnitId,
      })
      .returning()
    const id = tm!.id
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), ${`p-${tag}`}, ${id}::uuid, 'claude-code', ${regionId}::uuid,
              ${orgUnitId}::uuid, 'h', 'P')`
    const [inst] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${id}::uuid LIMIT 1`
    return { id, instanceId: inst!.id }
  }

  /** §A emission for an arbitrary teammate (the top-level `emit` is bound to one). */
  async function emitFor(
    who: { id: string; instanceId: string },
    tool: string,
    costUsd: number,
  ): Promise<void> {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type,
         tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${who.instanceId}::uuid, ${who.id}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid,
              ${projectId}::uuid, ${tool}, 'claude-sonnet-4-6', 'input', 100, ${costUsd},
              'tier-1', 'estimated', ${DAY}::timestamptz, ${`sess-${who.id}-${tool}`})`
  }

  /** Claude provider truth (v_teammate_usage_daily reads actual_spend for it). */
  async function claudeTruth(who: { id: string }, costUsd: number): Promise<void> {
    await t.db.insert(schema.actualSpend).values({
      teammateId: who.id,
      date: BILL_DAY,
      tool: 'claude-code',
      inputTokens: BigInt(10),
      outputTokens: BigInt(10),
      costUsd: String(costUsd),
    })
  }

  /** Copilot provider truth — reconciliation_record, NOT actual_spend (mig 0086). */
  async function copilotTruth(who: { id: string }, actualUsd: string): Promise<void> {
    await t.db.insert(schema.reconciliationRecord).values({
      teammateId: who.id,
      provider: 'github',
      enterpriseRef: 'ent-lens',
      periodDate: BILL_DAY,
      category: 'copilot_interactive',
      scope: 'teammate',
      regionId,
      orgUnitId,
      actualUsd,
      otelAttributedUsd: '0',
      deltaUsd: actualUsd,
      spendClass: 'billed',
      disposition: 'ingest_only',
      status: 'applied',
    })
  }

  async function reviewRow(
    who: { id: string },
    tool: string,
    state: 'open' | 'accepted',
  ): Promise<void> {
    await t.client`INSERT INTO over_emission
        (teammate_id, region_id, org_unit_id, day, tool, otel_usd, api_usd, over_usd, state)
      VALUES (${who.id}::uuid, ${regionId}::uuid, ${orgUnitId}::uuid, ${BILL_DAY}::date, ${tool},
              900, 100, 800, ${state})`
  }

  const gapsFor = (who: { id: string }) => getMyToolGaps(t.db, who.id, NOW)
  const byTool = (gaps: Awaited<ReturnType<typeof gapsFor>>, tool: string) =>
    gaps.find((g) => g.tool === tool)

  beforeAll(async () => {
    mixed = await makeTeammate('lens-mixed')
    unraised = await makeTeammate('lens-unraised')
    noRecord = await makeTeammate('lens-norecord')

    // (1) Claude declared and materially over its bill; Copilot undeclared and
    //     materially over its own, with a review already raised for it.
    await emitFor(mixed, 'claude-code', 6800)
    await emitFor(mixed, 'copilot-cli', 500)
    await claudeTruth(mixed, 1000)
    await copilotTruth(mixed, '100')
    await t.client`INSERT INTO personal_subscription_declaration
        (teammate_id, tool, subscription_type, monthly_cost_usd, declared_at)
      VALUES (${mixed.id}::uuid, 'claude-code', 'Claude Max 20', 200, '2026-05-30T09:00:00Z')`
    await reviewRow(mixed, 'copilot-cli', 'open')

    // (2) An undeclared material gap whose only over_emission row is RESOLVED.
    await emitFor(unraised, 'claude-code', 900)
    await claudeTruth(unraised, 100)
    await reviewRow(unraised, 'claude-code', 'accepted')

    // (3) Usage with no provider record at all: one tool over the detector's
    //     no-bill floor, one under it.
    await emitFor(noRecord, 'claude-code', 10_000)
    await emitFor(noRecord, 'copilot-cli', 100)
  })

  it('a declared Claude subscription does not hide an undeclared Copilot gap', async () => {
    const gaps = await gapsFor(mixed)
    const claude = byTool(gaps, 'claude-code')!
    const copilot = byTool(gaps, 'copilot-cli')!

    expect(claude.state).toBe('declared')
    expect(copilot.state).toBe('material_gap')

    /*
     * Guard the guard, twice over. The Claude row must be a gap the detector
     * WOULD call material — otherwise 'declared' would be indistinguishable
     * from "nothing to say" and this fixture would certify nothing. And the two
     * tools must really carry different provider figures, or one row's
     * classification could be standing in for the other's.
     */
    expect(gapIsMaterial(Number(claude.attributed_usage_usd), Number(claude.provider_reported_usd)))
      .toBe(true)
    expect(claude.provider_reported_usd).not.toBe(copilot.provider_reported_usd)
    expect(Number(copilot.provider_reported_usd)).toBeCloseTo(100, 2)
    expect(Number(claude.provider_reported_usd)).toBeCloseTo(1000, 2)
  })

  it('rides through buildMeLensDisclosure, so the surfaces get the per-tool view', async () => {
    const d = await buildMeLensDisclosure(t.db, {
      teammateId: mixed.id,
      attributedUsageUsd: '7300.00',
      providerReportedUsd: '1100.00',
      now: NOW,
    })
    expect(d.declared_personal.map((p) => p.tool)).toEqual(['claude-code'])
    expect(d.tool_gaps.map((g) => `${g.tool}:${g.state}`)).toEqual([
      'claude-code:declared',
      'copilot-cli:material_gap',
    ])
  })

  it('labels Copilot for a reader rather than echoing the wire tool id', async () => {
    const copilot = byTool(await gapsFor(mixed), 'copilot-cli')!
    expect(copilot.label).toBe('Copilot')
  })

  it('reports a review only for the tool that actually has an open one', async () => {
    // Same call, two tools: the flag is per tool, not a property of the person.
    const gaps = await gapsFor(mixed)
    expect(byTool(gaps, 'copilot-cli')!.has_open_review).toBe(true)
    expect(byTool(gaps, 'claude-code')!.has_open_review).toBe(false)
  })

  it('a RESOLVED review row is not an open review — the promise tracks state', async () => {
    /*
     * Finding 7. The detector's settled-bill guard means a mismatch made of the
     * last three days is real and deliberately unraised, so the copy may only
     * promise a review when one exists. This drives the flag from the row's
     * state and asserts both outcomes, so a component that always promised (or
     * never did) cannot pass.
     */
    const before = byTool(await gapsFor(unraised), 'claude-code')!
    expect(before.state).toBe('material_gap')
    expect(before.has_open_review).toBe(false)

    await t.client`UPDATE over_emission SET state = 'open'
                    WHERE teammate_id = ${unraised.id}::uuid AND tool = 'claude-code'`
    try {
      const after = byTool(await gapsFor(unraised), 'claude-code')!
      expect(after.state).toBe('material_gap')
      expect(after.has_open_review).toBe(true)
      expect(after.has_open_review).not.toBe(before.has_open_review)
    } finally {
      await t.client`UPDATE over_emission SET state = 'accepted'
                      WHERE teammate_id = ${unraised.id}::uuid AND tool = 'claude-code'`
    }
  })

  it('with no provider record at all, says THAT rather than nothing (D5a)', async () => {
    /*
     * Finding 8. `gapIsMaterial` is correctly false at a provider-reported $0,
     * which left $10,000 of attributed usage against no record rendering
     * nothing at all. The ADR's honest sentence for that case is the absence of
     * the record, and it needs a state of its own to be renderable.
     */
    const gaps = await gapsFor(noRecord)
    const claude = byTool(gaps, 'claude-code')!
    const copilot = byTool(gaps, 'copilot-cli')!

    expect(Number(claude.provider_reported_usd)).toBe(0)
    expect(gapIsMaterial(Number(claude.attributed_usage_usd), 0)).toBe(false)
    expect(claude.state).toBe('provider_record_missing')
    // No detector row exists for a month with no bill, so no review is claimed.
    expect(claude.has_open_review).toBe(false)

    /*
     * Guard the guard: the SAME teammate, the SAME $0 provider record, a
     * different size — and a different answer. Without this the state could be
     * "any tool with no provider record" and the floor would be untested.
     */
    expect(Number(copilot.provider_reported_usd)).toBe(0)
    expect(copilot.state).toBe('nothing_to_disclose')
    expect(Number(copilot.attributed_usage_usd)).toBeLessThan(
      Number(claude.attributed_usage_usd),
    )
  })

  it('never reports another teammate’s tools', async () => {
    const gaps = await gapsFor(noRecord)
    expect(gaps.map((g) => g.tool).sort()).toEqual(['claude-code', 'copilot-cli'])
    expect(Number(byTool(gaps, 'claude-code')!.attributed_usage_usd)).toBeCloseTo(10_000, 2)
  })
})

/*
 * WHY A DOLLAR DOES OR DOES NOT REACH THE COST CENTRE.
 *
 * The dashboard replaced a card that reprinted the hero figure beside two zeros
 * with one sentence and an (i) that itemises it. The sentence names the COST
 * CENTRE — never a person — and the itemisation distinguishes three genuinely
 * different reasons, because "nothing chargeable" collapses "no bill exists"
 * and "a bill exists but is not charged to you" into one claim, and only the
 * first of those is a zero.
 *
 * These are the three the DATA can actually make. `unresolved` exemptions are
 * deliberately not among them: such a row is exempt because the governance key
 * could not be resolved, which is not evidence of an NFR agreement — and the
 * copy above these rows names one.
 */
describe('the billing states behind the chargeable line', () => {
  const TRACKED_EXEMPT_USD = 8.43
  const UNRESOLVED_EXEMPT_USD = 4.44
  const DECLARED_USD = 40

  beforeAll(async () => {
    const day = new Date().toISOString().slice(0, 10)
    /*
     * Separated by TOOL, never by day: on the 1st of a month there is exactly
     * one day both elapsed and not in the future, so a fixture that needs two
     * of them is a fixture that fails one day in thirty.
     */
    await bill(day, TRACKED_EXEMPT_USD, {
      tool: 'copilot-cli',
      exempt: true,
      source: 'governance:tracked',
    })
    await bill(day, UNRESOLVED_EXEMPT_USD, {
      tool: 'claude-cowork',
      exempt: true,
      source: 'unresolved',
    })
    // Another teammate's rows, in two states — the scoping guard.
    await bill(day, 99, {
      teammate: otherTeammateId,
      tool: 'copilot-cli',
      exempt: true,
      source: 'governance:tracked',
    })
    await bill(day, 77, { teammate: otherTeammateId, tool: 'claude-chrome' })
    // The caller's active `claude-code` declaration (Claude Max 20, $200) is
    // seeded once for the whole file — `personal_subscription_declaration` has
    // a one-active-row-per-(teammate, tool) unique index, so this reuses it
    // rather than inserting a second.
    //
    // Usage behind the declaration, so the declared row is a real amount.
    const now = Date.now()
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
    const at = new Date(Math.max(monthStart, now - 1_800_000)).toISOString()
    await emit(at, DECLARED_USD, 'sess-declared')
  })

  const disclosureNow = async () =>
    (await homeHandler(ev(sess(), '/api/v1/me/home'))).disclosure

  it('names the caller’s cost centre human and region-qualified, never by slug', async () => {
    // region.display_name + org_unit.display_name, resolved through
    // v_org_unit_cost_owner from the caller's OWN placement.
    const d = await disclosureNow()
    expect(d.cost_centre).toBe('ML · ML')
    expect(d.cost_centre).not.toContain('ml-bu')
  })

  it('the CHARGED rows sum to exactly the chargeable scalar beside them', async () => {
    /*
     * The line prints `chargeable_usd` and the (i) itemises the charged rows.
     * Both come from the same view over the same window, so if these ever
     * disagreed the reader would be shown a total its own breakdown contradicts.
     */
    const d = await disclosureNow()
    const charged = d.billing_states.filter((b) => b.state === 'charged')
    expect(charged.length).toBeGreaterThan(0)
    const sum = charged.reduce((acc, b) => acc + Number(b.usd), 0)
    expect(sum).toBeCloseTo(Number(d.chargeable_usd), 2)
  })

  it('reports an NFR exemption only when the AGREEMENT is what exempted it', async () => {
    const d = await disclosureNow()
    const exempt = d.billing_states.filter((b) => b.state === 'exempt')
    expect(exempt.map((b) => b.tool)).toEqual(['copilot-cli'])
    expect(Number(exempt[0]!.usd)).toBeCloseTo(TRACKED_EXEMPT_USD, 2)
    /*
     * Guard the guard: an exempt row of a DIFFERENT size exists on another tool
     * this month, exempted by `unresolved`. Without it, "only copilot-cli"
     * would pass against a fixture that had no second exempt row at all.
     */
    expect(exempt.map((b) => b.tool)).not.toContain('claude-cowork')
    expect(exempt.reduce((a, b) => a + Number(b.usd), 0)).not.toBeCloseTo(
      TRACKED_EXEMPT_USD + UNRESOLVED_EXEMPT_USD,
      2,
    )
  })

  it('carries the declaration’s own subscription type on the declared row', async () => {
    const d = await disclosureNow()
    const declared = d.billing_states.filter((b) => b.state === 'declared-personal')
    expect(declared).toHaveLength(1)
    expect(declared[0]!.tool).toBe('claude-code')
    expect(declared[0]!.subscription_type).toBe('Claude Max 20')
    expect(Number(declared[0]!.usd)).toBeGreaterThan(0)
    // The other two states never carry one — there is no subscription behind them.
    for (const b of d.billing_states.filter((x) => x.state !== 'declared-personal')) {
      expect(b.subscription_type).toBeNull()
    }
  })

  it('a declaration does NOT suppress the same tool’s charged row', async () => {
    /*
     * Migration 0105:16-19 — "a declaration NEVER changes an actual_spend
     * chargeback verdict". Provider-backed and personal usage coexisting for one
     * (teammate, tool) is a supported state, so applying precedence here would
     * both hide a real charge and break the sum pinned above.
     */
    const d = await disclosureNow()
    const claudeCode = d.billing_states.filter((b) => b.tool === 'claude-code')
    expect(claudeCode.map((b) => b.state).sort()).toEqual(['charged', 'declared-personal'])
  })

  it('reads the DECLARED first, then the exempt, then the charged', async () => {
    // The order the sentence reads in: no bill exists, no bill is raised, a
    // bill is raised.
    const d = await disclosureNow()
    const rank: Record<string, number> = { 'declared-personal': 0, exempt: 1, charged: 2 }
    const order = d.billing_states.map((b) => rank[b.state]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('never reports another teammate’s money', async () => {
    /*
     * `actual_spend` carries no RLS policy of its own, so the teammate
     * predicate in the query — not the session — is what clamps this. The other
     * teammate holds $99 exempt and $77 charged this month; neither may appear.
     */
    const d = await disclosureNow()
    for (const b of d.billing_states) {
      expect(Number(b.usd)).not.toBeCloseTo(99, 2)
      expect(Number(b.usd)).not.toBeCloseTo(77, 2)
    }
    expect(Number(d.chargeable_usd)).toBeLessThan(77)
  })
})
