/*
 * The PERSONAL surfaces' lens seam (ADR 0012).
 *
 * `/` and `/consumption` both claim to show "your spend for this month". They
 * were built before the lens existed and each hard-picked a different side of
 * it without saying so, which produced the defect this module exists to make
 * unrepresentable: on /consumption a "Quota used 221%" bar sat beside a
 * "$1,449.70" headline, where the 221% was the OTHER lane's numerator over the
 * quota. A percentage with no visible operand, contradicting the number printed
 * next to it (ADR 0012 decision 4).
 *
 * The fix is SHAPE, not discipline. `buildMeHeadline` returns ONE figure and
 * every statistic derived from it — the run rate and the quota projection are
 * computed HERE, from `mtd_usd`, so a caller cannot render a quotient of one
 * lane beside the scalar of another. Both endpoints call it, so the two
 * personal surfaces cannot disagree about the same month either.
 *
 * The quota is deliberately §A-ONLY (`quota: null` under the chargeback lens).
 * A quota is allowance + allocations measured against attributed usage; putting
 * a §B numerator over it would re-create exactly the cross-lane quotient this
 * module removes. The UI says so in words rather than rendering a bar that
 * means nothing.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { SpendLens } from '../../shared/usage/lens'
import { toolLabel } from '../../shared/usage/surface'
import { VENDOR_LABELS, toolToVendor } from '../../shared/usage/vendor'
import {
  OVER_EMISSION_MIN_USD,
  OVER_EMISSION_NO_BILL_FLOOR_USD,
  OVER_EMISSION_REASON_API_UNCORROBORATED,
  OVER_EMISSION_REL,
} from '../usage/over-emission-detection'
import { quotaProjection, runRate, type QuotaProjection, type RunRate } from '../usage/projections'
import { monthToDateWindow, monthStartIso as monthStartIsoFor } from './period'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The §A quota line — allowance + allocations, and where the month stands against it. */
export interface MeQuota {
  total_usd: string
  base_allowance_usd: string
  allocation_usd: string
  projection: QuotaProjection
}

/**
 * The personal surfaces' single headline figure, with everything derived from
 * it. `mtd_usd` is the ONLY money scalar here; `run_rate` and
 * `quota.projection` are computed from it, so they cannot come from a different
 * lane than the number they are rendered beside.
 */
export interface MeHeadline {
  lane: SpendLens
  /** `YYYY-MM`, resolved from the SERVER clock at fetch time. */
  month: string
  mtd_usd: string
  run_rate: RunRate
  /** §A only — null under the chargeback lens (see the module header). */
  quota: MeQuota | null
}

/** One active personal-subscription declaration, with this month's usage behind it. */
export interface MeDeclaredPersonal {
  tool: string
  label: string
  subscription_type: string
  monthly_cost_usd: string
  declared_at: string
  /**
   * This teammate's attributed usage on this tool for the month to date, on the
   * SAME basis as the usage-lens headline (project-attributed §A rows), so the
   * disclosure is a genuine subset of the figure it is rendered under.
   */
  usage_mtd_usd: string
}

/**
 * How ONE tool's attributed usage stands against the provider usage record
 * behind THAT tool:
 *
 *   `declared`                — an active personal-subscription declaration
 *                               names this tool.
 *   `material_gap`            — no declaration for this tool, the provider
 *                               reported something for it, and the excess
 *                               clears the over-emission detector's own
 *                               materiality bar ({@link gapIsMaterial}).
 *   `provider_record_missing` — no declaration, the provider reported $0 for
 *                               this tool this month, and the attributed total
 *                               clears OVER_EMISSION_NO_BILL_FLOOR_USD (ADR
 *                               0012 decision 5a: at $0 the honest sentence is
 *                               that there is no provider record yet).
 *   `nothing_to_disclose`     — none of the above holds for this tool.
 */
export type MeToolGapState =
  | 'declared'
  | 'material_gap'
  | 'provider_record_missing'
  | 'nothing_to_disclose'

/** One tool's side of the disclosure — classified against ITS OWN declaration. */
export interface MeToolGap {
  tool: string
  label: string
  /**
   * This tool's attributed usage, month to date, over EVERY §A row — budgeted
   * and unallocated alike. A provider record covers a tool's emissions whether
   * or not they carry a project claim, so clamping this to the budgeted slice
   * (as `declared_personal.usage_mtd_usd` deliberately is) would compare a
   * subset against a whole and under-report the gap. Not rendered as a figure
   * for that reason: it is the comparison basis, not a slice of the headline.
   */
  attributed_usage_usd: string
  /** What the providers reported for THIS tool over the same month. */
  provider_reported_usd: string
  state: MeToolGapState
  /**
   * True when an OPEN `over_emission` row exists for this tool this month —
   * i.e. `GET /api/v1/me/over-emission` really is returning a review item for
   * it and the dashboard really is rendering one. The copy may promise a review
   * only when this is true (ADR 0012 decision 5a: no promise of a review that
   * will not run — the detector's settled-bill lag means a mismatch from the
   * last few days has deliberately not been raised yet).
   */
  has_open_review: boolean
}

/**
 * The "what is and is not chargeable" disclosure (ADR 0012 decision 5).
 *
 * Where the lenses disagree materially the REASON is owed to the viewer — but a
 * DECLARED personal subscription is a disclosure, not an alarm. The declaration
 * UI already promises that declared usage "is never flagged as suspicious for
 * having no Insight bill behind it", so this carries the explanation rather
 * than a warning; the undeclared case is what the over-emission detector owns.
 *
 * The classification is PER TOOL (`tool_gaps`), because a declaration explains
 * only the tool it names — `personal_subscription_declaration` is scoped to one
 * tool, and so is the carve-out the detector applies to it. A single
 * account-wide "is the gap material" boolean let a declared Claude subscription
 * swallow an undeclared Copilot over-emission, which is the opposite of what
 * decision 5 asks the surface to do.
 *
 * Materiality reuses the detector's OWN constants rather than inventing a
 * second threshold — if the product considers a gap material enough to flag, it
 * is material enough to explain.
 */
export interface MeLensDisclosure {
  attributed_usage_usd: string
  provider_reported_usd: string
  chargeable_usd: string
  declared_personal: MeDeclaredPersonal[]
  declared_personal_usage_usd: string
  /** One row per tool with attributed usage this month, tool order. */
  tool_gaps: MeToolGap[]
  /**
   * The caller's home cost-owning unit, human and region-qualified
   * (`APAC · CTO`), or null when their placement resolves to no cost-owning
   * ancestor. See {@link getMyCostCentre}.
   */
  cost_centre: string | null
  /** See {@link MeBillingState} — the three states, each on its own basis. */
  billing_states: MeBillingState[]
}

/**
 * Why a dollar does or does not reach the caller's cost centre.
 *
 *   `declared-personal` — the caller has an active personal-subscription
 *                         declaration for this tool. There is no Insight
 *                         invoice behind it, so no bill exists to charge.
 *   `exempt`            — the ORG's provider agreement is `tracked`
 *                         (`provider_org.billing` / `provider_enterprise.billing`
 *                         — ADR-0011 D1), which sets `actual_spend.chargeback_exempt`
 *                         with `governance_verdict_source = 'governance:tracked'`.
 *                         Real usage the provider does not invoice. A property of
 *                         THIS org's agreement, never of the tool.
 *   `charged`           — the row reaches `v_finance_bill_chargeback`: invoiced,
 *                         and charged to the cost centre.
 *
 * WHAT THIS COVERS, stated as what IS covered rather than what is not:
 *
 *   - `declared-personal` covers every active declaration with attributed usage
 *     this month (`getMyDeclaredPersonal`, §A `v_complete_usage`).
 *   - `exempt` covers `actual_spend` rows this month whose exemption came from
 *     the governance verdict `governance:tracked` — the ONE source that means
 *     "the agreement says do not bill this". Rows exempted by `unresolved` (the
 *     governance key could not be resolved) or by the pre-cutover
 *     `legacy-heuristic` are NOT reported here, because neither is evidence of
 *     an NFR agreement and the copy above these rows names one.
 *   - `charged` covers every row in `v_finance_bill_chargeback` for the month,
 *     so Σ(charged) IS `chargeable_usd` — the same view over the same window.
 *
 * THE THREE ARE NOT ONE ALGEBRA, and the surfaces that render them must not
 * imply they are. `declared-personal` is attributed USAGE (§A); `exempt` and
 * `charged` are provider-recorded amounts (§B, `actual_spend`). They do not sum
 * to the month, and a tool can legitimately appear TWICE — migration 0105:16-19
 * states that "a declaration NEVER changes an actual_spend chargeback verdict",
 * so provider-backed and personal usage coexisting for one (teammate, tool) is a
 * supported state, not a bug. No precedence is applied here for exactly that
 * reason: suppressing the charged row of a declared tool would make Σ(charged)
 * disagree with `chargeable_usd`.
 */
export type MeBillingStateKind = 'declared-personal' | 'exempt' | 'charged'

export interface MeBillingState {
  tool: string
  label: string
  state: MeBillingStateKind
  /**
   * `declared-personal`: attributed usage on the tool, month to date (§A).
   * `exempt` / `charged`: the provider-recorded amount, month to date (§B).
   * The rendered sentence names which of the two it is, per row.
   */
  usd: string
  /** The declaration's own `subscription_type`; null on the other two states. */
  subscription_type: string | null
}

/**
 * §B cost of record for ONE teammate, month to date.
 *
 * `v_finance_bill_chargeback` is the chargeback root view: `actual_spend` minus
 * the chargeback-exempt rows, minus the whole GitHub lane set (migration 0085's
 * firewall). That exclusion is not a gap here — Copilot is billed POOLED per
 * cost centre and has no per-person charge to report — but it does mean this
 * figure is Anthropic-only, and the surfaces that render it say so.
 *
 * Scope gate: the explicit `teammate_id` predicate. The view is
 * `security_invoker`, and `teammate`'s RLS policy always admits the caller's own
 * row, so a caller can only ever total their own bill.
 */
export async function getMyChargeableMtd(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
): Promise<string> {
  const monthStart = monthStartIsoFor(now).slice(0, 10)
  const today = now.toISOString().slice(0, 10)
  const rows = await tx.execute<{ usd: string }>(sql`
    SELECT COALESCE(SUM(bill_usd), 0)::text AS usd
      FROM v_finance_bill_chargeback
     WHERE teammate_id = ${teammateId}::uuid
       AND period_date >= ${monthStart}::date
       AND period_date <= ${today}::date
  `)
  return Number([...rows][0]?.usd ?? 0).toFixed(2)
}

/**
 * The caller's ACTIVE personal-subscription declarations, each with the
 * month-to-date attributed usage sitting behind it.
 *
 * UNCLAMPED — every §A row for the tool, whether or not it carries a project
 * claim. It used to be clamped to `project_id IS NOT NULL`, justified by the
 * usage-lens headline being the sum of the developer's project buckets. That
 * stopped being true: both callers of `buildMeLensDisclosure` now pass budgeted
 * PLUS unallocated (ADR 0012 decision 1a), so a clamped declared figure would
 * be a subset of a whole and would understate the declared-personal share of
 * the very number printed above it — which is exactly what decision 5 owes the
 * reader. `getMyToolGaps` below is unclamped for the same reason; the two are
 * siblings and drifted apart once already.
 */
export async function getMyDeclaredPersonal(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
): Promise<MeDeclaredPersonal[]> {
  const monthStartIso = monthStartIsoFor(now)
  const spendEndIso = monthToDateWindow(now).endIso
  const rows = await tx.execute<{
    tool: string
    subscription_type: string
    monthly_cost_usd: string
    declared_at: string
    usage_usd: string
  }>(sql`
    SELECT psd.tool,
           psd.subscription_type,
           psd.monthly_cost_usd::text AS monthly_cost_usd,
           psd.declared_at::text      AS declared_at,
           COALESCE((
             SELECT SUM(u.cost_usd)
               FROM v_complete_usage u
              WHERE u.teammate_id = psd.teammate_id
                AND u.tool = psd.tool
                /*
                 * INTERSECTED WITH THE DECLARATION'S OWN INTERVAL, not just
                 * the month. Bounding on the month alone let a declaration
                 * made on the 30th claim every dollar spent since the 1st —
                 * the reader is told $6,000 is on a personal subscription
                 * that did not exist for 29 of those days. The admin view
                 * already does this correctly
                 * (admin/governance/personal-subscriptions.get.ts): a sibling
                 * that got it right while this one did not.
                 */
                /*
                 * Lower bound only. The upper bound is the month-to-date end,
                 * full stop — a LEAST(..., COALESCE(psd.revoked_at, ...))
                 * looks symmetric but is DEAD CODE, because the WHERE below
                 * already requires revoked_at IS NULL. It could never be
                 * anything but spendEnd. An external reviewer deleted the
                 * clause and all 42 tests stayed green, which is what dead
                 * code looks like from the outside.
                 *
                 * (No backtick may appear in this comment. It sits INSIDE a
                 * sql template literal, so one closes the query mid-comment
                 * and the parse error lands on a line that looks fine.)
                 */
                AND u.ts_event >= GREATEST(${monthStartIso}::timestamptz, psd.declared_at)
                AND u.ts_event <  ${spendEndIso}::timestamptz
           ), 0)::text AS usage_usd
      FROM personal_subscription_declaration psd
     WHERE psd.teammate_id = ${teammateId}::uuid
       AND psd.revoked_at IS NULL
       /*
        * The declaration must OVERLAP the window, not merely exist. Without
        * this a declaration dated in the FUTURE still returns a row, whose
        * usage subquery is empty and whose COALESCE reports $0.00 — the reader
        * is shown a plan that has not started yet, quoting a figure of zero as
        * if it were a measurement. The admin governance view carries the same
        * predicate.
        */
       AND psd.declared_at < ${spendEndIso}::timestamptz
     ORDER BY psd.tool
  `)
  return [...rows].map((r) => ({
    tool: r.tool,
    label: toolLabel(r.tool),
    subscription_type: r.subscription_type,
    monthly_cost_usd: Number(r.monthly_cost_usd).toFixed(2),
    declared_at: r.declared_at,
    usage_mtd_usd: Number(r.usage_usd).toFixed(2),
  }))
}

/**
 * True when attributed usage exceeds what the providers reported by enough that
 * the over-emission detector would care: same constants, same shape
 * (`over > GREATEST(floor, rel × reported)`).
 *
 * SHARED CONSTANTS, NOT A SHARED VERDICT. This is deliberately not a claim that
 * the two can never disagree, because they routinely do and the disclosure is
 * built around that:
 *
 *   - GRAIN — the detector asks per DAY, this asks per MONTH. A month whose
 *     excess is spread thinly clears the monthly bar and no daily one.
 *   - BASIS — the detector reads `attribution_record` (OTel only); this reads
 *     `v_complete_usage`, so arms 2 and 3 are in the numerator here.
 *   - SETTLING — the detector leaves the trailing OVER_EMISSION_SETTLED_LAG_DAYS
 *     alone, so this month's last few days have no verdict yet either way.
 *
 * `MeToolGap.has_open_review` exists to carry that difference into the copy: it
 * reports what the detector has ACTUALLY raised, so the sentence about a gap and
 * the sentence about a review are gated separately and neither implies the other.
 */
export function gapIsMaterial(attributedUsd: number, providerReportedUsd: number): boolean {
  /*
   * The detector's `api_usd > 0` guard, honoured here (ADR 0012 decision 5a).
   *
   * over-emission-detection.ts requires it DELIBERATELY: an unreconciled
   * provider org reports $0, which is indistinguishable from "this person spent
   * nothing". Without the same guard this disclosure fires at
   * providerReportedUsd === 0 while the detector stays silent — and the copy
   * promising that such days "are raised for review" would be false, which is
   * precisely the defect class this ADR exists to stop.
   *
   * At $0 the honest statement is that there is no provider record for the
   * month yet, not an over-emission story. The caller renders that instead.
   */
  if (providerReportedUsd <= 0) return false
  const over = attributedUsd - providerReportedUsd
  return over > Math.max(OVER_EMISSION_MIN_USD, OVER_EMISSION_REL * providerReportedUsd)
}

/**
 * Classify ONE tool's month against its OWN declaration and its OWN provider
 * record. Pure, so the truth table is testable without a database.
 *
 * The `provider_record_missing` floor is the detector's own no-bill floor
 * (`OVER_EMISSION_NO_BILL_FLOOR_USD`) — decision 5a's "one definition of
 * material, reuse the detector's constants" applied to the api=0 branch, the
 * same way {@link gapIsMaterial} applies it to the api>0 branch. The detector
 * measures that floor per DAY and this measures it per MONTH, so this sentence
 * can appear for a month the detector's per-day prompt lane never fired on;
 * that is why it promises nothing about a review and only states the absence of
 * a provider record.
 */
export function classifyToolGap(args: {
  attributedUsd: number
  providerReportedUsd: number
  isDeclared: boolean
}): MeToolGapState {
  if (args.isDeclared) return 'declared'
  if (args.providerReportedUsd > 0) {
    return gapIsMaterial(args.attributedUsd, args.providerReportedUsd)
      ? 'material_gap'
      : 'nothing_to_disclose'
  }
  return args.attributedUsd > OVER_EMISSION_NO_BILL_FLOOR_USD
    ? 'provider_record_missing'
    : 'nothing_to_disclose'
}

/**
 * The caller's month, TOOL BY TOOL: attributed usage from the §A seam, the
 * provider record for the same tool, whether a declaration names it, and
 * whether an open review row exists for it.
 *
 * Windows, and why each is the one it is:
 *   - attributed: `[month start, now)` over `v_complete_usage` — the same seam
 *     and the same month-to-date bound `getMyUsage` reads, but WITHOUT its
 *     `project_id IS NOT NULL` clamp (see `MeToolGap.attributed_usage_usd`).
 *   - provider-reported: `day >= month start` over `v_teammate_usage_daily` —
 *     the bound `getMyProviderTruthMtd` uses, so a tool's figure here is on the
 *     same basis as the `provider_reported_usd` scalar rendered above it.
 *   - open reviews: this month's OPEN `over_emission` rows. A SUBSET of what
 *     `GET /api/v1/me/over-emission` returns for the dashboard, which has no
 *     month bound — so `has_open_review` true always means the dashboard is
 *     showing it, and the copy that points there is safe in that direction.
 *
 * Scope gate: the explicit `teammate_id` predicate on every arm — every figure
 * is clamped to the caller's own rows by the query itself, not by whatever the
 * underlying views and policies would otherwise admit.
 */
export async function getMyToolGaps(
  tx: Tx,
  teammateId: string,
  now: Date = new Date(),
): Promise<MeToolGap[]> {
  const monthStartIso = monthStartIsoFor(now)
  const spendEndIso = monthToDateWindow(now).endIso
  const monthStartDay = monthStartIso.slice(0, 10)
  const rows = await tx.execute<{
    tool: string
    attributed_usd: string
    reported_usd: string
    is_declared: boolean
    has_open_review: boolean
  }>(sql`
    WITH attributed AS (
      SELECT u.tool, SUM(u.cost_usd) AS usd
        FROM v_complete_usage u
       WHERE u.teammate_id = ${teammateId}::uuid
         AND u.ts_event >= ${monthStartIso}::timestamptz
         AND u.ts_event <  ${spendEndIso}::timestamptz
       GROUP BY u.tool
    ),
    reported AS (
      SELECT d.tool, SUM(d.usage_usd) AS usd
        FROM v_teammate_usage_daily d
       WHERE d.teammate_id = ${teammateId}::uuid
         AND d.day >= ${monthStartDay}::date
       GROUP BY d.tool
    ),
    declared AS (
      SELECT DISTINCT psd.tool
        FROM personal_subscription_declaration psd
       WHERE psd.teammate_id = ${teammateId}::uuid
         AND psd.revoked_at IS NULL
    ),
    reviewed AS (
      SELECT DISTINCT oe.tool
        FROM over_emission oe
       WHERE oe.teammate_id = ${teammateId}::uuid
         AND oe.state = 'open'
         AND oe.over_usd > 0
         AND oe.day >= ${monthStartDay}::date
         -- Same lane filter as GET /api/v1/me/over-emission (mig 0132). This CTE's
         -- contract is that it is a SUBSET of that route's result; a
         -- 'no-bill-to-corroborate' row here would promise a review the dashboard
         -- never shows.
         AND oe.reason = ${OVER_EMISSION_REASON_API_UNCORROBORATED}
    )
    SELECT a.tool,
           a.usd::text                     AS attributed_usd,
           COALESCE(r.usd, 0)::text        AS reported_usd,
           (d.tool IS NOT NULL)            AS is_declared,
           (rv.tool IS NOT NULL)           AS has_open_review
      FROM attributed a
      LEFT JOIN reported r  ON r.tool  = a.tool
      LEFT JOIN declared d  ON d.tool  = a.tool
      LEFT JOIN reviewed rv ON rv.tool = a.tool
     WHERE a.usd > 0
     ORDER BY a.tool
  `)
  return [...rows].map((r) => {
    const attributedUsd = Number(r.attributed_usd)
    const providerReportedUsd = Number(r.reported_usd)
    return {
      tool: r.tool,
      /*
       * The vendor LANE name ("Copilot"), not the raw tool id, because this
       * label lands mid-sentence in front of a reader. `toolToVendor` maps
       * anything unrecognised to 'other', whose label is the word "Other" — so
       * the fallback is on the LANE, not on `VENDOR_LABELS` (a total record,
       * where `??` could never fire). An unlaned tool gets its own tidied name
       * rather than "Your Other usage this month is materially higher…".
       */
      label:
        toolToVendor(r.tool) === 'other'
          ? toolLabel(r.tool)
          : VENDOR_LABELS[toolToVendor(r.tool)],
      attributed_usage_usd: attributedUsd.toFixed(2),
      provider_reported_usd: providerReportedUsd.toFixed(2),
      state: classifyToolGap({
        attributedUsd,
        providerReportedUsd,
        isDeclared: r.is_declared,
      }),
      has_open_review: r.has_open_review,
    }
  })
}

/**
 * The caller's home cost-owning unit, formatted for PROSE: the region's human
 * name, then the unit's human name — `APAC · CTO`.
 *
 * Region-qualified because `org_unit.code` is unique only per region
 * (`org_unit_region_code_unique`), so short unit names genuinely repeat across
 * regions and a bare "CTO" is ambiguous. The SLUG (`apac-cto`) is deliberately
 * not returned: it is an identifier to search, copy or put in a URL, and it
 * never belongs mid-sentence.
 *
 * Null when the caller's placement has no cost-owning ancestor. `teammate.
 * org_unit_id` is NOT NULL, but `v_org_unit_cost_owner` is deliberately total
 * via a LEFT JOIN (mig 0114), so `cost_owning_unit_region_id` can be null and
 * the join below then yields no row. Callers must have a subject that does not
 * name a unit.
 *
 * Scope gate: the explicit `t.id` predicate — the caller can only ever resolve
 * their own placement.
 */
export async function getMyCostCentre(tx: Tx, teammateId: string): Promise<string | null> {
  const rows = await tx.execute<{ region_name: string; unit_name: string }>(sql`
    SELECT r.display_name          AS region_name,
           c.cost_owning_unit_name AS unit_name
      FROM teammate t
      JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
      JOIN region r                ON r.id = c.cost_owning_unit_region_id
     WHERE t.id = ${teammateId}::uuid
  `)
  const row = [...rows][0]
  if (!row?.region_name || !row?.unit_name) return null
  return `${row.region_name} · ${row.unit_name}`
}

/**
 * The caller's month split by BILLING STATE — see {@link MeBillingState} for
 * what each state means, what it covers, and why the three do not sum.
 *
 * `declared` is passed in rather than re-queried: `buildMeLensDisclosure`
 * already has it, and re-reading would risk the two disagreeing about the same
 * month.
 *
 * Windows: the §B arms use `getMyChargeableMtd`'s inclusive day bounds, so the
 * charged rows sum to exactly the `chargeable_usd` scalar rendered beside them.
 *
 * Scope gate: an explicit `teammate_id` predicate on both arms. `actual_spend`
 * carries NO RLS policy of its own, so the predicate — not the session — is what
 * clamps this to the caller's rows.
 */
export async function getMyBillingStates(
  tx: Tx,
  teammateId: string,
  declared: MeDeclaredPersonal[],
  now: Date = new Date(),
): Promise<MeBillingState[]> {
  const monthStart = monthStartIsoFor(now).slice(0, 10)
  const today = now.toISOString().slice(0, 10)
  const rows = await tx.execute<{ state: string; tool: string; usd: string }>(sql`
    WITH exempt AS (
      SELECT a.tool, SUM(a.cost_usd) AS usd
        FROM actual_spend a
       WHERE a.teammate_id = ${teammateId}::uuid
         AND a.chargeback_exempt
         AND a.governance_verdict_source = 'governance:tracked'
         AND a.date >= ${monthStart}::date
         AND a.date <= ${today}::date
       GROUP BY a.tool
    ),
    charged AS (
      SELECT b.tool, SUM(b.bill_usd) AS usd
        FROM v_finance_bill_chargeback b
       WHERE b.teammate_id = ${teammateId}::uuid
         AND b.period_date >= ${monthStart}::date
         AND b.period_date <= ${today}::date
       GROUP BY b.tool
    )
    SELECT 'exempt'::text AS state, tool, usd::text AS usd FROM exempt  WHERE usd > 0
    UNION ALL
    SELECT 'charged'::text AS state, tool, usd::text AS usd FROM charged WHERE usd > 0
    ORDER BY state, tool
  `)
  const provider = [...rows].map(
    (r): MeBillingState => ({
      tool: r.tool,
      label: toolLabel(r.tool),
      state: r.state === 'exempt' ? 'exempt' : 'charged',
      usd: Number(r.usd).toFixed(2),
      subscription_type: null,
    }),
  )
  const personal = declared
    .filter((d) => Number(d.usage_mtd_usd) > 0)
    .map(
      (d): MeBillingState => ({
        tool: d.tool,
        label: d.label,
        state: 'declared-personal',
        usd: d.usage_mtd_usd,
        subscription_type: d.subscription_type,
      }),
    )
  // Declared first, then exempt, then charged — the order the disclosure reads
  // them in: no bill exists, no bill is raised, a bill is raised.
  return [
    ...personal,
    ...provider.filter((p) => p.state === 'exempt'),
    ...provider.filter((p) => p.state === 'charged'),
  ]
}

/**
 * The headline figure for a personal surface, under the selected lens, with
 * every statistic beside it computed from that same figure.
 *
 * `attributedUsageUsd` / `quota` come from the caller's existing `getMyUsage`
 * read so the usage lane keeps ONE source; the chargeback lane is read here.
 */
export async function buildMeHeadline(
  tx: Tx,
  args: {
    teammateId: string
    lane: SpendLens
    attributedUsageUsd: string
    baseAllowanceUsd: string
    allocationUsd: string
    quotaUsd: string
    now?: Date
  },
): Promise<MeHeadline> {
  const now = args.now ?? new Date()
  const month = monthStartIsoFor(now).slice(0, 7)

  if (args.lane === 'chargeback') {
    const chargeable = await getMyChargeableMtd(tx, args.teammateId, now)
    return {
      lane: 'chargeback',
      month,
      mtd_usd: chargeable,
      run_rate: runRate(Number(chargeable), now),
      // A quota measures attributed usage. Rendering a §B numerator over it is
      // the cross-lane quotient ADR 0012 decision 4 forbids.
      quota: null,
    }
  }

  const mtd = Number(args.attributedUsageUsd)
  return {
    lane: 'usage',
    month,
    mtd_usd: Number(args.attributedUsageUsd).toFixed(2),
    run_rate: runRate(mtd, now),
    quota: {
      total_usd: args.quotaUsd,
      base_allowance_usd: args.baseAllowanceUsd,
      allocation_usd: args.allocationUsd,
      projection: quotaProjection(mtd, Number(args.quotaUsd), now),
    },
  }
}

/** The decision-5 disclosure for one teammate, month to date. */
export async function buildMeLensDisclosure(
  tx: Tx,
  args: {
    teammateId: string
    attributedUsageUsd: string
    providerReportedUsd: string
    now?: Date
  },
): Promise<MeLensDisclosure> {
  const now = args.now ?? new Date()
  const [chargeable, declared, toolGaps, costCentre] = await Promise.all([
    getMyChargeableMtd(tx, args.teammateId, now),
    getMyDeclaredPersonal(tx, args.teammateId, now),
    getMyToolGaps(tx, args.teammateId, now),
    getMyCostCentre(tx, args.teammateId),
  ])
  // Sequenced after `declared` rather than joined into the Promise.all: it
  // reuses that result so the declared rows here and the declared rows above
  // are the same read of the same month.
  const billingStates = await getMyBillingStates(tx, args.teammateId, declared, now)
  const declaredUsage = declared.reduce((acc, d) => acc + Number(d.usage_mtd_usd), 0)
  return {
    attributed_usage_usd: Number(args.attributedUsageUsd).toFixed(2),
    provider_reported_usd: Number(args.providerReportedUsd).toFixed(2),
    chargeable_usd: chargeable,
    declared_personal: declared,
    declared_personal_usage_usd: declaredUsage.toFixed(2),
    tool_gaps: toolGaps,
    cost_centre: costCentre,
    billing_states: billingStates,
  }
}
