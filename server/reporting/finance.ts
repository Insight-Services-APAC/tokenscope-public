/*
 * reporting/finance — the query layer behind the FINANCE (end-of-month) reporting
 * scope (docs/design/reporting-consolidation/00-build-design.md §2/§3/§4/§5,
 * Wave 5; owner-decisions 02-owner-decisions.md D-Q5/D-Q6/D-Homing/D-Q8).
 *
 * This is the most correctness-sensitive scope: the chargeback pack global finance
 * validates the bill against and x-charges from. It reads the §B bill lanes ONLY —
 *   - per-CoU chargeback  → `v_finance_chargeback_month` (Anthropic month-rolled ∪
 *     Copilot per-org pooled net, org→CoU-map-homed) — grain (cou, tool, month).
 *   - the VISIBLE Σ=bill check → Σ chargeback vs `v_finance_bill_totals_month`
 *     (each provider from EXACTLY one authoritative surface). A mismatch OR an
 *     UNSETTLED month (a Copilot month with usage but no read license SKU) shows
 *     RED "unsettled" — never a silent pass (build-design §7(1), risk 7).
 *   - Anthropic per-teammate charges → `v_finance_bill_chargeback` (teammate-homed).
 *   - Copilot per-org pooled lines  → `copilot_pool_bill` (org→CoU map, mig 0080).
 *   - project overlay               → `v_finance_project_overlay` (chargeable split).
 * The one §A read is the exempt-gap card's INDICATIVE usage total (`v_complete_usage`)
 * and the Overage-Drivers per-teammate usage weight (`v_teammate_usage_daily` copilot
 * branch) — a §A DISPLAY weight, NEVER a charge (D-Q6 layer 3).
 *
 * HOMING (D-Homing = point-in-time) — CURRENT-ORG INTERIM. The canonical Anthropic
 * chargeback view homes teammate bill rows to their CURRENT org (mig 0059/0081); the
 * owner decision is point-in-time (home to the CoU AS-OF the billing month so a
 * teammate move never restates a closed month). Point-in-time teammate→CoU homing is
 * NOT cleanly derivable from existing data: `actual_spend` (the Anthropic bill, the
 * chargeback source of record) captures NO org dimension at bill time (only
 * teammate/date/tool/cost/source); there is NO teammate→org placement history table
 * (`teammate.org_unit_id` is overwritten in place by the placement workers); and
 * `spend_rollup_daily`'s point-in-time org context is the rate-carded USAGE lane, not
 * the bill, and is incomplete for un-enrolled days. So we consume the current-org
 * views AS-IS, label every finance surface "homed to current org structure", and the
 * report FLAGS point-in-time as needing a scoped org-history (SCD) follow-up. This is
 * acceptable for the build because chargeback MODE is separately gated on Wave-0
 * live-validation (`copilot.mode`); see build-design §0(5), risk 3, mig 0079 note.
 *
 * No reporting query here touches `attribution_record` or raw provider-bill tables
 * (the lane firewall, build-design §7(7) — test-enforced over `server/reporting/**`;
 * the Σ=bill term reads `v_finance_bill_totals_month`, keeping the firewall
 * exception-free). Copilot chargeback is gated on `copilot.mode` (build-design §6).
 *
 * These are the SAME functions `/reports/export` calls, so the ledger CSV is
 * byte-identical to the screen figures (build-design §2 "byte-identical rule").
 */
import { sql } from 'drizzle-orm'
import { createError } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { csvEscape } from '../utils/csv-escape'
import { monthKeyUtc } from '../utils/period'
import type { UsageWindow } from './params'
import type { DriverRow, SpendClass } from '../../shared/reports/types'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** On-surface homing disclosure (D-Homing interim — see the file header). */
export const HOMING_NOTE =
  'Chargeback rows are homed to the current org structure. Point-in-time homing (charging to the CoU as-of the billing month, so a teammate move never restates a closed month) needs an org-history mechanism — a scoped follow-up.'

/**
 * The last COMPLETE calendar month (the month before `now`'s UTC month) as
 * `YYYY-MM` — the Finance default (you cannot chargeback an in-progress month).
 * `Date.UTC(y, m, 0)` = day 0 of the current month = the last day of the prior one.
 */
export function lastCompleteMonth(now: Date): string {
  return monthKeyUtc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)))
}

/**
 * The window's inclusive lower / exclusive upper date keys the monthly bill views
 * group on. For a calendar-month window these are `YYYY-MM-01` and the next
 * month-start; the index queries filter `period_month >= start AND period_month <
 * end`, which reduces to exactly `period_month = start` for a single month
 * (byte-identical) and sums the whole `period_month`s a custom range spans.
 */
function monthStartDate(range: UsageWindow): string {
  return range.startIso.slice(0, 10)
}
function nextMonthDate(range: UsageWindow): string {
  return range.endIso.slice(0, 10)
}

// ── The Σ=bill check row (VISIBLE reconciliation) ─────────────────────────────
export interface FinanceBillProvider {
  provider: string
  billUsd: number
  /** A Copilot month with usage but no read license SKU (missing line → unsettled). */
  unsettled: boolean
}

export interface FinanceBillCheck {
  /** Σ `v_finance_chargeback_month` for the month (Anthropic ∪ Copilot pooled net). */
  chargebackUsd: number
  /** Σ `v_finance_bill_totals_month` for the month (each provider one surface). */
  billUsd: number
  /** chargeback − bill (structurally ~0; a non-zero delta is a real reconciliation break). */
  deltaUsd: number
  /** true iff the chargeback reconciles to the bill AND no provider month is unsettled. */
  matched: boolean
  /** true when ANY provider month is unsettled (missing license SKU) → RED. */
  unsettled: boolean
  /**
   * The Copilot pooled-net portion of the whole-company chargeback (`tool = 'copilot-cli'`).
   * The Σ=bill check is whole-truth (includes this), but the per-CoU Chargeable column holds
   * Copilot back in pool-utilisation mode — this is the exact held-back delta the UI captions
   * with so the GREEN Σ=bill headline reconciles to the smaller Chargeable footing (M1).
   */
  copilotChargebackUsd: number
  providers: FinanceBillProvider[]
}

/**
 * The whole-company Σ=bill reconciliation for the month. Deliberately GLOBAL (never
 * region-filtered): the entire bill must reconcile to the entire chargeback — a
 * region view of the CoU table does not narrow the reconciliation obligation. RED
 * on a delta OR an unsettled provider month; the amounts are always surfaced so an
 * unsettled month is never a silent pass (build-design §7(1), risk 7; D gate fold-in).
 */
export async function fetchFinanceBillCheck(
  tx: Tx,
  range: UsageWindow,
): Promise<FinanceBillCheck> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)

  const [cb] = [
    ...(await tx.execute<{ total: string; copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS total,
             COALESCE(SUM(charge_usd) FILTER (WHERE tool = 'copilot-cli'), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE period_month >= ${start}::date AND period_month < ${end}::date`)),
  ]

  const billRows = await tx.execute<{ provider: string; bill: string; unsettled: boolean }>(sql`
    SELECT provider, COALESCE(SUM(bill_usd), 0)::text AS bill, bool_or(unsettled) AS unsettled
    FROM v_finance_bill_totals_month
    WHERE period_month >= ${start}::date AND period_month < ${end}::date
    GROUP BY provider
    ORDER BY provider`)

  const providers: FinanceBillProvider[] = [...billRows].map((r) => ({
    provider: r.provider,
    billUsd: Number(r.bill),
    unsettled: Boolean(r.unsettled),
  }))
  const chargebackUsd = Number(cb?.total ?? 0)
  const copilotChargebackUsd = Number(cb?.copilot ?? 0)
  const billUsd = providers.reduce((a, p) => a + p.billUsd, 0)
  const deltaUsd = chargebackUsd - billUsd
  const unsettled = providers.some((p) => p.unsettled)
  return {
    chargebackUsd,
    billUsd,
    deltaUsd,
    matched: Math.abs(deltaUsd) < 0.005 && !unsettled,
    unsettled,
    copilotChargebackUsd,
    providers,
  }
}

// ── Per-CoU chargeback (index table) ──────────────────────────────────────────
export interface FinanceCouRow {
  /** null = the VISIBLE unallocated bucket (unmapped org / enterprise residual / no CoU). */
  couId: string | null
  code: string | null
  displayName: string
  regionCode: string | null
  /** Anthropic per-teammate chargeable, month-rolled (exempt-excluded). */
  anthropicUsd: number
  /** Copilot per-org pooled NET (chargeback lane); held back from the total when pending. */
  copilotUsd: number
  /** true in pool-utilisation mode — Copilot chargeback is not folded into the total. */
  copilotPending: boolean
  /** anthropicUsd + (chargeback mode ? copilotUsd : 0). */
  chargeableUsd: number
}

/**
 * Per-CoU chargeback for the month from `v_finance_chargeback_month`. The NULL-CoU
 * bucket is retained as an explicit "Unallocated" row (never dropped). `region`
 * filters the TABLE only (a convenience view for global-finops — never a gate
 * relaxation; the caller is already whole-company). `copilotChargeback` decides
 * whether the Copilot pooled net folds into `chargeableUsd` or is held back pending
 * (build-design §6).
 */
export async function fetchFinanceCous(
  tx: Tx,
  range: UsageWindow,
  opts: { copilotChargeback: boolean; region?: string | null },
): Promise<FinanceCouRow[]> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const region = opts.region ?? null
  const rows = await tx.execute<{
    cou_id: string | null
    code: string | null
    display_name: string | null
    region_code: string | null
    anthropic: string
    copilot: string
  }>(sql`
    SELECT c.cost_owning_unit_id::text AS cou_id, ou.code, ou.display_name, r.code AS region_code,
           COALESCE(SUM(c.charge_usd) FILTER (WHERE c.tool <> 'copilot-cli'), 0)::text AS anthropic,
           COALESCE(SUM(c.charge_usd) FILTER (WHERE c.tool = 'copilot-cli'), 0)::text  AS copilot
    FROM v_finance_chargeback_month c
    LEFT JOIN org_unit ou ON ou.id = c.cost_owning_unit_id
    LEFT JOIN region r ON r.id = c.region_id
    WHERE c.period_month >= ${start}::date AND c.period_month < ${end}::date
      AND (${region}::uuid IS NULL OR c.region_id = ${region}::uuid)
    GROUP BY c.cost_owning_unit_id, ou.code, ou.display_name, r.code`)

  return [...rows]
    .map((r) => {
      const anthropicUsd = Number(r.anthropic)
      const copilotUsd = Number(r.copilot)
      return {
        couId: r.cou_id,
        code: r.code,
        displayName: r.display_name ?? 'Unallocated',
        regionCode: r.region_code,
        anthropicUsd,
        copilotUsd,
        copilotPending: !opts.copilotChargeback,
        chargeableUsd: anthropicUsd + (opts.copilotChargeback ? copilotUsd : 0),
      }
    })
    .sort((a, b) => b.anthropicUsd + b.copilotUsd - (a.anthropicUsd + a.copilotUsd))
}

// ── Exempt gap (indicative usage lane − chargeback) ───────────────────────────
export interface FinanceExemptGap {
  /** Σ `v_complete_usage` genuine usage for the month (the §A indicative lane). */
  indicativeUsageUsd: number
  /** Σ `v_finance_chargeback_month` for the month (the §B chargeable lane). */
  chargebackUsd: number
  /** indicativeUsage − chargeback: usage the bill did not (or cannot) charge (exempt/pooled). */
  gapUsd: number
  /**
   * The Copilot pooled-net portion of this (region-scoped) chargeback. The gap is whole-truth
   * (chargeback includes Copilot), but the per-CoU Chargeable column holds Copilot back in
   * pool-utilisation mode — the UI captions this figure so the card reads mode-consistently (M1).
   */
  copilotChargebackUsd: number
}

/**
 * The exempt gap — usage-lane INDICATIVE total minus chargeback (build-design §2/§4,
 * violation 4: NOT showback−chargeback; exempt orgs are never written to bill
 * surfaces, so their spend only ever appears in the usage lane). A whole-company
 * summary figure (both operands are whole-month sums — no per-CoU axis mix, so the
 * two-axis trap never fires). Region-filtered for the convenience view when set.
 */
export async function fetchFinanceExemptGap(
  tx: Tx,
  range: UsageWindow,
  opts: { region?: string | null } = {},
): Promise<FinanceExemptGap> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const region = opts.region ?? null

  const [usage] = [
    ...(await tx.execute<{ usage: string }>(sql`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS usage
      FROM v_complete_usage
      WHERE ts_event >= ${range.startIso}::timestamptz
        AND ts_event <  ${range.endIso}::timestamptz
        AND (${region}::uuid IS NULL OR region_id = ${region}::uuid)`)),
  ]
  const [cb] = [
    ...(await tx.execute<{ total: string; copilot: string }>(sql`
      SELECT COALESCE(SUM(charge_usd), 0)::text AS total,
             COALESCE(SUM(charge_usd) FILTER (WHERE tool = 'copilot-cli'), 0)::text AS copilot
      FROM v_finance_chargeback_month
      WHERE period_month >= ${start}::date AND period_month < ${end}::date
        AND (${region}::uuid IS NULL OR region_id = ${region}::uuid)`)),
  ]
  const indicativeUsageUsd = Number(usage?.usage ?? 0)
  const chargebackUsd = Number(cb?.total ?? 0)
  const copilotChargebackUsd = Number(cb?.copilot ?? 0)
  return {
    indicativeUsageUsd,
    chargebackUsd,
    gapUsd: indicativeUsageUsd - chargebackUsd,
    copilotChargebackUsd,
  }
}

// ── Drill: resolve + authorise a single CoU (anti-IDOR) ───────────────────────
export interface FinanceCouRef {
  id: string
  code: string
  displayName: string
  regionId: string | null
  regionCode: string | null
}

/**
 * Resolve a CoU for the drill (build-design §2 — resource-anchored). Only
 * region-unbounded roles (global-finops / platform-admin) reach this endpoint, so
 * there is no cross-region 403 to enforce — anti-IDOR here means a non-existent /
 * non-cost-owning id is a 404 (never a 500, never a silent empty). The id is a real
 * cost-owning unit or nothing.
 */
export async function resolveFinanceCou(tx: Tx, couId: string): Promise<FinanceCouRef> {
  const rows = await tx.execute<{
    id: string
    code: string
    display_name: string
    region_id: string | null
    region_code: string | null
  }>(sql`
    SELECT ou.id::text AS id, ou.code, ou.display_name,
           ou.region_id::text AS region_id, r.code AS region_code
    FROM org_unit ou LEFT JOIN region r ON r.id = ou.region_id
    WHERE ou.id = ${couId}::uuid AND ou.is_cost_owning_unit = TRUE AND ou.retired_at IS NULL
    LIMIT 1`)
  const cou = [...rows][0]
  if (!cou) throw createError({ statusCode: 404, statusMessage: 'cost-owning unit not found' })
  return {
    id: cou.id,
    code: cou.code,
    displayName: cou.display_name,
    regionId: cou.region_id,
    regionCode: cou.region_code,
  }
}

// ── Drill: Anthropic per-teammate charges (teammate-homed finance axis) ────────
export interface AnthropicCharge {
  teammateId: string
  label: string
  chargeUsd: number
}

/**
 * The CoU's Anthropic per-teammate charges (the bill names the person), month-bounded,
 * from `v_finance_bill_chargeback` (copilot + exempt already excluded by the view).
 * These ARE the chargeable P&L figure (settling-provisional). Σ = anthropicChargeableUsd.
 */
export async function fetchAnthropicCharges(
  tx: Tx,
  couId: string,
  range: UsageWindow,
): Promise<{ charges: AnthropicCharge[]; totalUsd: number }> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const rows = await tx.execute<{ teammate_id: string; label: string | null; value: string }>(sql`
    SELECT b.teammate_id::text AS teammate_id, COALESCE(t.display_name, t.email) AS label,
           COALESCE(SUM(b.bill_usd), 0)::text AS value
    FROM v_finance_bill_chargeback b JOIN teammate t ON t.id = b.teammate_id
    WHERE b.cost_owning_unit_id = ${couId}::uuid AND b.tool <> 'copilot-cli'
      AND b.period_date >= ${start}::date AND b.period_date < ${end}::date
    GROUP BY b.teammate_id, t.display_name, t.email
    ORDER BY SUM(b.bill_usd) DESC NULLS LAST`)
  const charges = [...rows].map((r) => ({
    teammateId: r.teammate_id,
    label: r.label ?? 'Unknown',
    chargeUsd: Number(r.value),
  }))
  return { charges, totalUsd: charges.reduce((a, c) => a + c.chargeUsd, 0) }
}

// ── Drill: Copilot per-org pooled lines (org→CoU-map-homed) ────────────────────
export interface CopilotPooledLine {
  orgId: string | null
  label: string
  licenseUsd: number
  overageUsd: number
  netUsd: number
  /** license absent but usage present → the month reports unsettled (risk 7). */
  unsettled: boolean
}

export interface CopilotPoolUtilisation {
  /** Σ gross AI-credit consumption for the CoU's orgs (context weight, never a charge). */
  usageGrossUsd: number
  /** Σ `included` pool allowance for the CoU's orgs (the interim estimate). */
  poolUsd: number
  /** usageGross / pool as a FRACTION in [0,1], or null when no pool. */
  utilisation: number | null
}

/**
 * The CoU's Copilot pooled bill — org→CoU-map-homed (mig 0080). Returns BOTH the
 * per-org pooled lines (license net + overage net, the chargeback-mode surface) and
 * the pool-utilisation summary (usage-gross vs the `included` allowance, the
 * pool-utilisation-mode surface). The endpoint renders one or the other by
 * `copilot.mode` (build-design §6). Both read `copilot_pool_bill` ONLY — no
 * actual_spend copilot row is a chargeback operand (§7 lane firewall).
 */
export async function fetchCopilotPool(
  tx: Tx,
  couId: string,
  range: UsageWindow,
): Promise<{
  lines: CopilotPooledLine[]
  utilisation: CopilotPoolUtilisation
  licenseNetUsd: number
  overageNetUsd: number
  seats: number
  poolUsd: number
  /** true when ANY pooled line is unsettled (license absent but usage present) → the CoU-month
   * is unsettled: `licenseNetUsd` (and thus `chargeableUsd`) silently drops the unread license,
   * so the drill must caveat the Chargeable headline + swap the green chip for amber (M2). */
  unsettled: boolean
}> {
  // Range-aware (mirrors the finance index generalization `period_month = start` →
  // `>= start AND < end`): a quarter sums the whole `month`s it spans. GROUP BY org so
  // each org is ONE line summing its months (never a duplicate-key row across months);
  // `unsettled` is bool_or of the per-MONTH "license absent but usage present" predicate,
  // so an unsettled month is never masked by a settled one in the same range (risk 7).
  // Month mode (one month) is byte-identical: the SUMs reduce to the single row's values.
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const rows = await tx.execute<{
    org_id: string | null
    label: string | null
    license: string | null
    overage: string | null
    included: string | null
    usage_gross: string | null
    seats: number | null
    unsettled: boolean
  }>(sql`
    SELECT b.provider_org_id::text AS org_id,
           COALESCE(po.display_name, po.external_org_id) AS label,
           SUM(b.license_net_usd)::text AS license, SUM(b.overage_net_usd)::text AS overage,
           SUM(b.included_allowance_usd)::text AS included, SUM(b.usage_gross_usd)::text AS usage_gross,
           COALESCE(SUM(b.seats), 0)::int AS seats,
           bool_or(b.license_net_usd IS NULL AND COALESCE(b.usage_gross_usd, 0) > 0) AS unsettled
    FROM copilot_pool_bill b LEFT JOIN provider_org po ON po.id = b.provider_org_id
    WHERE b.cost_owning_unit_id = ${couId}::uuid
      AND b.month >= ${start}::date AND b.month < ${end}::date
    GROUP BY b.provider_org_id, po.display_name, po.external_org_id
    ORDER BY (COALESCE(SUM(b.license_net_usd), 0) + COALESCE(SUM(b.overage_net_usd), 0)) DESC NULLS LAST`)

  const lines: CopilotPooledLine[] = []
  let licenseNetUsd = 0
  let overageNetUsd = 0
  let seats = 0
  let poolUsd = 0
  let usageGrossUsd = 0
  let unsettled = false
  for (const r of rows) {
    const license = r.license == null ? 0 : Number(r.license)
    const overage = r.overage == null ? 0 : Number(r.overage)
    const included = r.included == null ? 0 : Number(r.included)
    const usageGross = r.usage_gross == null ? 0 : Number(r.usage_gross)
    const lineUnsettled = Boolean(r.unsettled)
    if (lineUnsettled) unsettled = true
    licenseNetUsd += license
    overageNetUsd += overage
    poolUsd += included
    usageGrossUsd += usageGross
    seats += Number(r.seats ?? 0)
    lines.push({
      orgId: r.org_id,
      label: r.label ?? (r.org_id ? 'Unknown org' : 'Enterprise residual (no org)'),
      licenseUsd: license,
      overageUsd: overage,
      netUsd: license + overage,
      unsettled: lineUnsettled,
    })
  }
  return {
    lines,
    utilisation: {
      usageGrossUsd,
      poolUsd,
      utilisation: poolUsd > 0 ? usageGrossUsd / poolUsd : null,
    },
    licenseNetUsd,
    overageNetUsd,
    seats,
    poolUsd,
    unsettled,
  }
}

// ── Drill: project overlay (chargeable split, Anthropic) ──────────────────────
/**
 * The CoU's tagged project split from `v_finance_project_overlay` (chargeable-only,
 * Anthropic; overlay excludes Copilot + exempt). The rows sum back to the CoU's
 * Anthropic chargeable (the untagged remainder is an explicit "Untagged" bucket).
 */
export async function fetchFinanceProjectOverlay(
  tx: Tx,
  couId: string,
  range: UsageWindow,
  headlineUsd: number,
): Promise<DriverRow[]> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const rows = await tx.execute<{ key: string | null; label: string | null; value: string }>(sql`
    SELECT o.project_id::text AS key, COALESCE(p.display_name, p.code) AS label,
           COALESCE(SUM(o.charge_usd), 0)::text AS value
    FROM v_finance_project_overlay o LEFT JOIN project p ON p.id = o.project_id
    WHERE o.cost_owning_unit_id = ${couId}::uuid
      AND o.period_date >= ${start}::date AND o.period_date < ${end}::date
    GROUP BY o.project_id, p.display_name, p.code
    ORDER BY SUM(o.charge_usd) DESC NULLS LAST`)
  return [...rows].map((r) => {
    const usd = Number(r.value)
    return {
      key: r.key ?? '__untagged',
      label: r.label ?? 'Untagged',
      usd,
      sharePct: headlineUsd > 0 ? usd / headlineUsd : 0,
      // The chargeable Anthropic project split is settling-provisional, not finalised
      // (build-design bans "finalised") — rendered `indicative`, matching the CC scope.
      spendClass: 'indicative' as SpendClass,
    }
  })
}

// ── Drill: Overage Drivers (D-Q6 layer 3 — INFORMATIONAL, never a charge) ──────
export interface OverageDrivers {
  /** The paid pooled overage the informational shares sum back to. */
  overageNetUsd: number
  /** pool / seats — the per-seat allowance a teammate's usage is measured against. */
  perSeatShareUsd: number
  /** Proportional INDICATIVE shares (excess_i / Σexcess × overage_net); Σ = overage_net. */
  rows: DriverRow[]
}

/**
 * The Overage Drivers panel (D-Q6 layer 3), computed ONLY when the CoU has PAID
 * overage (overage_net > 0) in chargeback mode. For each teammate homed to the CoU
 * (current org) with Copilot usage in the month, EXCESS above their per-seat share
 * is `max(0, usage_i − pool/seats)`; each teammate's PROPORTIONAL indicative share is
 * `excess_i / Σexcess × overage_net`. When no one exceeds their share (Σexcess = 0)
 * the paid overage is still real, so the shares distribute by raw usage instead — the
 * shares ALWAYS sum back to the paid overage. This is INFORMATIONAL (spendClass
 * `indicative`, "informational — not a charge"), a §A display weight — it is NEVER
 * written as a charge (in-product per-user charging is canon-rejected; the CSV lets
 * finance distribute manually if they choose).
 */
export async function fetchOverageDrivers(
  tx: Tx,
  couId: string,
  range: UsageWindow,
  opts: { overageNetUsd: number; poolUsd: number; seats: number },
): Promise<OverageDrivers> {
  const start = monthStartDate(range)
  const end = nextMonthDate(range)
  const perSeatShareUsd = opts.seats > 0 ? opts.poolUsd / opts.seats : 0

  // Per-teammate Copilot USAGE (the §A display weight) homed to the CoU (current org).
  const rows = await tx.execute<{ key: string; label: string | null; usage: string }>(sql`
    SELECT ud.teammate_id::text AS key, COALESCE(t.display_name, t.email) AS label,
           COALESCE(SUM(ud.usage_usd), 0)::text AS usage
    FROM v_teammate_usage_daily ud JOIN teammate t ON t.id = ud.teammate_id
    JOIN LATERAL (
      SELECT anc.id AS cost_owning_unit_id
      FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
      WHERE home.id = t.org_unit_id AND anc.is_cost_owning_unit = TRUE AND anc.retired_at IS NULL
      ORDER BY nlevel(anc.path) DESC LIMIT 1
    ) cc ON TRUE
    WHERE ud.tool = 'copilot-cli' AND cc.cost_owning_unit_id = ${couId}::uuid
      AND ud.day >= ${start}::date AND ud.day < ${end}::date
    GROUP BY ud.teammate_id, t.display_name, t.email
    ORDER BY SUM(ud.usage_usd) DESC NULLS LAST`)

  const used = [...rows].map((r) => ({
    key: r.key,
    label: r.label ?? 'Unknown',
    usage: Number(r.usage),
    excess: Math.max(0, Number(r.usage) - perSeatShareUsd),
  }))

  const totalExcess = used.reduce((a, u) => a + u.excess, 0)
  // Prefer the excess weight; when nobody is over their share, distribute the (still
  // real) paid overage by raw usage so the shares always sum to the paid overage.
  const byExcess = totalExcess > 0
  const totalWeight = byExcess ? totalExcess : used.reduce((a, u) => a + u.usage, 0)

  const driverRows: DriverRow[] = used
    .map((u) => {
      const weight = byExcess ? u.excess : u.usage
      const shareUsd = totalWeight > 0 ? (weight / totalWeight) * opts.overageNetUsd : 0
      return {
        key: u.key,
        label: u.label,
        usd: shareUsd,
        sharePct: opts.overageNetUsd > 0 ? shareUsd / opts.overageNetUsd : 0,
        // INFORMATIONAL — a proportional indicative share, never a charge (D-Q6).
        spendClass: 'indicative' as SpendClass,
        dims: { usageUsd: u.usage.toFixed(6), excessUsd: u.excess.toFixed(6) },
      }
    })
    .filter((r) => r.usd > 0)

  // Empty-distribution edge: PAID overage but nothing to weight it over (no teammate homed to
  // the CoU had Copilot usage in the month, or all usage was zero → totalWeight = 0). Without a
  // row the informational shares sum to 0 ≠ overage and the panel's sum-back goes RED on an
  // informational surface. Emit ONE explicit unallocated-overage row so it still foots (L2).
  if (opts.overageNetUsd > 0 && totalWeight === 0) {
    driverRows.push({
      key: '__unallocated',
      label: 'Unallocated overage — no attributable usage',
      usd: opts.overageNetUsd,
      sharePct: 1,
      // INFORMATIONAL — indicative, never a charge (D-Q6); the paid overage is real but no §A
      // usage weight exists to distribute it, so it lands whole in an explicit unallocated row.
      spendClass: 'indicative' as SpendClass,
      dims: { usageUsd: '0.000000', excessUsd: '0.000000' },
    })
  }

  return { overageNetUsd: opts.overageNetUsd, perSeatShareUsd, rows: driverRows }
}

// ── CSV: the finance LEDGER (cost-centre × provider × month) ───────────────────
/** `spend_usd` two-decimal, matching the on-screen `fmtUsd` precision. */
function usd(n: number): string {
  return n.toFixed(2)
}

/**
 * The finance ledger CSV — grain cost-centre × provider × month (owner D-Q8). One
 * row per (CoU, provider): the Anthropic charge and the Copilot pooled net, each with
 * a `chargeback_pending` flag (Copilot is pending in pool-utilisation mode — finance
 * knows not to x-charge it yet) + the provider's settling state. asOf-stamped
 * (owner gate fold-in). Byte-identical to the per-CoU screen figures.
 */
export function financeLedgerToCsv(
  cous: FinanceCouRow[],
  meta: {
    month: string
    asOfDate: string | null
    anthropicState: string
    githubState: string
    check: FinanceBillCheck
  },
): string {
  const lines: string[] = [
    `# tokenscope finance ledger · month=${meta.month} · as_of=${meta.asOfDate ?? 'n/a'} · reconciliation=${meta.check.matched ? 'matched' : 'UNSETTLED'} · chargeback=${usd(meta.check.chargebackUsd)} · bill=${usd(meta.check.billUsd)}`,
    'cost_centre,region,provider,month,charge_usd,chargeback_pending,settling_state',
  ]
  for (const c of cous) {
    const region = c.regionCode ?? ''
    if (c.anthropicUsd !== 0) {
      lines.push(
        [csvEscape(c.displayName), csvEscape(region), 'anthropic', meta.month, usd(c.anthropicUsd), 'false', meta.anthropicState].join(','),
      )
    }
    if (c.copilotUsd !== 0) {
      lines.push(
        [csvEscape(c.displayName), csvEscape(region), 'github', meta.month, usd(c.copilotUsd), String(c.copilotPending), meta.githubState].join(','),
      )
    }
  }
  return lines.join('\n') + '\n'
}
