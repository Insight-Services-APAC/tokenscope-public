/*
 * me-usage-window — the window-scoped reads behind the rebuilt /usage page
 * (developer-pages-consolidation/01-build-design.md W2: D17, D21, D22).
 *
 * ── ONE WINDOW, EVERY CARD (fix 1 / r1-H9) ──────────────────────────────────
 * The page's hero tiles, "Where it went" rows, engagement columns and model
 * panel all follow the SAME resolved window (`resolveReportWindow`: month XOR
 * from/to — D16). Every read here takes the caller's half-open
 * `[startIso, endIso)` bounds and binds BOTH sides; nothing computes its own
 * window. Only the Daily-spend trend card keeps its trailing 30/90d window,
 * by owner ruling (D18) — that read stays in consumption.ts, untouched.
 *
 * ── THE LANE ─────────────────────────────────────────────────────────────────
 * §A figures read `v_complete_usage` (arms 1+2+3) — the same seam every other
 * §A surface reads; never the OTel-only aggregate, never the raw ledger
 * (consumption-perf-gate). The one §B figure (the chargeback-lane lead tile)
 * reads `v_finance_bill_chargeback`, exactly as `getMyChargeableMtd` does —
 * §A and §B stay separate axes; nothing here mixes lanes into one quotient.
 *
 * ── DELTAS (D17) ─────────────────────────────────────────────────────────────
 * MoM deltas are same-elapsed-window comparisons via `momPaceWindow`, paced on
 * the DATA FRONTIER (the latest day carrying usage), not `now` — the reporting
 * hero's own rule. Two named empty reasons and no third:
 * `'too early to compare'` (< 3 elapsed days, or no comparable prior operand)
 * and `'no month-on-month for a custom range'` (ScopeHero.vue:139-141 — the
 * exact vocabulary, reused).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { SpendLens } from '../../shared/usage/lens'
import type { SpendWindow } from './complete-spend'

type Tx = PostgresJsDatabase<Record<string, unknown>>

// ── Window daily read (tiles 1/2/4 operands + sparks) ────────────────────────

export interface TeammateWindowDaily {
  /** Per-day totals, day-ordered; gap days absent (the spark builder pads). */
  days: Array<{ day: string; costUsd: number; tokens: number }>
  totalUsd: number
  tokens: number
  /** Distinct days carrying any usage — the Active-days tile's count. */
  activeDays: number
  /** Latest day (`YYYY-MM-DD`) carrying usage — the MoM pace anchor. */
  frontierDay: string | null
}

/** The caller's §A daily series over a half-open window — both sides bound. */
export async function teammateWindowDaily(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
): Promise<TeammateWindowDaily> {
  const rows = await tx.execute<{ day: string; cost_usd: string; tokens: string }>(sql`
    SELECT (u.ts_event AT TIME ZONE 'UTC')::date::text AS day,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd,
           COALESCE(SUM(u.tokens), 0)::text AS tokens
      FROM v_complete_usage u
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.ts_event >= ${window.startIso}::timestamptz
       AND u.ts_event <  ${window.endIso}::timestamptz
     GROUP BY 1 ORDER BY 1
  `)
  const days = [...rows].map((r) => ({
    day: r.day,
    costUsd: Number(r.cost_usd),
    tokens: Number(r.tokens),
  }))
  return {
    days,
    totalUsd: days.reduce((a, d) => a + d.costUsd, 0),
    tokens: days.reduce((a, d) => a + d.tokens, 0),
    activeDays: days.length,
    frontierDay: days.length ? days[days.length - 1]!.day : null,
  }
}

// ── Per-project contribution (D21 rows + the Budgeted-share tile) ────────────

export interface TeammateWindowProject {
  projectId: string
  code: string
  displayName: string
  /** The CALLER's spend on this project in the window (arms 1+2 carry project_id). */
  mineUsd: number
  /** Current membership — the D29 drill rule's operand (link vs plain text). */
  isMember: boolean
}

/** The caller's per-project window spend, ranked, with current-membership flag. */
export async function teammateWindowProjects(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
): Promise<TeammateWindowProject[]> {
  const rows = await tx.execute<{
    project_id: string
    code: string
    display_name: string
    mine_usd: string
    is_member: boolean
  }>(sql`
    SELECT u.project_id::text AS project_id,
           p.code, p.display_name,
           COALESCE(SUM(u.cost_usd), 0)::text AS mine_usd,
           EXISTS (
             SELECT 1 FROM project_assignment pa
              WHERE pa.project_id = u.project_id
                AND pa.teammate_id = ${teammateId}::uuid
                AND pa.effective @> now()
           ) AS is_member
      FROM v_complete_usage u
      JOIN project p ON p.id = u.project_id
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.project_id IS NOT NULL
       AND u.ts_event >= ${window.startIso}::timestamptz
       AND u.ts_event <  ${window.endIso}::timestamptz
     GROUP BY u.project_id, p.code, p.display_name
     ORDER BY SUM(u.cost_usd) DESC, p.code
  `)
  return [...rows].map((r) => ({
    projectId: r.project_id,
    code: r.code,
    displayName: r.display_name,
    mineUsd: Number(r.mine_usd),
    isMember: r.is_member === true,
  }))
}

/**
 * Per-day spend restricted to a project set — the Budgeted-share tile's spark
 * operand (days absent from the map carried no budgeted spend).
 */
export async function teammateWindowDailyForProjects(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map()
  const rows = await tx.execute<{ day: string; cost_usd: string }>(sql`
    SELECT (u.ts_event AT TIME ZONE 'UTC')::date::text AS day,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
      FROM v_complete_usage u
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.project_id = ANY(ARRAY[${sql.join(
         projectIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )}])
       AND u.ts_event >= ${window.startIso}::timestamptz
       AND u.ts_event <  ${window.endIso}::timestamptz
     GROUP BY 1
  `)
  return new Map([...rows].map((r) => [r.day, Number(r.cost_usd)]))
}

// ── The §B lead tile (chargeback lane) ───────────────────────────────────────

export interface TeammateWindowChargeable {
  days: Array<{ day: string; usd: number }>
  totalUsd: number
}

/**
 * The caller's chargeable spend per day over inclusive day bounds — the same
 * `v_finance_bill_chargeback` read `getMyChargeableMtd` makes, windowed. §B
 * only ever feeds the Chargeable tile; no §A figure divides by it.
 */
export async function teammateWindowChargeable(
  tx: Tx,
  teammateId: string,
  dayBounds: { from: string; to: string },
): Promise<TeammateWindowChargeable> {
  const rows = await tx.execute<{ day: string; usd: string }>(sql`
    SELECT period_date::text AS day, COALESCE(SUM(bill_usd), 0)::text AS usd
      FROM v_finance_bill_chargeback
     WHERE teammate_id = ${teammateId}::uuid
       AND period_date >= ${dayBounds.from}::date
       AND period_date <= ${dayBounds.to}::date
     GROUP BY 1 ORDER BY 1
  `)
  const days = [...rows].map((r) => ({ day: r.day, usd: Number(r.usd) }))
  return { days, totalUsd: days.reduce((a, d) => a + d.usd, 0) }
}

// ── The Claude engagement column (D22 — Claude's OWN vocabulary) ─────────────

export interface TeammateClaudeWindow {
  /** Distinct days with any Claude-surface usage in the window. */
  activeDays: number
  /** Σ `provider_usage_fact.web_search_requests` (mig 0122), Anthropic arm. */
  webSearches: number
  /** Claude-surface spend mix (tool → Σ cost), share basis for the surface row. */
  surfaces: Array<{ tool: string; usd: number }>
}

/**
 * The Claude column's operands: surface mix + active days from the §A lane
 * (Claude tools only), web searches from the provider facts. NO LOC figures
 * here and never will — no fake symmetry with the Copilot column (D22).
 */
export async function teammateClaudeWindow(
  tx: Tx,
  teammateId: string,
  window: SpendWindow,
  dayBounds: { from: string; to: string },
): Promise<TeammateClaudeWindow> {
  const [surfaceRows, searchRows] = await Promise.all([
    tx.execute<{ tool: string; usd: string; days: string }>(sql`
      SELECT u.tool,
             COALESCE(SUM(u.cost_usd), 0)::text AS usd,
             COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)::text AS days
        FROM v_complete_usage u
       WHERE u.teammate_id = ${teammateId}::uuid
         AND u.tool LIKE 'claude%'
         AND u.ts_event >= ${window.startIso}::timestamptz
         AND u.ts_event <  ${window.endIso}::timestamptz
       GROUP BY u.tool
       ORDER BY SUM(u.cost_usd) DESC
    `),
    tx.execute<{ n: string }>(sql`
      SELECT COALESCE(SUM(web_search_requests), 0)::text AS n
        FROM provider_usage_fact
       WHERE teammate_id = ${teammateId}::uuid
         AND provider = 'anthropic'
         AND date >= ${dayBounds.from}::date
         AND date <= ${dayBounds.to}::date
    `),
  ])
  const surfaces = [...surfaceRows].map((r) => ({ tool: r.tool, usd: Number(r.usd) }))
  // Distinct ACROSS tools, not Σ per-tool counts: re-query-free upper bound is
  // wrong when two tools share a day, so take the distinct-day count directly.
  const dayRows = await tx.execute<{ n: string }>(sql`
    SELECT COUNT(DISTINCT (u.ts_event AT TIME ZONE 'UTC')::date)::text AS n
      FROM v_complete_usage u
     WHERE u.teammate_id = ${teammateId}::uuid
       AND u.tool LIKE 'claude%'
       AND u.ts_event >= ${window.startIso}::timestamptz
       AND u.ts_event <  ${window.endIso}::timestamptz
  `)
  return {
    activeDays: Number([...dayRows][0]?.n ?? 0),
    webSearches: Number([...searchRows][0]?.n ?? 0),
    surfaces,
  }
}

// ── Hero-tile assembly (pure — D17's wire shape) ─────────────────────────────

/** The two named delta-empty reasons — ScopeHero's own vocabulary, reused. */
export const DELTA_TOO_EARLY = 'too early to compare'
export const DELTA_CUSTOM_RANGE = 'no month-on-month for a custom range'

/** Elapsed-day floor under which a MoM comparison is withheld (D17). */
export const DELTA_MIN_ELAPSED_DAYS = 3

export interface MeHeroTileWire {
  key: 'attributed' | 'chargeable' | 'budgeted' | 'quota' | 'active_days'
  value_usd?: string
  count?: number
  /** Signed MoM fraction (money tiles); null when withheld. */
  delta_pct?: number | null
  /** Signed absolute count delta (Active days); null when withheld. */
  delta_abs?: number | null
  delta_empty_reason?: string | null
  /** Same-window daily series, zero-filled up to the data frontier. */
  spark?: number[]
  /** Budgeted tile: share of the attributed figure (fraction), + operands. */
  budgeted_share_pct?: number | null
  no_budget_usd?: string
  untagged_usd?: string
  /** Active-days tile: the "of N so far" denominator. */
  days_so_far?: number
  /** Quota tile: which basis the client may render quota operands on. */
  quota_basis?: 'window-month' | 'not-current-month' | 'custom-range'
}

export interface MeHeroWindowWire {
  from: string
  to: string
  is_month: boolean
  month: string | null
  /** Month windows only (pace lines + "day X of Y"); null for a custom range. */
  days_elapsed: number | null
  days_in_month: number | null
  /**
   * Does the hero sparks' LAST point fall on a still-filling day?
   *
   * The sparks are dense over `[from … min(to, today)]` (`sparkAxis`), so the
   * answer is "the window reaches today" — a fact only the SERVER holds: nothing
   * else on this echo distinguishes a past month (`days_elapsed ===
   * days_in_month`, finished) from the current month's LAST day (identical
   * numbers, still filling). It is shipped rather than inferred because the
   * client would otherwise have to reason from the frame, which cannot tell the
   * two apart (external review r2 — see MonthSpark's `partial`).
   */
  spark_partial: boolean
}

export interface MeHeroTilesInput {
  lane: SpendLens
  window: MeHeroWindowWire
  current: TeammateWindowDaily
  /** Same-elapsed prior-month read; null when no MoM applies (custom range / too early). */
  previous: TeammateWindowDaily | null
  budgetedUsd: number
  noBudgetUsd: number
  untaggedUsd: number
  prevBudgetedUsd: number | null
  /** Day axis (`YYYY-MM-DD`, window start → data frontier/today) the sparks fill over. */
  sparkAxis: string[]
  budgetedByDay: Map<string, number>
  /** Chargeback lane only. */
  chargeable?: { totalUsd: number; byDay: Map<string, number>; prevTotalUsd: number | null }
  quotaBasis: 'window-month' | 'not-current-month' | 'custom-range'
}

function pctDelta(cur: number, prev: number | null): number | null {
  if (prev == null || prev <= 0) return null
  return Number(((cur - prev) / prev).toFixed(4))
}

/** Inclusive `YYYY-MM-DD` axis from `from` to `to` (empty when from > to). */
export function dayAxis(from: string, to: string): string[] {
  const out: string[] = []
  let t = Date.parse(`${from}T00:00:00.000Z`)
  const end = Date.parse(`${to}T00:00:00.000Z`)
  while (Number.isFinite(t) && Number.isFinite(end) && t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10))
    t += 86_400_000
  }
  return out
}

/**
 * Assemble the four tiles for the lane (D17). Pure — every operand arrives
 * from the caller so the delta rules are unit-testable without a DB.
 */
export function buildMeHeroTiles(input: MeHeroTilesInput): MeHeroTileWire[] {
  const { lane, window, current, previous } = input
  const monthDelta = (cur: number, prev: number | null): Pick<MeHeroTileWire, 'delta_pct' | 'delta_empty_reason'> => {
    if (!window.is_month) return { delta_pct: null, delta_empty_reason: DELTA_CUSTOM_RANGE }
    if ((window.days_elapsed ?? 0) < DELTA_MIN_ELAPSED_DAYS || previous == null) {
      return { delta_pct: null, delta_empty_reason: DELTA_TOO_EARLY }
    }
    const d = pctDelta(cur, prev)
    // No comparable prior operand (an empty prior window) is "too early", not 0%.
    return d == null
      ? { delta_pct: null, delta_empty_reason: DELTA_TOO_EARLY }
      : { delta_pct: d, delta_empty_reason: null }
  }

  const byDay = new Map(current.days.map((d) => [d.day, d]))
  const spark = (pick: (day: string) => number): number[] => input.sparkAxis.map(pick)
  const attributedSpark = spark((d) => byDay.get(d)?.costUsd ?? 0)
  const tokensSpark = spark((d) => byDay.get(d)?.tokens ?? 0)
  const budgetedSpark = spark((d) => input.budgetedByDay.get(d) ?? 0)

  const attributed: MeHeroTileWire = {
    key: 'attributed',
    value_usd: current.totalUsd.toFixed(2),
    ...monthDelta(current.totalUsd, previous?.totalUsd ?? null),
    spark: attributedSpark,
  }

  const budgeted: MeHeroTileWire = {
    key: 'budgeted',
    value_usd: input.budgetedUsd.toFixed(2),
    budgeted_share_pct:
      current.totalUsd > 0 ? Number((input.budgetedUsd / current.totalUsd).toFixed(4)) : null,
    no_budget_usd: input.noBudgetUsd.toFixed(2),
    untagged_usd: input.untaggedUsd.toFixed(2),
    ...monthDelta(input.budgetedUsd, input.prevBudgetedUsd),
    spark: budgetedSpark,
  }

  const quota: MeHeroTileWire = { key: 'quota', quota_basis: input.quotaBasis }

  const activeDaysDelta = ((): Pick<MeHeroTileWire, 'delta_abs' | 'delta_empty_reason'> => {
    if (!window.is_month) return { delta_abs: null, delta_empty_reason: DELTA_CUSTOM_RANGE }
    if ((window.days_elapsed ?? 0) < DELTA_MIN_ELAPSED_DAYS || previous == null) {
      return { delta_abs: null, delta_empty_reason: DELTA_TOO_EARLY }
    }
    // A prior window with NOTHING in it is not a comparison operand — the
    // same withholding rule the money tiles apply, said on the count axis.
    if (previous.totalUsd <= 0 && previous.activeDays === 0) {
      return { delta_abs: null, delta_empty_reason: DELTA_TOO_EARLY }
    }
    return { delta_abs: current.activeDays - previous.activeDays, delta_empty_reason: null }
  })()

  const activeDays: MeHeroTileWire = {
    key: 'active_days',
    count: current.activeDays,
    days_so_far: input.sparkAxis.length,
    ...activeDaysDelta,
    spark: tokensSpark,
  }

  if (lane === 'chargeback') {
    const c = input.chargeable ?? { totalUsd: 0, byDay: new Map<string, number>(), prevTotalUsd: null }
    const chargeable: MeHeroTileWire = {
      key: 'chargeable',
      value_usd: c.totalUsd.toFixed(2),
      ...monthDelta(c.totalUsd, c.prevTotalUsd),
      spark: spark((d) => c.byDay.get(d) ?? 0),
    }
    return [chargeable, attributed, quota, activeDays]
  }
  return [attributed, budgeted, quota, activeDays]
}
