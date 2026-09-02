// @vitest-environment node
/*
 * The BILLED lane's drivers — the chargeback half of the reporting lane toggle.
 *
 * WHAT THIS FILE IS FOR, in one sentence: to prove that no figure this codebase
 * labels BILLED contains Copilot consumption, and that no billed figure is
 * derived from a ratio.
 *
 * ── WHY A REAL DB AND NOT A UNIT TEST ───────────────────────────────────────
 *
 * Both defects live in SQL, or in the seam between two queries, and neither is
 * visible to a static check:
 *
 *   1. `SUM(cost_usd)` over `provider_usage_fact` type-checks, reads cleanly,
 *      foots to a plausible total, and adds Anthropic's BILLED dollars to
 *      GitHub's gross CONSUMPTION credits (mig 0120). The fixture below holds
 *      BOTH providers on the SAME teammate, day and tool, so a blind sum is a
 *      wrong number here rather than a hypothetical one.
 *
 *   2. A coverage ratio (`f = min(1, T_otel/T_api)`, the apportionment
 *      target-state-data-architecture.md §5 deleted) reads
 *      `provider_usage_fact` and `v_complete_usage` in TWO statements and folds
 *      them in memory. `tests/unit/server/reports-lane-firewall.test.ts` is a
 *      syntax check over one statement at a time and cannot see it. The
 *      invariance suite below can: every billed figure is re-measured after the
 *      ATTRIBUTED lane is changed underneath it, and must not move by a cent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup, rebuildUsageRollup } from '../helpers/usage-rollup'
import {
  clampedFinance,
  clampedUsage,
  wholeCompanyFinance,
  wholeCompanyUsage,
} from '../../../server/reporting/engine/scope'
import { fetchDrivers, type DriversResult } from '../../../server/reporting/engine/drivers'
import { fetchAcrossDrivers } from '../../../server/reporting/across-regions'
import { BILLED_AXES, type BilledAxis } from '../../../server/reporting/engine/billed-axis'
import { VENDOR_LABELS, VENDOR_LANES } from '../../../shared/usage/vendor'
import { BILLED_NO_MODEL_KEY } from '../../../shared/reports/model-attribution'
import {
  UNALLOCATED_BUDGET_KEY,
  UNALLOCATED_BUDGET_LABEL,
} from '../../../shared/reports/vocabulary'
import type { BilledAxisArm, DriverRow } from '../../../shared/reports/types'
import driversHandler from '../../../server/api/v1/reports/region/drivers.get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'

let t: TestDb
let regionA = ''
let regionB = ''
let unitA = ''
let unitB = ''
let alice = ''
let bob = ''
let projAtlas = ''

/** June 1-5 exclusive — every fixture row lands inside it unless it says otherwise. */
const WIN = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-06-05T00:00:00.000Z' }

/*
 * DELIBERATELY UN-ROUND, AND DELIBERATELY NOT EQUAL. Every assertion below is a
 * specific number rather than a relation, so a fold that happens to be
 * arithmetically plausible still fails: if Copilot's credits were added to the
 * Anthropic total, the result would be a number that appears nowhere in this
 * file.
 */
const OPUS_USD = 411.25
const SONNET_USD = 88.5
const NOMODEL_USD = 17.75
const BOB_OPUS_USD = 260.5
/** GitHub CONSUMPTION — gross AI credits, never a charge. */
const COPILOT_CREDITS_USD = 913.4
const ANTHROPIC_BILLED_TOTAL = OPUS_USD + SONNET_USD + NOMODEL_USD + BOB_OPUS_USD

/*
 * The POOLED Copilot CHARGEBACK — `copilot_pool_bill` read through
 * `v_finance_copilot_pool_chargeback`. A different KIND of number from
 * COPILOT_CREDITS_USD above and deliberately a different amount: the credits are
 * a gross meter reading on `provider_usage_fact`, this is the net invoice.
 * Confusing them is the whole reason the two live on separate arms.
 */
const COPILOT_LICENSE_USD = 137.5
const COPILOT_OVERAGE_USD = 64.25
/** NEVER chargeable (design D2) — visible on Finance, absent from every total. */
const COPILOT_UNCLASSIFIED_USD = 9.75
const POOLED_CHARGEBACK_USD = COPILOT_LICENSE_USD + COPILOT_OVERAGE_USD
/** The complete cost-centre chargeback: BOTH providers, at the axis that homes both. */
const BOTH_PROVIDERS_TOTAL = ANTHROPIC_BILLED_TOTAL + POOLED_CHARGEBACK_USD

/**
 * A MONTH-ALIGNED window over the same fixture rows as {@link WIN}.
 *
 * The pooled Copilot invoice is `period_month`-grained, so it may only be folded
 * over whole months — `WIN` (June 1-5) is deliberately NOT one, which is what
 * makes the partial-month case below a real assertion rather than a contrivance.
 * Every seeded fact row is dated 2026-06-02, so the Anthropic totals are
 * identical under both windows and any difference between them is the Copilot
 * term alone.
 */
const MONTH_WIN = { startIso: '2026-06-01T00:00:00.000Z', endIso: '2026-07-01T00:00:00.000Z' }
/** Chargeback with the pooled Copilot arm ENABLED and in scope. */
const WITH_POOL = { financeScope: wholeCompanyFinance, copilotChargeback: true }

/*
 * THE STATE BETWEEN "the arm is there" AND "the gate is off": MAY.
 *
 * A month-aligned window with Anthropic charges and NO `copilot_pool_bill` row —
 * the pooled arm is fetched, is enabled, is in scope, and returns `no-data-yet`.
 * Nothing in the suite covered it, which is exactly why a coverage statement read
 * off the arm LIST rather than off availability shipped claiming both providers.
 */
const MAY_WIN = { startIso: '2026-05-01T00:00:00.000Z', endIso: '2026-06-01T00:00:00.000Z' }
const MAY_ANTHROPIC_USD = 55.25
/** A month-aligned window NOTHING has been derived for, on EITHER provider. */
const FUTURE_MONTH_WIN = { startIso: '2027-01-01T00:00:00.000Z', endIso: '2027-02-01T00:00:00.000Z' }

async function fact(over: {
  provider?: string
  model?: string | null
  date?: string
  tool?: string
  costUsd?: number | null
  input?: number | null
  requests?: number | null
  teammate?: string
  region?: string
  unit?: string
}): Promise<void> {
  const isCost = over.costUsd != null
  await t.client`
    INSERT INTO provider_usage_fact
      (source, provider, teammate_id, actor_ref, date, tool, model, cost_type, cost_usd,
       input_tokens, requests, region_id, org_unit_id, cost_owning_unit_id)
    VALUES (
      ${'src-' + (over.provider ?? 'anthropic')},
      ${over.provider ?? 'anthropic'},
      ${over.teammate ?? alice}::uuid,
      'actor@x.test',
      ${over.date ?? '2026-06-02'}::date,
      ${over.tool ?? 'claude-code'},
      ${over.model === undefined ? 'claude-opus-5' : over.model},
      ${isCost ? 'tokens' : null},
      ${isCost ? over.costUsd : null},
      ${isCost ? null : (over.input ?? null)},
      ${isCost ? null : (over.requests ?? null)},
      ${over.region ?? regionA}::uuid,
      ${over.unit ?? unitA}::uuid,
      ${over.unit ?? unitA}::uuid)`
}

/**
 * One arm by `${provider}:${measure}` — NOT by provider. At the cost-centre axis
 * GitHub contributes TWO arms that mean opposite things (a consumption meter and
 * a pooled invoice), so a provider-keyed lookup would silently pick whichever
 * came first.
 */
const armById = (d: DriversResult, id: string): BilledAxisArm =>
  d.billedLane!.arms.find((a) => a.id === id)!
const arm = (d: DriversResult, provider: string): BilledAxisArm =>
  armById(d, `${provider}:${provider === 'github' ? 'consumption' : 'billed'}`)

beforeAll(async () => {
  t = await startTestDb()
  // The HTTP handlers below open their own connection through `getDb`.
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('bda', 'Billed A'), ('bdb', 'Billed B')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='bda'`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='bdb'`

  const mkUnit = async (region: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${code}::ltree, ${code}, ${'Unit ' + code}, 'practice', true)`
    const [u] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return u!.id
  }
  unitA = await mkUnit(regionA, 'bua')
  unitB = await mkUnit(regionB, 'bub')

  const mkTeammate = async (region: string, unit: string, email: string, name: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${'oid-' + email}, ${email}, ${name}, ${region}::uuid, ${unit}::uuid, true)`
    const [m] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return m!.id
  }
  alice = await mkTeammate(regionA, unitA, 'billed-alice@x.test', 'Billed Alice')
  bob = await mkTeammate(regionB, unitB, 'billed-bob@x.test', 'Billed Bob')

  /*
   * mig 0129: `finops()` below (used against `driversHandler`/`exportHandler`
   * with `region=all` widths) resolves to this DEDICATED sentinel id — the ONLY
   * place in this file that id appears (grep confirms no other role/persona
   * shares it). A real backing row is required for the `report_access_grant`
   * FK; both permissions are granted so the whole-company width and the
   * chargeback lane the tests below exercise keep working under the new
   * per-teammate grants model.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-billed-finops', 'billed-finops@x.test', 'Billed Finops', ${regionA}::uuid, ${unitA}::uuid, true)`
  await grantReportAccess(t.client, '00000000-0000-0000-0000-000000000009')

  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('BD-ATLAS', 'h-bd-atlas', 'Atlas', 'billable', ${regionA}::uuid, ${unitA}::uuid)`
  ;[{ id: projAtlas }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='BD-ATLAS'`

  // ── The BILLED lane ────────────────────────────────────────────────────────
  // Anthropic: billed money, at model grain (`data[].model` 255/255 on the cost
  // report — the wire capture, not a schema).
  await fact({ model: 'claude-opus-5', costUsd: OPUS_USD })
  await fact({ model: 'claude-sonnet-5', costUsd: SONNET_USD })
  await fact({ model: null, costUsd: NOMODEL_USD })
  await fact({ model: 'claude-opus-5', costUsd: BOB_OPUS_USD, teammate: bob, region: regionB, unit: unitB })
  // A TOKEN row: measure exclusivity means it carries no cost, so it must not
  // become a $0 driver row and must not touch any total.
  await fact({ model: 'claude-opus-5', input: 5000 })
  /*
   * MAY: Anthropic charged, the Copilot bill reader never reached the month. Dated
   * outside every other window in this file, so it changes no total above and is
   * visible only through MAY_WIN.
   */
  await fact({ model: 'claude-opus-5', costUsd: MAY_ANTHROPIC_USD, date: '2026-05-15' })

  /*
   * GitHub: CONSUMPTION, on the SAME teammate/day/tool family as Anthropic's, so
   * a blind SUM over the table is a wrong ANSWER here, not just a wrong idea.
   * Money on a `model IS NULL` row and the model dimension on its own activity
   * row — the shape mig 0120's CHECK enforces.
   */
  await fact({ provider: 'github', model: null, tool: 'copilot-cli', costUsd: COPILOT_CREDITS_USD })
  await fact({ provider: 'github', model: 'gpt-5.6-sol', tool: 'copilot-cli', requests: 42 })

  // ── The ATTRIBUTED lane ────────────────────────────────────────────────────
  // Deliberately DIFFERENT amounts from the billed lane. Any billed figure that
  // moves when these move is reading them.
  const mkInstance = async (tm: string, region: string, unit: string, tool: string) => {
    await t.client`INSERT INTO instance_attestation
        (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), ${'p-' + tm + tool}, ${tm}::uuid, ${tool}, ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [i] = await t.client<{ id: string }[]>`
      SELECT instance_id::text AS id FROM instance_attestation
       WHERE teammate_id=${tm}::uuid AND tool=${tool} LIMIT 1`
    return i!.id
  }
  const otel = async (tm: string, region: string, unit: string, usd: number, project: string | null) => {
    const inst = await mkInstance(tm, region, unit, 'claude-code')
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, project_id, tool, model, token_type, tokens,
         cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${region}::uuid, ${unit}::uuid, ${project}::uuid, 'claude-code',
              'claude-sonnet-5', 'input', 1000, ${usd}, 'tier-1', 'estimated',
              '2026-06-02T00:00:00Z'::timestamptz, ${'sess-' + tm})`
  }
  // A tagged OTel session…
  await otel(alice, regionA, unitA, 40, projAtlas)
  // …and an untagged one.
  await otel(bob, regionB, unitB, 25, null)

  /*
   * PROVIDER-RECORDED DAYS (shadow fill, §4). The Copilot one IS TAGGED, which
   * is the acceptance case: a Copilot provider-recorded day tagged to a budget
   * must appear inside that budget's row. The Claude one is untagged and must
   * land WHOLLY in unallocated — never split.
   */
  await t.client`INSERT INTO unaccounted_usage
      (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source, tagged_at)
    VALUES (${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${projAtlas}::uuid,
            '2026-06-03'::date, 'copilot-cli', 60, 0, 'api-reconciled', now())`
  await t.client`INSERT INTO unaccounted_usage
      (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source)
    VALUES (${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL,
            '2026-06-04'::date, 'claude-code', 33, 0, 'api-reconciled')`

  /*
   * ── The POOLED Copilot CHARGEBACK lane ────────────────────────────────────
   * The bill `provider_usage_fact` does not hold. Homed to unitA — the SAME cost
   * centre Anthropic's charge homes to — so the folded practice row is a genuine
   * two-provider sum rather than two rows sitting beside each other, and a fold
   * that dropped either term produces a number that appears nowhere here.
   *
   * `unclassified_net_usd` is seeded NON-ZERO on purpose: it rides the view as a
   * visible lane and must be absent from every chargeable total (design D2).
   */
  await t.client`INSERT INTO provider_enterprise (provider, external_id, display_name)
    VALUES ('github', 'bd-ent', 'Billed Enterprise')`
  const [{ id: entId }] = await t.client<{ id: string }[]>`
    SELECT id::text AS id FROM provider_enterprise WHERE external_id='bd-ent'`
  await t.client`INSERT INTO copilot_pool_bill
      (month, provider_enterprise_id, provider_org_id, cost_owning_unit_id, seats,
       license_net_usd, overage_net_usd, unclassified_net_usd, included_allowance_usd, usage_gross_usd)
    VALUES ('2026-06-01'::date, ${entId}::uuid, NULL, ${unitA}::uuid, 5,
            ${COPILOT_LICENSE_USD}, ${COPILOT_OVERAGE_USD}, ${COPILOT_UNCLASSIFIED_USD}, 80, 90)`
  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

// ── Acceptance 1 — provider discrimination ───────────────────────────────────
describe('a billed axis sums to the billed total FOR ITS PROVIDER', () => {
  it.each(BILLED_AXES)('axis %s: the Anthropic arm foots to Anthropic money alone', async (axis) => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'chargeback')
    const anthropic = arm(d, 'anthropic')

    expect(anthropic.measure).toBe('billed')
    expect(anthropic.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(anthropic.totalUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
  })

  it.each(BILLED_AXES)('axis %s: the GitHub arm is CONSUMPTION and foots to its own credits', async (axis) => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'chargeback')
    const github = arm(d, 'github')

    expect(github.measure).toBe('consumption')
    expect(github.totalUsd).toBeCloseTo(COPILOT_CREDITS_USD, 6)
    // Every one of its rows is marked informational. A 'billed' row inside a
    // consumption arm would render as a hard dollar in the table.
    for (const r of github.rows) expect(r.spendClass).toBe('pooled-usage')
  })

  it.each(BILLED_AXES)('axis %s: Copilot consumption is NEVER inside a figure labelled billed', async (axis) => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'chargeback')

    // The headline, the declared billed total, and Σ of the rendered rows are
    // the SAME number, and it is Anthropic's alone.
    expect(d.headlineUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(d.billedLane!.billedUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)

    // The number a blind `SUM(cost_usd)` would produce appears NOWHERE.
    const blindSum = ANTHROPIC_BILLED_TOTAL + COPILOT_CREDITS_USD
    expect(d.headlineUsd).not.toBeCloseTo(blindSum, 2)
    expect(d.billedLane!.billedUsd).not.toBeCloseTo(blindSum, 2)

    // The consumption total is carried, separately, and is not folded in.
    expect(d.billedLane!.consumptionUsd).toBeCloseTo(COPILOT_CREDITS_USD, 6)
    // Every top-level (billed) row is a hard dollar…
    for (const r of d.rows) expect(r.spendClass).toBe('billed')
    // …and none of them is the Copilot amount.
    expect(d.rows.some((r) => Math.abs(r.usd - COPILOT_CREDITS_USD) < 0.005)).toBe(false)
  })

  it('a token-only grain is not a $0 driver row', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'model', 'chargeback')
    expect(d.rows.every((r) => r.usd !== 0)).toBe(true)
  })

  it('names the NULL-model bucket with the BILLED lane vocabulary, not the residual’s', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'model', 'chargeback')
    const nullModel = d.rows.find((r) => r.key === BILLED_NO_MODEL_KEY)!
    expect(nullModel.usd).toBeCloseTo(NOMODEL_USD, 6)
    // Never the attributed lane's "we should have carried this" bucket.
    expect(d.rows.some((r) => r.key === '__null_model')).toBe(false)
  })

  it('threads the scope clamp — region B’s billed money is outside region A', async () => {
    const d = await fetchDrivers(
      t.db,
      clampedUsage(sql`u.region_id = ${regionA}::uuid`),
      WIN,
      'teammate',
      'chargeback',
    )
    expect(d.headlineUsd).toBeCloseTo(OPUS_USD + SONNET_USD + NOMODEL_USD, 6)
    expect(d.rows.some((r) => r.label === 'Billed Bob')).toBe(false)
  })

  it('distinguishes “no rows in this scope” from “nothing derived for this window”', async () => {
    const inScope = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'teammate', 'chargeback')
    expect(arm(inScope, 'anthropic').availability).toBe('present')

    // A region with no billed rows, in a window that HAS them → a genuine zero.
    const empty = await fetchDrivers(
      t.db,
      clampedUsage(sql`u.region_id = ${regionB}::uuid AND u.tool = 'copilot-cli'`),
      WIN,
      'teammate',
      'chargeback',
    )
    expect(arm(empty, 'anthropic').availability).toBe('none-in-scope')

    // A window the transform has not reached → NOT a zero.
    const future = await fetchDrivers(
      t.db,
      wholeCompanyUsage,
      { startIso: '2027-01-01T00:00:00.000Z', endIso: '2027-01-05T00:00:00.000Z' },
      'teammate',
      'chargeback',
    )
    expect(arm(future, 'anthropic').availability).toBe('no-data-yet')
    expect(future.billedLane!.availability).toBe('no-data-yet')
  })
})

// ── Acceptance 1b — the chargeback lane is BOTH providers, or says whose it is ─
/*
 * `provider_usage_fact` is NOT the chargeback lane. After mig 0120 its `github`
 * rows are gross consumption, so a chargeback headline read from it alone is
 * Anthropic's charge under a company-wide label — a figure that is not wrong so
 * much as answering a different question from the one the label asks.
 *
 * The fix runs in both directions and both are asserted here: the axes that CAN
 * home the pooled Copilot invoice now carry it, and the axes that cannot say so
 * in words rather than quietly answering for one provider.
 */
describe('the cost-centre chargeback figure carries BOTH providers', () => {
  it('folds the pooled Copilot invoice onto the practice axis, on the same key', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'chargeback', WITH_POOL)

    expect(d.headlineUsd).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)
    expect(d.billedLane!.billedUsd).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)

    // Anthropic's charge ALONE is the number this defect used to publish. It must
    // no longer be the headline at this axis.
    expect(d.headlineUsd).not.toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 2)

    // ONE row for unitA, both providers' charge summed on it — not two rows.
    const rowA = d.rows.find((r) => r.key === unitA)!
    expect(rowA.usd).toBeCloseTo(OPUS_USD + SONNET_USD + NOMODEL_USD + POOLED_CHARGEBACK_USD, 6)
    expect(d.rows.filter((r) => r.key === unitA)).toHaveLength(1)
    // …and it is a hard dollar: a pooled invoice line IS a charge.
    expect(rowA.spendClass).toBe('billed')
  })

  it('names the pooled arm as its own measure and its own relation', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'chargeback', WITH_POOL)
    const pooled = armById(d, 'github:pooled-chargeback')

    expect(pooled.measure).toBe('pooled-chargeback')
    expect(pooled.source).toBe('v_finance_copilot_pool_chargeback')
    expect(pooled.totalUsd).toBeCloseTo(POOLED_CHARGEBACK_USD, 6)
    expect(pooled.availability).toBe('present')

    // The GitHub CONSUMPTION arm still exists beside it, unchanged and still out
    // of the billed total. The two must never collapse into one another.
    const credits = armById(d, 'github:consumption')
    expect(credits.measure).toBe('consumption')
    expect(credits.source).toBe('provider_usage_fact')
    expect(credits.totalUsd).toBeCloseTo(COPILOT_CREDITS_USD, 6)
    expect(d.billedLane!.consumptionUsd).toBeCloseTo(COPILOT_CREDITS_USD, 6)
    // The gross meter reading is NOT in the chargeback headline.
    expect(d.headlineUsd).not.toBeCloseTo(BOTH_PROVIDERS_TOTAL + COPILOT_CREDITS_USD, 2)
  })

  it('never charges the `copilot-unclassified` lane', async () => {
    // Visible on Finance, chargeable nowhere: an unclassified bill line is money
    // we cannot yet attribute to a SKU class.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'chargeback', WITH_POOL)
    expect(d.headlineUsd).not.toBeCloseTo(BOTH_PROVIDERS_TOTAL + COPILOT_UNCLASSIFIED_USD, 2)
    expect(armById(d, 'github:pooled-chargeback').totalUsd).not.toBeCloseTo(
      POOLED_CHARGEBACK_USD + COPILOT_UNCLASSIFIED_USD,
      2,
    )
  })

  it('answers the REGION axis too — the pooled charge homes to the CoU’s region', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'region', 'chargeback', WITH_POOL)
    expect(d.headlineUsd).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)
    const rowA = d.rows.find((r) => r.key === regionA)!
    expect(rowA.usd).toBeCloseTo(OPUS_USD + SONNET_USD + NOMODEL_USD + POOLED_CHARGEBACK_USD, 6)
    expect(d.chargebackCoverage!.gaps).toEqual([])
  })

  it('declares BOTH providers as the scope of a complete figure', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'chargeback', WITH_POOL)
    expect([...d.chargebackCoverage!.providers].sort()).toEqual(['anthropic', 'github'])
    // An empty `gaps` is the CLAIM "this is every provider that bills the scope",
    // and it is only allowed to be empty because the arm above is really there.
    expect(d.chargebackCoverage!.gaps).toEqual([])
  })

  it('threads the FINANCE clamp — region B’s cost centre carries no pooled charge', async () => {
    const d = await fetchDrivers(t.db, clampedUsage(sql`u.region_id = ${regionB}::uuid`), MONTH_WIN, 'practice', 'chargeback', {
      financeScope: clampedFinance(sql`u.region_id = ${regionB}::uuid`),
      copilotChargeback: true,
    })
    // Only Bob's Anthropic charge. The pooled invoice homes to unitA in region A,
    // so a clamp that leaked would show up as this figure gaining $201.75.
    expect(d.headlineUsd).toBeCloseTo(BOB_OPUS_USD, 6)
    expect(armById(d, 'github:pooled-chargeback').totalUsd).toBeCloseTo(0, 6)
    // Rows exist for this window elsewhere, so the empty arm is a measured zero.
    expect(armById(d, 'github:pooled-chargeback').availability).toBe('none-in-scope')
  })
})

/*
 * ── THE SURFACE AXIS IS ANSWERABLE, AND THE PREVIOUS TEST HERE SAID IT WAS NOT ─
 *
 * This block replaces one that required `surface` to stay Anthropic-only. That
 * assertion pinned a FALSE premise — worse than no test, because it made the
 * defect a specification. The pooled view's grain is
 * `(cost_owning_unit_id, region_id, tool, period_month)` and its `tool` column is
 * the bill's own CHARGEBACK LANE (mig 0107 emits `copilot-license` /
 * `copilot-usage` there). Grouping the invoice by the lane it was raised under is
 * a `GROUP BY`, not an apportionment: nothing is divided, nothing is shared out
 * across a dimension the provider did not report.
 */
describe('the surface axis carries the pooled Copilot charge, by the BILL’s own lane', () => {
  it('folds the invoice in at its own lanes, and foots to BOTH providers', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'surface', 'chargeback', WITH_POOL)

    expect(d.headlineUsd).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)
    expect(d.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(BOTH_PROVIDERS_TOTAL, 6)
    // The Anthropic-only number this axis used to publish is no longer the answer.
    expect(d.headlineUsd).not.toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 2)

    // The two §B Copilot lanes are their OWN rows, at their own amounts — never
    // one blended "Copilot" figure and never apportioned across the §A lanes.
    const byKey = new Map(d.rows.map((r) => [r.key, r]))
    expect(byKey.get('claude')!.usd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(byKey.get('copilot-license')!.usd).toBeCloseTo(COPILOT_LICENSE_USD, 6)
    expect(byKey.get('copilot-usage')!.usd).toBeCloseTo(COPILOT_OVERAGE_USD, 6)
    // Both are CHARGES, so they render as hard dollars.
    expect(byKey.get('copilot-license')!.spendClass).toBe('billed')
    // …and they are LABELLED from the registry, not left as the raw view value —
    // the same labels the §B lane legend and the chargeback donut use, so one
    // lane cannot read as two different things on two surfaces.
    expect(byKey.get('copilot-license')!.label).toBe(VENDOR_LABELS['copilot-license'])
    expect(byKey.get('copilot-usage')!.label).toBe(VENDOR_LABELS['copilot-usage'])
    expect(byKey.get('copilot-license')!.label).not.toBe('copilot-license')

    // `chargeToVendor` is the mapper, not `toolToVendor`: the wrong one would drop
    // every §B lane id into the 'other' catch-all.
    expect(byKey.has('other')).toBe(false)
    // The §A usage lane is NOT where the charge landed — it is the consumption
    // meter, and it is not in this ranking at all.
    expect(byKey.has('copilot')).toBe(false)
  })

  it('declares BOTH providers and states NO gap at this axis', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'surface', 'chargeback', WITH_POOL)
    expect([...d.chargebackCoverage!.providers].sort()).toEqual(['anthropic', 'github'])
    expect(d.chargebackCoverage!.gaps).toEqual([])
  })

  it('never charges `copilot-unclassified`, at this axis either', async () => {
    // The lane rides the view and is visible on Finance; it may not become a row
    // in a chargeback ranking through the back door of a new axis.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'surface', 'chargeback', WITH_POOL)
    expect(d.rows.some((r) => r.key === 'copilot-unclassified')).toBe(false)
    expect(d.headlineUsd).not.toBeCloseTo(BOTH_PROVIDERS_TOTAL + COPILOT_UNCLASSIFIED_USD, 2)
  })

  it('renders in REGISTRY order, not by money', async () => {
    // A fixed composition, like the lane legend — and the same order the arm's own
    // rows use, so the folded list and the arm beside it cannot disagree.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'surface', 'chargeback', WITH_POOL)
    const keys = d.rows.map((r) => r.key)
    expect(keys).toEqual([...keys].sort((a, b) => VENDOR_LANES.indexOf(a as never) - VENDOR_LANES.indexOf(b as never)))
  })
})

describe('an axis that cannot carry the Copilot charge SAYS SO, and never invents one', () => {
  it.each(['teammate', 'model'] as const)(
    'axis %s: Anthropic-only headline, with the reason named',
    async (axis) => {
      const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, axis, 'chargeback', WITH_POOL)

      // NOT apportioned across people or models — the pooled invoice has no such
      // dimension, and splitting it by a usage share is the apportionment
      // target-state-data-architecture.md §5 deleted.
      expect(d.headlineUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
      expect(d.billedLane!.arms.some((a) => a.measure === 'pooled-chargeback')).toBe(false)

      // The label's scope, and the sentence a reader needs.
      expect(d.chargebackCoverage!.providers).toEqual(['anthropic'])
      const gap = d.chargebackCoverage!.gaps.find((g) => g.provider === 'github')!
      expect(gap.reason).toMatch(/pooled per Business Unit/i)
      /*
       * The ENGINE's un-gated default names every axis it can rank, derived from
       * POOLED_CHARGEBACK_AXES rather than typed out. A caller that has not told
       * the engine which axes IT offers gets exactly this — see the scope-level
       * case below for the narrowing.
       */
      for (const axisName of ['Practice', 'Region', 'Surface']) {
        expect(gap.reason).toContain(axisName)
      }
      // It names the BILLING MODEL, never a data gap: this number is not coming.
      expect(gap.reason).not.toMatch(/not yet|coming soon|pending validation/i)
    },
  )

  /*
   * THE SCOPE NARROWS IT, and that is the half a reader actually sees.
   *
   * "This axis can be ranked" and "this reader can pick it" are different facts,
   * and the sentence is about the second. Region is the case that split them:
   * `POOLED_CHARGEBACK_AXES` still carries it (the pooled view has the column),
   * but neither scope's gate offers it since Region got its own card (prototype
   * `note('fix 4a', …)`). A sentence naming it would send someone hunting for a
   * chip that is not on their page.
   */
  it.each(['teammate', 'model'] as const)(
    'axis %s: through the whole-company SCOPE, the sentence names only pivots that exist',
    async (axis) => {
      const d = await fetchAcrossDrivers(t.db, MONTH_WIN, axis, 'chargeback', {
        copilotChargeback: true,
      })
      const gap = d.chargebackCoverage!.gaps.find((g) => g.provider === 'github')!
      expect(gap.reason).toContain('Break down by Practice or Surface')
      expect(gap.reason).not.toContain('Region')
    },
  )

  it('the BUDGET axis says NO provider can answer it', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'project', 'chargeback', WITH_POOL)
    expect(d.chargebackCoverage!.providers).toEqual([])
    expect(d.chargebackCoverage!.gaps).toHaveLength(1)
    expect(d.chargebackCoverage!.gaps[0]!.provider).toBeNull()
    expect(d.chargebackCoverage!.gaps[0]!.reason).toMatch(/project grain/i)
  })

  it('withholds the pooled charge while it is PENDING VALIDATION, and says which reason', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'chargeback', {
      financeScope: wholeCompanyFinance,
      copilotChargeback: false,
    })
    expect(d.headlineUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(d.chargebackCoverage!.providers).toEqual(['anthropic'])
    expect(d.chargebackCoverage!.gaps[0]!.reason).toMatch(/pending validation/i)
  })

  it('withholds the MONTHLY pooled charge over a part-month range, and says which reason', async () => {
    // WIN is June 1-5. Folding a whole month's pooled invoice into it would charge
    // a month's licences against four days.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'practice', 'chargeback', WITH_POOL)
    expect(d.headlineUsd).toBeCloseTo(ANTHROPIC_BILLED_TOTAL, 6)
    expect(d.chargebackCoverage!.gaps[0]!.reason).toMatch(/part-month|whole months/i)
    // The two withholding reasons are DIFFERENT sentences — a reader who can act
    // on one (change the range) must not be shown the one they cannot.
    expect(d.chargebackCoverage!.gaps[0]!.reason).not.toMatch(/pending validation/i)
  })

  it('publishes NO coverage at all in the usage lane', async () => {
    // The question does not arise: nothing on a §A screen claims to be a charge.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MONTH_WIN, 'practice', 'usage', WITH_POOL)
    expect(d.chargebackCoverage).toBeUndefined()
  })
})

/*
 * ── COVERAGE IS DATA AVAILABILITY, NOT ARM EXISTENCE ────────────────────────
 *
 * The suite had a PRESENT arm and a GATE-OFF arm, and nothing in between — which
 * is why the state in between shipped wrong. With the gate ON, the scope
 * resolved, the window month-aligned and NO pooled rows for it, the arm exists,
 * returns `no-data-yet`, and contributes $0: `coverage.providers` said
 * `anthropic + github`, emitted no gap, and published the Anthropic subtotal as
 * the complete chargeback figure.
 */
describe('a provider with NOTHING derived for the window is not in the coverage claim', () => {
  it('gate ON, Anthropic present, Copilot not derived → github is a stated GAP', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, MAY_WIN, 'practice', 'chargeback', WITH_POOL)

    // The arm is really there and really enabled — this is not the gate-off case.
    const pooled = armById(d, 'github:pooled-chargeback')
    expect(pooled.availability).toBe('no-data-yet')
    expect(pooled.totalUsd).toBeCloseTo(0, 6)

    // The figure is Anthropic's May charge, and the claim says exactly that.
    expect(d.headlineUsd).toBeCloseTo(MAY_ANTHROPIC_USD, 6)
    expect(d.chargebackCoverage!.providers).toEqual(['anthropic'])

    const gap = d.chargebackCoverage!.gaps.find((g) => g.provider === 'github')!
    expect(gap).toBeDefined()
    // A DERIVATION gap, not the structural one — a reader who is told "Copilot
    // bills pooled per Business Unit" would go and break down by Practice, which is
    // the axis they are already on.
    expect(gap.reason).toMatch(/derived/i)
    expect(gap.reason).not.toMatch(/pooled per Business Unit/i)
    expect(gap.reason).not.toMatch(/pending validation|part-month/i)
  })

  it('“no rows in THIS scope” is still a measured zero and stays in the claim', async () => {
    // The discriminating half. Region B's cost centre carries no pooled charge,
    // but the month HAS pooled rows — that is a real $0, not a missing worker run,
    // and dropping github from `providers` here would understate the coverage.
    const d = await fetchDrivers(t.db, clampedUsage(sql`u.region_id = ${regionB}::uuid`), MONTH_WIN, 'practice', 'chargeback', {
      financeScope: clampedFinance(sql`u.region_id = ${regionB}::uuid`),
      copilotChargeback: true,
    })
    expect(armById(d, 'github:pooled-chargeback').availability).toBe('none-in-scope')
    expect([...d.chargebackCoverage!.providers].sort()).toEqual(['anthropic', 'github'])
    expect(d.chargebackCoverage!.gaps).toEqual([])
  })

  it('a window with NOTHING derived at all claims NO provider, and says so twice', async () => {
    // The Anthropic arm is emitted unconditionally too, so the same defect lived
    // on the provider nobody was looking at.
    const d = await fetchDrivers(t.db, wholeCompanyUsage, FUTURE_MONTH_WIN, 'practice', 'chargeback', WITH_POOL)
    expect(d.headlineUsd).toBeCloseTo(0, 6)
    expect(d.chargebackCoverage!.providers).toEqual([])
    expect([...d.chargebackCoverage!.gaps].map((g) => g.provider).sort()).toEqual([
      'anthropic',
      'github',
    ])
    for (const g of d.chargebackCoverage!.gaps) expect(g.reason).toMatch(/derived/i)
  })
})

// ── Acceptance 2 — the budget axis ───────────────────────────────────────────
describe('the budget axis sums to the scope total, from the SHIPPED attribution', () => {
  it('Σ(budget rows) + unallocated === the scope total', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
    const tagged = d.rows
      .filter((r) => r.key !== UNALLOCATED_BUDGET_KEY)
      .reduce((a, r) => a + r.usd, 0)
    expect(tagged + d.unallocatedUsd!).toBeCloseTo(d.headlineUsd, 6)

    // …and the headline is the attributed lane's own total, not the billed one.
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
       WHERE ts_event >= ${WIN.startIso}::timestamptz AND ts_event < ${WIN.endIso}::timestamptz`
    expect(d.headlineUsd).toBeCloseTo(Number(total), 6)
  })

  it('a teammate-day with no tag lands WHOLLY in unallocated', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
    const unallocated = d.rows.find((r) => r.key === UNALLOCATED_BUDGET_KEY)!
    expect(unallocated.label).toBe(UNALLOCATED_BUDGET_LABEL)
    // bob's untagged $25 OTel session + alice's untagged $33 provider-recorded
    // day. Whole amounts, never a share of either.
    expect(unallocated.usd).toBeCloseTo(25 + 33, 6)
    expect(d.unallocatedUsd!).toBeCloseTo(25 + 33, 6)
  })

  it('a Copilot provider-recorded day TAGGED to a budget appears in that budget', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
    const atlas = d.rows.find((r) => r.key === projAtlas)!
    // $40 tagged OTel + the $60 tagged Copilot provider-recorded day.
    expect(atlas.usd).toBeCloseTo(100, 6)
  })

  it('answers ATTRIBUTED in the chargeback lane, and says so', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
    // The one axis whose lane does NOT follow the toggle — because
    // `provider_usage_fact` has no project column.
    expect(d.lane).toBe('attributed')
    expect(d.billedLane).toBeUndefined()
    // Never a hard dollar: these are not figures read off a provider bill.
    for (const r of d.rows) expect(r.spendClass).toBe('indicative')
  })

  it('keeps the usage lane’s own vocabulary under `usage`', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'usage')
    expect(d.rows.some((r) => r.key === '__null_project' && r.label === 'Untagged')).toBe(true)
    expect(d.rows.some((r) => r.key === UNALLOCATED_BUDGET_KEY)).toBe(false)
  })
})

// ── Acceptance 3 — switching lane changes the answer ─────────────────────────
describe('switching lane changes the rows AND the declared lane', () => {
  it.each(BILLED_AXES)('axis %s moves between relations, and declares which', async (axis) => {
    const usage = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'usage')
    const billed = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'chargeback')

    expect(usage.lane).toBe('attributed')
    expect(billed.lane).toBe('billed')
    expect(usage.billedLane).toBeUndefined()
    expect(billed.billedLane).toBeDefined()
    // The fixture's two lanes hold different money on purpose, so the headline
    // moving is evidence the rows moved with it rather than being re-labelled.
    expect(billed.headlineUsd).not.toBeCloseTo(usage.headlineUsd, 2)
  })

  it('the budget axis changes its unallocated ROW between lanes', async () => {
    const usage = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'usage')
    const billed = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
    expect(usage.rows.map((r) => r.key)).not.toEqual(billed.rows.map((r) => r.key))
    // …while the money is the same, because the attribution does not change
    // with a display toggle. That is the honest answer, and the reason the lane
    // is declared rather than implied.
    expect(usage.headlineUsd).toBeCloseTo(billed.headlineUsd, 6)
  })
})

// ── Acceptance 4 — no billed figure is derived from a ratio ──────────────────
describe('no billed axis exposes a dimension derived from a RATIO', () => {
  /**
   * The property, stated positively: a billed figure is a function of
   * `provider_usage_fact` ALONE. So if the attributed lane changes arbitrarily
   * and a billed figure moves, that figure reads the attributed lane — which is
   * the only way a coverage ratio, a share split or a two-query in-memory fold
   * can be built.
   *
   * This is the assertion the static lane-firewall test cannot make: it inspects
   * one SQL statement at a time and a two-query fold is legal in both.
   */
  it('every billed figure is INVARIANT under an arbitrary change to the attributed lane', async () => {
    const snapshot = async () =>
      JSON.stringify(
        await Promise.all(
          BILLED_AXES.map(async (axis: BilledAxis) => {
            const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, axis, 'chargeback')
            return {
              axis,
              headlineUsd: d.headlineUsd,
              rows: d.rows,
              billedLane: d.billedLane,
            }
          }),
        ),
      )

    const before = await snapshot()

    /*
     * Move the attributed lane hard, in both directions a ratio could read:
     * more OTel coverage (which would SHRINK an `f`-scaled figure) and a new
     * tagged provider-recorded day (which would move a share split).
     */
    await t.client`UPDATE attribution_record SET cost_usd = cost_usd * 7
                    WHERE ts_event >= ${WIN.startIso}::timestamptz
                      AND ts_event <  ${WIN.endIso}::timestamptz`
    await t.client`INSERT INTO unaccounted_usage
        (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source, tagged_at)
      VALUES (${bob}::uuid, ${regionB}::uuid, ${unitB}::uuid, ${projAtlas}::uuid,
              '2026-06-02'::date, 'copilot-cli', 999, 0, 'api-reconciled', now())`
    // The project axis reads the ROLLUP since R5b — materialise the mutation
    // or the vacuity probe below reads the pre-mutation cells. This makes the
    // invariance claim STRONGER, not weaker: the billed snapshot must survive
    // the attributed mutation reaching every §A source a figure could read.
    await rebuildUsageRollup(t.db)

    try {
      // The attributed lane really did move — otherwise the invariance below is
      // vacuous and would pass against any implementation.
      const after = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'project', 'chargeback')
      expect(after.headlineUsd).toBeGreaterThan(500)

      expect(await snapshot()).toBe(before)
    } finally {
      await t.client`DELETE FROM unaccounted_usage WHERE cost_usd = 999`
      await t.client`UPDATE attribution_record SET cost_usd = cost_usd / 7
                      WHERE ts_event >= ${WIN.startIso}::timestamptz
                        AND ts_event <  ${WIN.endIso}::timestamptz`
      // Reverted on the raw tables — reverted in the rollup too, so later
      // tests in this file read the original estate.
      await rebuildUsageRollup(t.db)
    }
  })

  it('no billed row’s share is a coverage factor — shares are of the arm’s OWN total', async () => {
    const d = await fetchDrivers(t.db, wholeCompanyUsage, WIN, 'model', 'chargeback')
    // Shares foot to exactly 1 over the billed denominator. A coverage-scaled
    // axis foots to `f`, which is the tell.
    expect(d.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
    for (const r of d.rows) expect(r.sharePct).toBeCloseTo(r.usd / d.headlineUsd, 9)
  })
})

// ── Acceptance 3 (on the wire) + the export ──────────────────────────────────
/*
 * The two consumers a lane can be lost between: the HTTP response and the CSV.
 * Both are places where a lane-correct engine still ships a lane-wrong artefact
 * — the response by not declaring which lane each field is, the CSV by ignoring
 * `?lane=` and handing a reader the other lane's rows under the same filename.
 */
const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
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
          return { ...headers }
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
  return e as unknown as Parameters<typeof driversHandler>[0]
}
const finops = (): Session =>
  ({
    teammateId: '00000000-0000-0000-0000-000000000009',
    email: 'x@x.test',
    displayName: 'X',
    role: 'global-finops',
    regionId: regionA,
    orgPath: 'bua',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

const RANGE = 'region=all&from=2026-06-01&to=2026-06-04'

interface DriversResp {
  lane: string
  rows: DriverRow[]
  headlineUsd: number
  measureLanes: Record<string, string>
  billedLane?: { billedUsd: number; consumptionUsd: number }
  unallocatedUsd?: number
}

describe('GET /reports/region/drivers — no response mixes lanes without naming each field', () => {
  it('names the lane of EVERY money measure, including the ones that did not move', async () => {
    const r = (await driversHandler(
      ev(finops(), RANGE + '&axis=model&lane=chargeback'),
    )) as unknown as DriversResp
    expect(r.lane).toBe('chargeback')
    expect(r.measureLanes.rows).toBe('billed')
    expect(r.measureLanes.headlineUsd).toBe('billed')
    // The §A cohort statistic rides the same response and is NOT the selected
    // lane. Leaving it unnamed is how a reader adds it to a billed figure.
    expect(r.measureLanes.concentration).toBe('attributed')
    expect(r.measureLanes['billedLane.billedUsd']).toBe('billed')
    expect(r.measureLanes['billedLane.consumptionUsd']).toBe('billed')
  })

  it('the BUDGET axis declares `attributed` even under `?lane=chargeback`', async () => {
    const r = (await driversHandler(
      ev(finops(), RANGE + '&axis=project&lane=chargeback'),
    )) as unknown as DriversResp
    expect(r.measureLanes.rows).toBe('attributed')
    expect(r.measureLanes.unallocatedUsd).toBe('attributed')
    expect(r.billedLane).toBeUndefined()
  })

  it('switching `?lane=` changes the rows AND the declared lanes', async () => {
    const usage = (await driversHandler(
      ev(finops(), RANGE + '&axis=model'),
    )) as unknown as DriversResp
    const billed = (await driversHandler(
      ev(finops(), RANGE + '&axis=model&lane=chargeback'),
    )) as unknown as DriversResp
    expect(usage.measureLanes.rows).toBe('attributed')
    expect(billed.measureLanes.rows).toBe('billed')
    expect(billed.rows.map((r) => r.key)).not.toEqual(usage.rows.map((r) => r.key))
    expect(billed.headlineUsd).not.toBeCloseTo(usage.headlineUsd, 2)
  })

  it('an unrecognised `?lane=` falls back to usage rather than 500-ing a dashboard', async () => {
    const r = (await driversHandler(
      ev(finops(), RANGE + '&axis=model&lane=nonsense'),
    )) as unknown as DriversResp
    expect(r.lane).toBe('usage')
    expect(r.measureLanes.rows).toBe('attributed')
  })
})

describe('GET /reports/export — the CSV carries the lane it was taken in', () => {
  it('exports the BILLED rows when the screen was billed, and stamps the lane', async () => {
    const json = (await driversHandler(
      ev(finops(), RANGE + '&axis=model&lane=chargeback'),
    )) as unknown as DriversResp
    const csv = (await exportHandler(
      ev(finops(), 'scope=region&report=drivers&axis=model&lane=chargeback&' + RANGE),
    )) as unknown as string

    const lines = csv.trim().split('\n')
    expect(lines[0]).toContain('lane=billed')
    // Same rows as the screen — an export that ignored `?lane=` would carry the
    // attributed model axis instead.
    const labels = lines.slice(2).map((l) => l.split(',')[0])
    for (const r of json.rows) expect(labels).toContain(r.label)
    expect(lines.some((l) => l.startsWith('claude-opus-5,'))).toBe(true)
  })

  it('stamps `lane=attributed` on a usage-lane export', async () => {
    const csv = (await exportHandler(
      ev(finops(), 'scope=region&report=drivers&axis=model&' + RANGE),
    )) as unknown as string
    expect(csv.trim().split('\n')[0]).toContain('lane=attributed')
  })
})

// ── The export GRAIN — every figure on screen is in the file ─────────────────
/*
 * The previous export test asserted only that every `json.rows` LABEL appeared
 * somewhere in the CSV. That is the subset the serialiser already carried, so it
 * could not fail for the defect it was meant to cover: `billedLane.arms` is
 * RENDERED (the consumption blocks under the table, and — since the pooled
 * Copilot invoice landed — the arms the headline itself is folded from) and was
 * serialised nowhere. A file stamped `lane=billed` was missing money that was on
 * the screen it claims to be a copy of.
 *
 * So the assertion below is COVERAGE, not containment: it enumerates every figure
 * the JSON publishes and requires each one, with its measure named, as an exact
 * CSV line. A new rendered measure that nobody exports fails it automatically.
 */
const MONTH_RANGE = 'region=all&month=2026-06'

interface ArmJson {
  id: string
  provider: string
  measure: string
  source: string
  availability: string
  totalUsd: number
  rows: DriverRow[]
}
interface CoverageJson {
  providers: string[]
  gaps: { provider: string | null; reason: string }[]
}
interface FullDriversResp extends DriversResp {
  billedLane?: { billedUsd: number; consumptionUsd: number; arms: ArmJson[] }
  chargebackCoverage?: CoverageJson
}

describe('GET /reports/export — the CSV carries every figure the screen renders', () => {
  const prev = process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
  beforeAll(() => {
    // With the gate ON the practice axis carries all THREE arm kinds — billed,
    // consumption and pooled-chargeback — which is the only configuration in
    // which "every measure is named" is a claim with three cases to get wrong.
    process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = 'true'
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.NUXT_COPILOT_CHARGEBACK_ENABLED
    else process.env.NUXT_COPILOT_CHARGEBACK_ENABLED = prev
  })

  it('every JSON figure appears as an exact CSV line, with its measure named', async () => {
    const json = (await driversHandler(
      ev(finops(), `${MONTH_RANGE}&axis=practice&lane=chargeback`),
    )) as unknown as FullDriversResp
    const csv = (await exportHandler(
      ev(finops(), `scope=region&report=drivers&axis=practice&lane=chargeback&${MONTH_RANGE}`),
    )) as unknown as string
    const lines = csv.trim().split('\n')

    // Sanity: the response really does carry all three arm kinds, or the coverage
    // assertion below is exhaustive over a set that never had the hard case in it.
    const measures = new Set(json.billedLane!.arms.map((a) => a.measure))
    expect(measures).toEqual(new Set(['billed', 'consumption', 'pooled-chargeback']))

    const missing: string[] = []
    for (const r of json.rows) {
      const want = `${r.label},${r.usd.toFixed(2)},`
      if (!lines.some((l) => l.startsWith(want))) missing.push(`rows → ${want}`)
    }
    for (const a of json.billedLane!.arms) {
      const stem = `${a.provider},${a.measure},${a.source},${a.availability},${a.totalUsd.toFixed(2)}`
      if (a.rows.length === 0) {
        if (!lines.includes(`${stem},,`)) missing.push(`arm (empty) → ${stem}`)
        continue
      }
      for (const r of a.rows) {
        const want = `${stem},${r.label},${r.usd.toFixed(2)}`
        if (!lines.includes(want)) missing.push(`arm row → ${want}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('carries the GitHub CONSUMPTION money, which lives in NO `rows` entry', async () => {
    /*
     * The specific figure that vanished. It is on screen (DriversTable's
     * consumption block, with its own total) and is deliberately absent from the
     * billed ranking, so a "every rows label is in the file" check is blind to
     * it by construction.
     */
    const json = (await driversHandler(
      ev(finops(), `${MONTH_RANGE}&axis=practice&lane=chargeback`),
    )) as unknown as FullDriversResp
    const csv = (await exportHandler(
      ev(finops(), `scope=region&report=drivers&axis=practice&lane=chargeback&${MONTH_RANGE}`),
    )) as unknown as string

    expect(json.rows.some((r) => Math.abs(r.usd - COPILOT_CREDITS_USD) < 0.005)).toBe(false)
    expect(
      csv
        .split('\n')
        .some((l) => l.includes('github,consumption') && l.endsWith(`,${COPILOT_CREDITS_USD.toFixed(2)}`)),
    ).toBe(true)
  })

  it('stamps WHOSE charge the file is, so the qualifier outlives the page', async () => {
    // A per-model chargeback is Anthropic's alone. A CSV pasted into a deck loses
    // the on-screen note first, so the reason travels in the file.
    const csv = (await exportHandler(
      ev(finops(), `scope=region&report=drivers&axis=model&lane=chargeback&${MONTH_RANGE}`),
    )) as unknown as string
    expect(csv).toContain('# chargeback_providers=anthropic')
    expect(csv).toMatch(/# gap · github · .*pooled per Business Unit/i)
  })

  it('adds NO arm block to an attributed export', async () => {
    // The usage-lane file is byte-for-byte what it was: there is no second
    // measure to name, and an empty arm header would be a claim about a lane the
    // export never touched.
    const csv = (await exportHandler(
      ev(finops(), `scope=region&report=drivers&axis=model&${MONTH_RANGE}`),
    )) as unknown as string
    expect(csv).not.toContain('provider,measure,source,availability')
    expect(csv).not.toContain('# chargeback_providers=')
  })
})
