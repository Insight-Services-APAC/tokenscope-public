/*
 * §B chargeback day-series, scope-parameterised — ONE implementation for the
 * regional and whole-company surfaces that previously carried a copy each.
 *
 * The pair these replace were 93% and 86% line-identical once the scope
 * predicate was normalised away, and they had already drifted: the regional
 * lane-trend keyed its (day, lane) map on a SPACE while the whole-company one
 * used a NUL escape. No lane id contains whitespace today, so that was latent
 * rather than live — but it is exactly the divergence a second copy invites,
 * and the reason a fix landing on one surface and not the other is invisible.
 *
 * Both read v_finance_bill_chargeback — the §B BILL lane. Never sum these with
 * a §A usage figure (provider-billing-attribution-model.md).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { VENDOR_LANES, chargeToVendor, type Vendor } from '../../../shared/usage/vendor'
import type { ChargeDailyPoint, ChargeLanePoint, ChargebackLaneRow } from '../../../shared/reports/types'
import type { ServerClock } from '../../../shared/reports/clock'
import { isMonthAlignedWindow, type UsageWindow } from '../params'
import { scopeSql, type FinanceScope } from './scope'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** Canonical lane order index, for deterministic per-day lane ordering. */
const LANE_ORDER = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))

/*
 * Composite map-key separator for (day, lane) pairs.
 *
 * The ESCAPE, never a literal NUL byte: a raw byte makes the file `data` rather
 * than text, so ripgrep skips it and every grep-based sweep silently
 * under-reports (scripts/check-source-files-are-text.mjs enforces this).
 *
 * NUL is the right CHARACTER because neither an ISO date nor a lane id can
 * contain it, so the join needs no escaping. A SPACE — which the regional copy
 * used — is only safe while no lane id ever contains one.
 */
const DAY_LANE_SEP = '\u0000'

/**
 * Daily §B charge total over the window, ZERO-FILLED across every day that has
 * ALREADY HAPPENED — and no further.
 *
 * Zero-filled because this series is the axis of record: a PAST day with no
 * bill is a real zero, not a gap. Bounded because a day that has not occurred
 * carries no measurement at all: padding an in-progress month out to its
 * calendar end drew the line collapsing to zero and flatlining to the right
 * edge, which asserts a bill of $0 for days nobody has lived through.
 *
 * The generated axis' upper bound is
 *
 *   LEAST( endDate - 1 day,                     -- never past the window
 *          GREATEST( clock.settledThrough,       -- never past the settled edge …
 *                    MAX(period_date in scope) ) )  -- … unless a bill exists there
 *
 * `window.endIso` is EXCLUSIVE, so the first arm stops the axis one day before
 * it exactly as before. The `GREATEST` arm is NOT cosmetic: a bill dated beyond
 * the edge still counts in the window's chargeable headline, so dropping it from
 * the series would silently break Σ(series) === headline (test-pinned). A
 * window whose start is after the bound yields NO rows — correct: nothing in it
 * has happened yet.
 *
 * ── THE EDGE IS `settledThrough`, NOT `CURRENT_DATE` (fix-sprint F1/D2) ──────
 * The §A twin carries the full reasoning (`usage-series.ts`). In short: SQL's
 * `CURRENT_DATE` is a THIRD clock and a WALL-CLOCK fact where the axis needs a
 * COVERAGE fact, and the gap between them is the morning dip. `clock` is
 * REQUIRED and this query holds no clock of its own — so the §A and §B trends,
 * which readers put side by side, are guaranteed the same right edge rather
 * than two independent answers that agree by luck.
 */
export async function fetchChargebackTrend(
  tx: Tx,
  scope: FinanceScope,
  window: UsageWindow,
  clock: ServerClock,
): Promise<ChargeDailyPoint[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const settledThrough = clock.settledThrough
  const rows = await tx.execute<{ day: string; charge: string }>(sql`
    WITH agg AS (
      SELECT period_date AS day, SUM(bill_usd) AS charge
      FROM v_finance_bill_chargeback
      WHERE ${scopeSql(scope)}
        AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
      GROUP BY period_date
    ),
    /*
     * The axis upper bound (see the doc comment). Declared AFTER agg because a
     * non-recursive WITH item may only reference siblings defined before it --
     * and it reads agg, not the raw view, so the frontier is computed over
     * EXACTLY the rows the series sums. GREATEST/LEAST ignore NULLs, so an empty
     * agg degrades to LEAST(endDate - 1, settledThrough) rather than NULL.
     *
     * settledThrough is a BOUND TEXT PARAMETER cast by date_in, which never
     * consults the session TimeZone -- clock-free in both senses.
     *
     * NO BACKTICKS ANYWHERE IN THIS QUERY: a backtick inside a SQL comment ends
     * the surrounding JS template literal, and the parse error it raises points
     * at the wrong line.
     */
    frontier AS (
      SELECT LEAST(
               ${endDate}::date - 1,
               GREATEST(${settledThrough}::date, (SELECT MAX(day) FROM agg))
             ) AS last_day
    ),
    days AS (
      SELECT g.day_ts::date AS day
      FROM frontier f,
           generate_series(
             ${startDate}::timestamp,
             f.last_day::timestamp,
             INTERVAL '1 day'
           ) AS g(day_ts)
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(a.charge, 0)::text AS charge
    FROM days d LEFT JOIN agg a ON a.day = d.day
    ORDER BY d.day`)
  return [...rows].map((r) => ({ day: r.day, chargeUsd: Number(r.charge) }))
}

/**
 * The per-LANE widening of {@link fetchChargebackTrend}: the SAME view, window
 * and clamp, GROUP BY tool, each tool mapped to its registry lane id via
 * `chargeToVendor` (the mapping is N:1 by contract, so lanes are merged here).
 *
 * NOT zero-filled — the total series above stays the axis of record; this
 * carries only (day, lane) cells with rows, and Σ lanes per day equals that
 * day's chargeUsd cent-exactly (test-pinned). Copilot lanes are structurally
 * ABSENT (mig 0085: §B Copilot is pooled and MONTH-grained, never daily).
 */
export async function fetchChargebackLaneTrend(
  tx: Tx,
  scope: FinanceScope,
  window: UsageWindow,
): Promise<ChargeLanePoint[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const rows = await tx.execute<{ day: string; tool: string | null; charge: string }>(sql`
    SELECT to_char(period_date, 'YYYY-MM-DD') AS day, tool, SUM(bill_usd)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE ${scopeSql(scope)}
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY period_date, tool
    ORDER BY 1`)
  const byDayLane = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.day}${DAY_LANE_SEP}${chargeToVendor(r.tool)}`
    byDayLane.set(k, (byDayLane.get(k) ?? 0) + Number(r.charge))
  }
  return [...byDayLane.entries()]
    .map(([k, chargeUsd]) => {
      const [day, lane] = k.split(DAY_LANE_SEP) as [string, string]
      return { day, lane, chargeUsd }
    })
    .sort(
      (a, b) =>
        (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
        (LANE_ORDER.get(a.lane) ?? 99) - (LANE_ORDER.get(b.lane) ?? 99),
    )
}

/**
 * §B chargeback totals per LANE over the window — the same clamp, both bill
 * sources, merged and emitted in canonical lane order.
 *
 * The two sources have DIFFERENT GRAINS, which is why the Copilot arm is
 * conditional rather than a second UNION branch: Anthropic bills daily
 * (`v_finance_bill_chargeback`, period_date), while Copilot bills POOLED per
 * cost-centre per MONTH (`v_finance_copilot_pool_chargeback`, period_month,
 * mig 0085). Folding a month-grained figure into a non-month-aligned window
 * would attribute a whole month's pool to a partial period, so it is included
 * only over a month-aligned window AND once chargeback mode is validated —
 * the KPI's exact gate, so this can never disagree with the headline above it.
 */
export async function fetchChargebackLanes(
  tx: Tx,
  scope: FinanceScope,
  window: UsageWindow,
  opts: { copilotChargeback: boolean },
): Promise<ChargebackLaneRow[]> {
  const startDate = window.startIso.slice(0, 10)
  const endDate = window.endIso.slice(0, 10)
  const byLane = new Map<Vendor, number>()

  const anthropicRows = await tx.execute<{ tool: string | null; charge: string }>(sql`
    SELECT tool, SUM(bill_usd)::text AS charge
    FROM v_finance_bill_chargeback
    WHERE ${scopeSql(scope)}
      AND period_date >= ${startDate}::date AND period_date < ${endDate}::date
    GROUP BY tool`)
  for (const r of anthropicRows) {
    const lane = chargeToVendor(r.tool)
    byLane.set(lane, (byLane.get(lane) ?? 0) + Number(r.charge))
  }

  if (opts.copilotChargeback && isMonthAlignedWindow(window)) {
    const poolRows = await tx.execute<{ tool: string | null; charge: string }>(sql`
      SELECT tool, SUM(charge_usd)::text AS charge
      FROM v_finance_copilot_pool_chargeback
      WHERE ${scopeSql(scope)}
        AND period_month >= ${startDate}::date AND period_month < ${endDate}::date
      GROUP BY tool`)
    for (const r of poolRows) {
      const lane = chargeToVendor(r.tool)
      byLane.set(lane, (byLane.get(lane) ?? 0) + Number(r.charge))
    }
  }

  return [...byLane.entries()]
    .sort(([a], [b]) => (LANE_ORDER.get(a) ?? 99) - (LANE_ORDER.get(b) ?? 99))
    .map(([lane, chargeUsd]) => ({ lane, chargeUsd }))
}
