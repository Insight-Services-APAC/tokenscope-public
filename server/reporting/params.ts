/*
 * reporting/params — the zod shared params + month resolution every reporting
 * endpoint (Wave 2+) agrees on (docs/design/reporting-consolidation/
 * 00-build-design.md §2 "Common").
 *
 * LOCATION NOTE: the build design names this `server/api/v1/reports/_shared/
 * params.ts`, but Nitro file-based routing scans EVERY `.ts` under `server/api`
 * and registers it as a route (verified: `_shared/params.ts` → a
 * `/api/v1/reports/_shared/params` route whose generated type references a
 * non-existent `default` export → a typecheck error). So the non-route shared
 * modules live in `server/reporting/` (a plain, non-scanned server dir, imported
 * explicitly by the handlers) instead. The endpoints themselves stay under
 * `server/api/v1/reports/**` exactly as specified.
 *
 * Every handler runs the query INSIDE `withRequestRls`, with the scope always
 * expressed in-query (RLS is inert at runtime — see server/db/request-rls.ts).
 */
import { z } from 'zod'
import { createError } from 'h3'
import {
  MONTH_REGEX,
  monthKeyUtc,
  monthRangeUtc,
  daysInMonthUtc,
  type MonthRangeUtc,
} from '../utils/period'
import type {
  SeasonalityCell,
  ChargeDowBucket,
  UsageSurfaceWeeklyCell,
  BilledLaneMeta,
  ChargebackCoverage,
  DriverSurfaceAmount,
  DriverProvenanceAmount,
} from '../../shared/reports/types'
import { csvEscape } from '../utils/csv-escape'
import { toolToVendor, VENDOR_LANES, VENDOR_LABELS, type Vendor } from '../../shared/usage/vendor'
import { GITHUB_USAGE_LANE_IDS } from '../../shared/usage/github-surface'
import { USAGE_PROVENANCE_VALUES } from '../../shared/usage/provenance'

/**
 * `format=json|csv`. The screen endpoints always serve JSON; the CSV serialiser
 * lives behind `/reports/export`, which calls the SAME query fns (byte-identical
 * rule, build-design §2). Present here so a screen endpoint could echo it.
 */
export const REPORT_FORMATS = ['json', 'csv'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]

/**
 * `YYYY-MM-DD` SHAPE guard for the `from`/`to` date-range params. This only pins
 * the shape at the zod layer; real-date validity (month 01-12, day in range, no
 * `2026-02-30`) and `from <= to` are enforced in {@link resolveReportRange}.
 */
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

/** Max span of a custom `from`/`to` range (inclusive days). ~13 months of slack. */
export const MAX_RANGE_DAYS = 400

/**
 * The shared params zod object — `month` (YYYY-MM, 01-12), the `from`/`to`
 * date-range pair (YYYY-MM-DD, inclusive `to`), + `format`. Month and range are
 * ALTERNATIVES: when `from`/`to` are present they win; otherwise `month` (or the
 * current UTC month) drives the window — see {@link resolveReportWindow}.
 */
export const reportBaseParams = z.object({
  // Stricter than the build-design's `^\d{4}-\d{2}$`: MONTH_REGEX also pins the
  // month to 01-12, so `2026-13` is a 400 at the zod layer rather than a 500 out
  // of monthRangeUtc's belt-and-braces throw.
  month: z.string().regex(MONTH_REGEX).optional(),
  from: z.string().regex(DATE_REGEX).optional(),
  to: z.string().regex(DATE_REGEX).optional(),
  format: z.enum(REPORT_FORMATS).default('json'),
})

export interface ResolvedMonth {
  /** The effective month key (`YYYY-MM`) — the requested one, or the current UTC month. */
  month: string
  /** The half-open UTC range `[monthStartUtc, nextMonthStartUtc)`. */
  range: MonthRangeUtc
}

/**
 * Resolve the requested `month` param to an effective month + its UTC range.
 * Defaults to the current UTC month when absent. Optionally enforces a floor
 * (`>= monthFloor`) — a below-floor month is a 400 (the picker disables those
 * client-side; this is the server guard). The floor is data-derived, so callers
 * that have not yet computed it pass it later / omit it.
 */
export function resolveReportMonth(
  monthParam: string | undefined,
  opts: { now?: Date; monthFloor?: string } = {},
): ResolvedMonth {
  const now = opts.now ?? new Date()
  const month = monthParam ?? monthKeyUtc(now)
  if (opts.monthFloor && month < opts.monthFloor) {
    throw createError({
      statusCode: 400,
      statusMessage: 'month before floor',
      data: {
        type: 'https://tokenscope.example.com/errors/month-floor',
        title: 'Month before scope floor',
        status: 400,
        detail: `Requested month ${month} is before the earliest month with data (${opts.monthFloor}).`,
      },
    })
  }
  return { month, range: monthRangeUtc(month) }
}

// ── Custom date range (?from / ?to) ──────────────────────────────────────────

export interface ResolvedRange {
  /** The requested inclusive lower bound (`YYYY-MM-DD`), echoed back. */
  from: string
  /** The requested inclusive upper bound (`YYYY-MM-DD`), echoed back. */
  to: string
  /** Inclusive lower bound as an ISO instant — `${from}T00:00:00.000Z`. */
  startIso: string
  /** EXCLUSIVE upper bound as an ISO instant — first instant of the day AFTER `to`. */
  endIso: string
}

/** Parse a `YYYY-MM-DD` string, rejecting non-real dates (e.g. `2026-02-30`). */
function parseUtcDate(s: string): { y: number; m: number; d: number } | null {
  if (!DATE_REGEX.test(s)) return null
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  // Round-trip guard: JS Date silently rolls `2026-02-30` into March, so a real
  // date must reproduce its own y/m/d after construction.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return { y, m, d }
}

function badRange(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'invalid date range',
    data: {
      type: 'https://tokenscope.example.com/errors/date-range',
      title: 'Invalid date range',
      status: 400,
      detail,
    },
  })
}

/**
 * Resolve the `?from` / `?to` pair (`YYYY-MM-DD`, inclusive `to`) into a HALF-OPEN
 * UTC range `[from 00:00Z, (to + 1 day) 00:00Z)` — matching the month path's
 * half-open convention so a row lands in exactly one window.
 *
 * Returns `null` when NEITHER `from` nor `to` is present (the caller falls back to
 * the month path). A PARTIAL range (exactly one of the two), a non-real date, or
 * `from > to` is a 400.
 */
export function resolveReportRange(query: {
  from?: string | undefined
  to?: string | undefined
}): ResolvedRange | null {
  const { from, to } = query
  if (from == null && to == null) return null
  if (from == null || to == null) {
    badRange('Both `from` and `to` are required for a custom date range.')
  }
  const f = parseUtcDate(from)
  const t = parseUtcDate(to)
  if (!f) badRange(`\`from\` is not a valid YYYY-MM-DD date: ${from}`)
  if (!t) badRange(`\`to\` is not a valid YYYY-MM-DD date: ${to}`)
  // Lexical compare is chronological for anchored YYYY-MM-DD.
  if (from > to) badRange(`\`from\` (${from}) must not be after \`to\` (${to}).`)
  // Cap the span so a pathological range (from=2000, to=2100) can't trigger a
  // full-history scan or an unusable heatmap x-axis. ~13 months covers every real
  // reporting need (a trailing year plus slack).
  const spanDays =
    (Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(f.y, f.m - 1, f.d)) / 86_400_000 + 1
  if (spanDays > MAX_RANGE_DAYS) {
    badRange(`Custom range spans ${spanDays} days; the maximum is ${MAX_RANGE_DAYS}.`)
  }
  return {
    from,
    to,
    startIso: new Date(Date.UTC(f.y, f.m - 1, f.d)).toISOString(),
    endIso: new Date(Date.UTC(t.y, t.m - 1, t.d + 1)).toISOString(), // +1 day → exclusive end
  }
}

// ── Usage window (the half-open [startIso, endIso) every windowed query binds) ─
/**
 * A half-open `[startIso, endIso)` usage window — the minimal shape every
 * windowed reporting query binds on. {@link MonthRangeUtc} and {@link ResolvedWindow}
 * are both structural supersets, so a month-path caller passes its resolved month
 * range unchanged while a custom-range caller passes the resolved window; the query
 * fns never branch on which one they got.
 */
export interface UsageWindow {
  /** Inclusive lower bound (ISO instant). */
  startIso: string
  /** EXCLUSIVE upper bound (ISO instant). */
  endIso: string
}

/**
 * True when BOTH window bounds fall on a calendar-month boundary
 * (`YYYY-MM-01T00:00:00.000Z`). The month path always is (its bounds are month
 * starts); a whole-month multiple like `[2026-05-01, 2026-07-01)` is too; a
 * sub-month or mid-month-straddling custom range is NOT.
 *
 * The §B Copilot pooled chargeback is POOLED-MONTHLY
 * (`v_finance_copilot_pool_chargeback`, `period_month` = month-start) with NO daily
 * grain, so it may only be folded into a chargeable total over a MONTH-ALIGNED window.
 * Folding it over a partial-month range would either charge a WHOLE month's pool
 * against a fraction of the month, or — when the window misses the pool's month-start
 * — silently drop it under a "+ Copilot pooled net" label. Callers gate the pool fold
 * on this and surface a "partial-month" caveat instead of a bare $0.
 */
export function isMonthAlignedWindow(window: UsageWindow): boolean {
  const isMonthStartInstant = (iso: string): boolean => {
    const d = new Date(iso)
    return (
      d.getUTCDate() === 1 &&
      d.getUTCHours() === 0 &&
      d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 &&
      d.getUTCMilliseconds() === 0
    )
  }
  return isMonthStartInstant(window.startIso) && isMonthStartInstant(window.endIso)
}

// ── Unified window (month OR custom range) ───────────────────────────────────

export interface ResolvedWindow {
  /** Inclusive lower bound (ISO instant) — the half-open range start. */
  startIso: string
  /** EXCLUSIVE upper bound (ISO instant). */
  endIso: string
  /** `true` = a calendar-month window (MoM / forecast eligible); `false` = custom range. */
  isMonth: boolean
  /** The `YYYY-MM` key when `isMonth`; `null` for a custom range. */
  monthStr: string | null
  /** Inclusive window bounds as `YYYY-MM-DD` (the trend `window` echo + UI labels). */
  from: string
  to: string
  /**
   * The full {@link MonthRangeUtc} when `isMonth` (the month path needs it to derive
   * the previous-month window for MoM + to anchor the forecast); `null` for a range.
   */
  monthRange: MonthRangeUtc | null
}

/**
 * The single entry point every windowed reporting endpoint branches on. When
 * `?from`/`?to` are present it resolves the custom range (MoM / forecast are then
 * caller-nulled — they only make sense for a month/MTD). Otherwise it defaults to
 * the `?month` path (or the current UTC month), IDENTICAL to today's behaviour.
 */
export function resolveReportWindow(
  query: { month?: string | undefined; from?: string | undefined; to?: string | undefined },
  opts: { now?: Date; monthFloor?: string } = {},
): ResolvedWindow {
  const range = resolveReportRange(query)
  if (range) {
    return {
      startIso: range.startIso,
      endIso: range.endIso,
      isMonth: false,
      monthStr: null,
      from: range.from,
      to: range.to,
      monthRange: null,
    }
  }
  const { month, range: mr } = resolveReportMonth(query.month, opts)
  // Inclusive last day of the month = the day before the exclusive next-month start.
  const toDate = new Date(mr.nextMonthStartUtc.getTime() - 86_400_000).toISOString().slice(0, 10)
  return {
    startIso: mr.startIso,
    endIso: mr.endIso,
    isMonth: true,
    monthStr: month,
    from: mr.startIso.slice(0, 10),
    to: toDate,
    monthRange: mr,
  }
}

// ── MoM pace window (like-for-like month-over-month) ─────────────────────────
/**
 * The previous-month window CLIPPED to the SAME day-of-month PACE as the viewed
 * month's DATA FRONTIER (`asOf` = the latest day carrying usage, `MAX(ts_event)`
 * over the month window), so a MoM delta compares like-for-like: the current side
 * covers `[monthStart, asOf]`, the previous side its SAME first-N days.
 *
 * Pacing on `asOf` (NOT `now`) is deliberate — during settling the current month's
 * data ends before today, so pacing on `now` would compare a partial current side
 * against a LONGER previous window (the spurious early-month drop this replaces).
 * `asOf` is always inside the viewed month, so both real cases fall out of the one
 * expression: an in-progress month paces to its latest data day; a complete month
 * (asOf = its last day) paces to the WHOLE previous month. The prev end is clamped
 * to the previous month's own length, so a 31st never over-reaches a 30-/28-day
 * prior month.
 */
export function momPaceWindow(monthRange: MonthRangeUtc, asOf: Date): UsageWindow {
  const prev = monthRangeUtc(monthKeyUtc(new Date(monthRange.monthStartUtc.getTime() - 1)))
  const days = Math.min(asOf.getUTCDate(), daysInMonthUtc(prev.monthStartUtc))
  const prevEnd = new Date(prev.monthStartUtc.getTime() + days * 86_400_000)
  return { startIso: prev.startIso, endIso: prevEnd.toISOString() }
}

// ── Seasonality builder (pure — ISO-week axis + indexed cells) ────────────────
/**
 * Shape the `(iso_week, dow, value)` group rows the seasonality queries return
 * into the wire {@link SeasonalityCell}s + the ordered ISO-week axis. Pure so the
 * Across + Regional fetchers share ONE definition (and it is unit-testable without
 * a DB). `weeks` is the distinct ISO-week set sorted oldest→newest (lexical sort
 * is chronological for zero-padded `YYYY-Www`); every cell's `weekIdx` indexes it.
 */
export function buildSeasonality(
  rows: { iso_week: string; dow: number | string; value: string | number }[],
): { weeks: string[]; cells: SeasonalityCell[] } {
  const weeks = [...new Set(rows.map((r) => r.iso_week))].sort()
  const weekIdx = new Map(weeks.map((w, i) => [w, i]))
  const cells: SeasonalityCell[] = rows.map((r) => ({
    dow: Number(r.dow),
    weekIdx: weekIdx.get(r.iso_week)!,
    value: Number(r.value),
  }))
  return { weeks, cells }
}

/**
 * Zero-fill the seven ISO day-of-week buckets (Mon=0..Sun=6) from a sparse
 * `dow → chargeUsd` map so a §B "when spend happens" card always renders a stable
 * seven-bar layout (a weekday with no chargeback reads a genuine 0). Pure — shared by
 * the Across + Regional chargeback-dow fetchers so there is ONE definition.
 */
export function fillDowBuckets(byDow: Map<number, number>): ChargeDowBucket[] {
  return Array.from({ length: 7 }, (_, dow) => ({ dow, chargeUsd: byDow.get(dow) ?? 0 }))
}

// ── Weekly lane merge (pure — shared by Across + Regional usage weekly-lane fetchers) ─
/** Canonical lane order index for deterministic weekly-lane emission. */
const WEEKLY_LANE_ORDER = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))

/**
 * Merge raw `(week_start, tool, usd)` group rows into `(week, LANE)` cells:
 * tools sharing a lane (N:1 by contract) SUM, unknown/NULL falls to 'other'
 * (toolToVendor's catch-all — nothing ever vanishes from the composition),
 * emitted (week asc, canonical lane order) deterministically. Pure and
 * basis-agnostic (the caller's SQL determines whether `usd` is §A usage or §B
 * billed) — ONE definition for the Across + Regional weekly per-surface usage
 * fetchers so their cell shape can never drift (and it is unit-testable
 * without a DB).
 */
export function mergeWeeklyLaneRows(
  rows: Iterable<{ week_start: string; tool: string | null; usd: string }>,
): UsageSurfaceWeeklyCell[] {
  const byWeekLane = new Map<string, number>()
  for (const r of rows) {
    const k = `${r.week_start} ${toolToVendor(r.tool)}`
    byWeekLane.set(k, (byWeekLane.get(k) ?? 0) + Number(r.usd))
  }
  return [...byWeekLane.entries()]
    .map(([k, usd]) => {
      const [weekStart, lane] = k.split(' ') as [string, string]
      return { weekStart, lane, usd }
    })
    .sort(
      (a, b) =>
        (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0) ||
        (WEEKLY_LANE_ORDER.get(a.lane) ?? 99) - (WEEKLY_LANE_ORDER.get(b.lane) ?? 99),
    )
}

// ── Driver-row surface + provenance breakdown fold (requirements 3/4) ────────
// Shared by every axis whose query groups by an extra (tool, usage_provenance)
// pair per key — the teammate axis today (across-regions.ts / regional.ts /
// cost-centres.ts) — so a row's total, its `surfaceBreakdown`, and its
// `provenanceBreakdown` are always computed from the SAME underlying rows
// (guaranteeing the sum-back invariant, build-design §7(4)) rather than three
// separate queries that could silently drift apart.

/** One raw (key, label, tool, provenance, value) row — one row per
 *  (key, tool, usage_provenance) triple in the source query. */
export interface DriverBreakdownRaw {
  key: string | null
  label: string | null
  tool: string | null
  provenance: string | null
  value: string
}

/** A single driver key's folded aggregate — its total plus both breakdowns. */
export interface FoldedDriverAggregate {
  label: string | null
  total: number
  /** Registry lane id → Σ usd for that lane, this key. */
  bySurface: Map<Vendor, number>
  /** usage_provenance → Σ usd for that provenance, this key. */
  byProvenance: Map<string, number>
}

/**
 * Fold raw (key, label, tool, provenance, value) rows into per-KEY aggregates
 * carrying a per-surface (registry lane, `toolToVendor`) AND a per-provenance
 * breakdown, from ONE row set.
 */
export function foldDriverBreakdown(
  raws: Iterable<DriverBreakdownRaw>,
): Map<string, FoldedDriverAggregate> {
  const byKey = new Map<string, FoldedDriverAggregate>()
  for (const r of raws) {
    const k = r.key ?? ''
    let agg = byKey.get(k)
    if (!agg) {
      agg = { label: r.label, total: 0, bySurface: new Map(), byProvenance: new Map() }
      byKey.set(k, agg)
    }
    const usd = Number(r.value)
    agg.total += usd
    if (!agg.label && r.label) agg.label = r.label
    const lane = toolToVendor(r.tool)
    agg.bySurface.set(lane, (agg.bySurface.get(lane) ?? 0) + usd)
    if (r.provenance) {
      agg.byProvenance.set(r.provenance, (agg.byProvenance.get(r.provenance) ?? 0) + usd)
    }
  }
  return byKey
}

/** Registry lane order index — reused so a breakdown's lane order can never
 *  drift from the weekly-lane merge above. */
const SURFACE_LANE_ORDER = new Map<string, number>(VENDOR_LANES.map((l, i) => [l, i]))

/**
 * `bySurface` → the wire `DriverSurfaceAmount[]`, in canonical REGISTRY lane
 * order (never $-desc — requirement 3: "colors/labels from a shared registry
 * helper" — a surface breakdown reads as a fixed composition, like the
 * provider split / lane legend, not a re-sorted ranking). Zero-amount lanes
 * are elided (nothing to show); labels are registry-derived (`VENDOR_LABELS`),
 * never hand-typed.
 */
export function driverSurfaceBreakdown(
  bySurface: ReadonlyMap<Vendor, number>,
): DriverSurfaceAmount[] {
  return [...bySurface.entries()]
    .filter(([, usd]) => usd !== 0)
    .sort(([a], [b]) => (SURFACE_LANE_ORDER.get(a) ?? 99) - (SURFACE_LANE_ORDER.get(b) ?? 99))
    .map(([lane, usd]) => ({ lane, label: VENDOR_LABELS[lane], usd }))
}

/**
 * `byProvenance` → the wire `DriverProvenanceAmount[]`, in the canonical Axis-1
 * order (`USAGE_PROVENANCE_VALUES`, `shared/usage/provenance.ts`).
 */
export function driverProvenanceBreakdown(
  byProvenance: ReadonlyMap<string, number>,
): DriverProvenanceAmount[] {
  return USAGE_PROVENANCE_VALUES.filter(
    (p) => (byProvenance.get(p) ?? 0) !== 0,
  ).map((p) => ({ provenance: p, usd: byProvenance.get(p)! }))
}

/**
 * True when EVERY dollar in `bySurface` sits on a GitHub §A USAGE lane
 * (`GITHUB_USAGE_LANE_IDS` — 'copilot' + 'copilot-agent', registry-derived) —
 * the driver-row `pooled-usage` gate (both GitHub usage lanes draw against the
 * SAME pooled per-org AI-Credit allowance, docs/wiki/Reporting.md §5, so a
 * teammate whose ENTIRE usage sits there is never a per-user charge). Widens
 * the pre-existing 'copilot-cli'-only check now that `copilot-agent` is a live
 * `v_complete_usage` lane (migration 0101's ingest-only completeness arm) —
 * mixed/Claude usage stays `indicative`.
 */
export function isPooledSurfaceOnly(bySurface: ReadonlyMap<Vendor, number>): boolean {
  let total = 0
  for (const [lane, usd] of bySurface) {
    if (usd === 0) continue
    total += usd
    if (!GITHUB_USAGE_LANE_IDS.includes(lane)) return false
  }
  return total > 0
}

// ── Driver CSV additive columns (requirement 8 — screen/CSV parity) ──────────
// The FIXED-header trailing columns every driver CSV appends for a row
// carrying either breakdown, per the codebase's additive-only CSV convention
// (new columns append at the END, never splice into the middle). A row from an
// axis this requirement did not extend (region/practice/project) carries
// neither breakdown, so its cells are the explicit empty string — never a
// fabricated 0.00 implying a computation that never ran.

/** One CSV cell per `USAGE_PROVENANCE_VALUES` member, '' when `row` carries no
 *  `provenanceBreakdown` at all. Σ(non-empty cells) === row.usd, cent-exact. */
export function driverProvenanceCsvCells(row: {
  provenanceBreakdown?: DriverProvenanceAmount[]
}): string[] {
  if (!row.provenanceBreakdown) return USAGE_PROVENANCE_VALUES.map(() => '')
  const byProvenance = new Map(row.provenanceBreakdown.map((p) => [p.provenance, p.usd]))
  return USAGE_PROVENANCE_VALUES.map((p) => (byProvenance.get(p) ?? 0).toFixed(2))
}

/** A single semicolon-joined `lane:usd` compound cell (registry order), '' when
 *  `row` carries no `surfaceBreakdown`. Σ(parsed usd) === row.usd, cent-exact. */
export function driverSurfaceMixCsvCell(row: { surfaceBreakdown?: DriverSurfaceAmount[] }): string {
  if (!row.surfaceBreakdown?.length) return ''
  return row.surfaceBreakdown.map((s) => `${s.lane}:${s.usd.toFixed(2)}`).join(';')
}

// ── The chargeback-lane EXPORT GRAIN (build-design §2 + §7, byte-identical) ──
/*
 * A driver CSV used to serialise `rows` and nothing else. In the chargeback lane
 * that is a subset of what is ON SCREEN: the DriversTable renders the per-arm
 * consumption blocks below the billed total, and — since the pooled Copilot
 * invoice landed — the headline itself is folded from more than one arm. Every
 * one of those figures vanished from a file stamped `lane=billed`, which breaks
 * the byte-identical export rule in the direction that matters most: a
 * spreadsheet reader sees the Anthropic charge and has no way to learn that the
 * Copilot money existed at all.
 *
 * So the arms are a SECOND GRAIN in the same file, one line per (arm, driver),
 * each line naming what its money MEANS (`measure`) and where it was read from
 * (`source`). Two grains rather than extra columns on the first, because an arm
 * row and a folded row are different populations: folding them into one grid
 * would let a naive `SUM(spend_usd)` double-count the charge arms.
 */

/** `''` for a $-less cell — never a fabricated `0.00`. */
function armUsd(n: number): string {
  return n.toFixed(2)
}

/**
 * The CSV lines for every provider arm behind a chargeback answer, plus the
 * chargeback-coverage statement, or `[]` when the answer is not a billed one.
 *
 * An arm with NO rows still gets a line (empty driver + empty spend): "GitHub
 * has not been derived for this window" is information, and an absent line is
 * indistinguishable from an arm nobody looked for.
 */
export function driverArmCsvLines(
  billedLane: BilledLaneMeta | undefined,
  coverage?: ChargebackCoverage,
): string[] {
  const lines: string[] = []
  if (coverage) {
    /*
     * The reason a Copilot column is missing travels IN THE FILE. A CSV outlives
     * the page, and "Anthropic only" is exactly the qualifier a reader loses
     * first when a figure is pasted into a deck.
     */
    lines.push('')
    lines.push(
      `# chargeback_providers=${coverage.providers.join('+') || 'none'}`,
      ...coverage.gaps.map((g) => `# gap · ${g.provider ?? 'all providers'} · ${g.reason}`),
    )
  }
  if (!billedLane) return lines
  lines.push('')
  lines.push('provider,measure,source,availability,arm_total_usd,driver,spend_usd')
  for (const arm of billedLane.arms) {
    const stem = `${csvEscape(arm.provider)},${csvEscape(arm.measure)},${csvEscape(arm.source)},${csvEscape(arm.availability)},${armUsd(arm.totalUsd)}`
    if (arm.rows.length === 0) {
      lines.push(`${stem},,`)
      continue
    }
    for (const r of arm.rows) lines.push(`${stem},${csvEscape(r.label)},${armUsd(r.usd)}`)
  }
  return lines
}
