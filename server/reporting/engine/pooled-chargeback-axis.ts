/*
 * The POOLED Copilot chargeback arm — the second source of the chargeback lane,
 * and the one `provider_usage_fact` structurally cannot hold.
 *
 * ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────
 *
 * `provider_usage_fact` is not the chargeback lane for GitHub. Migration 0120
 * says so on the table itself: a `github` row carries gross AI-credit
 * CONSUMPTION valued at the credit rate, BEFORE the pooled allowance. Copilot's
 * authoritative chargeback is `v_finance_copilot_pool_chargeback` (mig 0107) —
 * licence net plus net overage, POOLED per (cost-owning unit, lane, month) and
 * homed to the CoU through the org→CoU map, never through Entra placement.
 *
 * `engine/billed-axis.ts` correctly refuses to fold the consumption arm into a
 * billed headline. The consequence was that the chargeback lane's headline was
 * Anthropic's charge alone, under a label naming the whole company. This module
 * supplies the missing term at the axes that can carry it, so the cost-centre
 * chargeback figure is BOTH providers rather than one of them silently.
 *
 * ── WHICH AXES IT ANSWERS, AND WHY EXACTLY THOSE ─────────────────────────────
 *
 * The pooled view's grain is `(cost_owning_unit_id, region_id, tool,
 * period_month)`, and EVERY non-time column in it is an axis this module can
 * rank on. All three are read straight off the view; none is re-derived, joined
 * back to the usage lane, or apportioned:
 *
 *   practice — `cost_owning_unit_id`, the unit the charge is RAISED against.
 *   region   — `ou.region_id` of that unit, emitted by the view: which region is
 *              charged, which is the question a region ranking of chargeback asks.
 *   surface  — `tool`, which on THIS view is not an emit tool at all but the
 *              bill's own CHARGEBACK LANE (mig 0107 emits `copilot-license` /
 *              `copilot-usage` / `copilot-unclassified` there). Those literals
 *              ARE registry lane ids, and `shared/usage/vendor.ts`'s
 *              `chargeToVendor()` exists for precisely this column — a lane id
 *              passes through, and `toolToVendor` (the emit-tool mapper) would
 *              drop every one of them into 'other'.
 *
 * A previous revision of this file claimed the view had "no surface column" and
 * gapped the axis. That conflated two different questions: the pooled invoice
 * genuinely cannot be APPORTIONED by usage surface (nobody can say which
 * keystroke drew which licence dollar), but it can absolutely be GROUPED BY the
 * lane the bill itself raises the money under — which is what a surface ranking
 * of a CHARGEBACK figure asks. The first is an apportionment; the second is a
 * `GROUP BY` over one column that is already there.
 *
 * ── WHAT IT STILL REFUSES, AND WHY THAT IS THE BILL AND NOT THIS FILE ────────
 *
 * TEAMMATE and MODEL. Neither column exists in the view, and mig 0107's own
 * comment forbids a per-user one ever entering it. Splitting one pooled invoice
 * line across teammates by a usage share is the apportionment
 * target-state-data-architecture.md §5 deleted, and it would render as a hard
 * per-person charge nobody is owed. So those two axes get a stated GAP
 * (`ChargebackGap`), not an invented number.
 *
 * ── NO RATIO, ONE RELATION ───────────────────────────────────────────────────
 *
 * Every figure is a `GROUP BY` over the pooled view alone. Nothing divides money
 * by a share and nothing joins the usage lane. `billed-axis.ts` is held to the
 * same rule against `provider_usage_fact` and is STATICALLY forbidden from
 * naming a `v_finance_*` relation (`tests/unit/server/reports-billed-lane-
 * contract.test.ts`) — which is why this is a separate module composed by
 * `engine/drivers.ts` rather than a branch inside that one.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { GITHUB_CHARGEABLE_LANES } from '../../../shared/usage/github-surface'
import { chargeToVendor, VENDOR_LABELS, VENDOR_LANES, type Vendor } from '../../../shared/usage/vendor'
import { spendClassForMeasure } from '../../../shared/reports/provider-measure'
import type {
  BilledAxisArm,
  BilledLaneAvailability,
  DriverRow,
} from '../../../shared/reports/types'
import type { UsageWindow } from '../params'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * The axes the POOLED Copilot chargeback can be ranked on — exactly the three
 * non-time dimensions `v_finance_copilot_pool_chargeback` carries, one per
 * column of its grain. See this module's header for what each one reads and why
 * `teammate` / `model` / `project` are absent from the list.
 */
export const POOLED_CHARGEBACK_AXES = ['practice', 'region', 'surface'] as const
export type PooledChargebackAxis = (typeof POOLED_CHARGEBACK_AXES)[number]

export function isPooledChargebackAxis(axis: string): axis is PooledChargebackAxis {
  return (POOLED_CHARGEBACK_AXES as readonly string[]).includes(axis)
}

/** How each answerable axis is NAMED to a reader — see {@link pooledChargebackAxisList}. */
const POOLED_CHARGEBACK_AXIS_LABELS: Readonly<Record<PooledChargebackAxis, string>> = {
  practice: 'Practice',
  region: 'Region',
  surface: 'Surface',
}

/**
 * "Practice or Surface" — the axes a reader can switch to in order to SEE the
 * Copilot charge, for the gap sentence on the axes that cannot carry it.
 *
 * DERIVED from {@link POOLED_CHARGEBACK_AXES} rather than written out, because
 * the last revision of this module was shipped with a sentence that had outlived
 * the set it named. A hand-typed list is a claim with no checker; this one cannot
 * name an axis the module does not answer, or omit one it does.
 *
 * ── AND IT IS INTERSECTED WITH WHAT THE READER CAN ACTUALLY PICK ─────────────
 * Answering an axis and OFFERING it are different facts, and this sentence is
 * about the second. `region` is the case that split them: this module still
 * ranks it (the view's grain carries the column), but neither scope's request
 * gate offers it any more — Region has its own card (prototype fix 4a). Naming
 * it here would send a reader looking for a chip that is not on the page.
 *
 * @param offered the axes the CALLING SCOPE's gate admits (`ACROSS_DRIVER_AXES`
 *   / `REGIONAL_DRIVER_AXES`). Defaults to every answerable axis, which is the
 *   pre-existing behaviour for a caller that has not been taught its own gate.
 */
export function pooledChargebackAxisList(
  offered: readonly string[] = POOLED_CHARGEBACK_AXES,
): string {
  const names = POOLED_CHARGEBACK_AXES.filter((a) => offered.includes(a)).map(
    (a) => POOLED_CHARGEBACK_AXIS_LABELS[a],
  )
  if (names.length === 0) return ''
  return names.length > 1
    ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
    : (names[0] as string)
}

/** The provider this arm's money belongs to — the `github` bill, pooled. */
export const POOLED_CHARGEBACK_PROVIDER = 'github'

/**
 * The arm id and source, spelled once. Consumers key render loops and export
 * rows on `id`, and `provider` alone would collide with the GitHub CONSUMPTION
 * arm that the same axis also carries.
 */
export const POOLED_CHARGEBACK_ARM_ID = `${POOLED_CHARGEBACK_PROVIDER}:pooled-chargeback`

/** `GITHUB_CHARGEABLE_LANES` as a SQL list — never hand-typed lane literals. */
function chargeableLanes(): SQL {
  return sql.join(
    GITHUB_CHARGEABLE_LANES.map((lane) => sql`${lane}`),
    sql`, `,
  )
}

/** How the axis is keyed, named and grouped over the pooled view (alias `u`). */
function axisSelect(axis: PooledChargebackAxis): {
  key: SQL
  label: SQL
  join: SQL
  groupBy: SQL
  nullKey: string
  nullLabel: string
} {
  /*
   * The keys and NULL-bucket vocabulary are IDENTICAL to `billed-axis.ts`'s for
   * the same axis, and that is load-bearing rather than tidy: the two arms are
   * folded onto one ranked list by key, so a divergent key would render the same
   * cost centre as two rows — one Anthropic, one Copilot — under one heading.
   */
  switch (axis) {
    case 'practice':
      return {
        key: sql`u.cost_owning_unit_id::text`,
        label: sql`cou.display_name`,
        join: sql`LEFT JOIN org_unit cou ON cou.id = u.cost_owning_unit_id`,
        groupBy: sql`u.cost_owning_unit_id, cou.display_name`,
        nullKey: '__null_practice',
        nullLabel: 'No cost centre resolved',
      }
    case 'region':
      return {
        key: sql`u.region_id::text`,
        label: sql`r.display_name`,
        join: sql`LEFT JOIN region r ON r.id = u.region_id`,
        groupBy: sql`u.region_id, r.display_name`,
        nullKey: '__null_region',
        nullLabel: 'Unassigned',
      }
    case 'surface':
      /*
       * The view's `tool` is the BILL'S OWN LANE id, not an emit tool — so it is
       * selected raw here and folded to a registry lane in TypeScript below,
       * exactly as `billed-axis.ts` folds its emit tools. The registry is the
       * mapper (`chargeToVendor`); a SQL CASE over lane names would be a second
       * copy of it that drifts the first time a lane is added.
       *
       * `nullKey`/`nullLabel` are the catch-all lane, which is also what
       * `billed-axis.ts` names its surface NULL bucket — the two arms fold onto
       * one ranked list by key, so a divergent bucket would split one lane into
       * two rows under one heading.
       */
      return {
        key: sql`u.tool`,
        label: sql`u.tool`,
        join: sql``,
        groupBy: sql`u.tool`,
        nullKey: 'other',
        nullLabel: VENDOR_LABELS.other,
      }
  }
}

/**
 * The pooled Copilot chargeback for one axis, scope and window, as ONE arm.
 *
 * `clamp` is a boolean SQL fragment over the alias `u` addressing the FINANCE
 * homing columns (`u.region_id` / `u.cost_owning_unit_id`) — `scopeSql` of a
 * `FinanceScope`, which is a different pair of columns from the usage clamp the
 * attributed axes use. Handing this the usage clamp would be a compile error at
 * the caller (`engine/scope.ts`'s phantom lane parameter) and, if forced, a
 * silently wrong population.
 *
 * The window is applied to `period_month`, which is a MONTH START: callers must
 * only reach here on a month-aligned window (`isMonthAlignedWindow`), or a
 * partial range would either charge a whole month's pool against a fraction of
 * it or silently drop it. `engine/drivers.ts` holds that gate and states the
 * partial-month case as a `ChargebackGap` instead.
 */
export async function fetchPooledChargebackArm(
  tx: Tx,
  clamp: SQL,
  range: UsageWindow,
  axis: PooledChargebackAxis,
): Promise<BilledAxisArm> {
  const startDate = range.startIso.slice(0, 10)
  const endDate = range.endIso.slice(0, 10)
  const { key, label, join, groupBy, nullKey, nullLabel } = axisSelect(axis)
  const lanes = chargeableLanes()

  /*
   * `copilot-unclassified` is EXCLUDED by `GITHUB_CHARGEABLE_LANES` and that is
   * a decision, not an oversight (design D2, r1-F10): an unclassified bill line
   * is money we cannot yet attribute to a SKU class, so it is surfaced on the
   * Finance surfaces and NEVER charged. Folding it in here would put it in a
   * cost centre's chargeback figure through a back door.
   */
  const grain = await tx.execute<{ key: string | null; label: string | null; value: string }>(sql`
    SELECT ${key}                                AS key,
           ${label}                              AS label,
           COALESCE(SUM(u.charge_usd), 0)::text  AS value
    FROM v_finance_copilot_pool_chargeback u
    ${join}
    WHERE ${clamp}
      AND u.tool IN (${lanes})
      AND u.period_month >= ${startDate}::date
      AND u.period_month <  ${endDate}::date
    GROUP BY ${groupBy}`)

  /*
   * HAS THE BILL READER WRITTEN ANYTHING IN THIS WINDOW AT ALL? Deliberately
   * UNCLAMPED, for the same reason `billed-axis.ts` asks the same question of
   * its own relation: "no rows in this scope" is a measured zero, while "no rows
   * anywhere in this window" means the `copilot-pool-bill` worker has not
   * reached it — and an operator chasing the first when it is really the second
   * is chasing a spend anomaly that is a missing worker run. Yields a BOOLEAN,
   * never another scope's money.
   */
  const derived = await tx.execute<{ present: boolean }>(sql`
    SELECT TRUE AS present
    FROM v_finance_copilot_pool_chargeback
    WHERE tool IN (${lanes})
      AND period_month >= ${startDate}::date
      AND period_month <  ${endDate}::date
    LIMIT 1`)

  const byKey = new Map<string, { label: string; usd: number }>()
  for (const r of grain) {
    /*
     * SURFACE folds the bill's lane id to a registry lane through
     * `chargeToVendor` — the mapper written for chargeback-view `tool` columns.
     * `toolToVendor` would be the wrong one and silently wrong: it knows only
     * EMIT tools, so every §B Copilot lane would land in 'other'.
     */
    const k = axis === 'surface' ? chargeToVendor(r.key) : (r.key ?? nullKey)
    const displayLabel =
      axis === 'surface' ? VENDOR_LABELS[k as Vendor] : (r.label ?? nullLabel)
    const acc = byKey.get(k) ?? { label: displayLabel, usd: 0 }
    acc.usd += Number(r.value)
    byKey.set(k, acc)
  }
  // A $0 grain is dropped for the same reason `billed-axis.ts` drops one: it
  // contributes zero to both sides of the sum-back, and a $0.00 row in a money
  // ranking is noise rather than information.
  const entries = [...byKey.entries()].filter(([, v]) => v.usd !== 0)
  const totalUsd = entries.reduce((a, [, v]) => a + v.usd, 0)
  const rows: DriverRow[] = entries
    .sort(
      axis === 'surface'
        ? // A fixed composition, in REGISTRY order — the same ordering
          // `billed-axis.ts` gives its surface arm and its folded surface list,
          // so this arm and the ranking it folds into cannot disagree.
          ([a], [b]) => VENDOR_LANES.indexOf(a as Vendor) - VENDOR_LANES.indexOf(b as Vendor)
        : (a, b) => b[1].usd - a[1].usd,
    )
    .map(([k, v]) => ({
      key: k,
      label: v.label,
      usd: v.usd,
      sharePct: totalUsd > 0 ? v.usd / totalUsd : 0,
      // A charge, so it renders as a hard dollar. The mapping is the shared one,
      // so this arm and the CSV serialiser cannot disagree about it.
      spendClass: spendClassForMeasure('pooled-chargeback'),
    }))

  const availability: BilledLaneAvailability =
    rows.length > 0 ? 'present' : [...derived].length > 0 ? 'none-in-scope' : 'no-data-yet'

  return {
    id: POOLED_CHARGEBACK_ARM_ID,
    provider: POOLED_CHARGEBACK_PROVIDER,
    measure: 'pooled-chargeback',
    source: 'v_finance_copilot_pool_chargeback',
    availability,
    totalUsd,
    rows,
  }
}
