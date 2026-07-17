/*
 * build-consumption-hero — the pure builder behind the /consumption
 * "What kind of AI work drove this" hero (visuals-iter2 §I3).
 *
 * TWO half-height weekly stacks sharing ONE x-axis, one per BASIS GROUP
 * ("Telemetry-attributed" / "Billed surfaces"). The groups are a VISUAL
 * juxtaposition only: each group folds, scales, and totals INDEPENDENTLY —
 * no scalar (and no y-scale) ever sums or spans across bases (r1-F1).
 *
 * Fold semantics mirror fold-lanes.ts (rank-once, conservation-preserving,
 * shared MAX_CHART_LANES cap) with the §I3/r1-F4 refinement: the PARTIAL
 * current week is excluded from the ranking input (fold membership is decided
 * on complete weeks of the visible window) but INCLUDED in the rendered bars,
 * flagged `partial` so the component renders it dashed / "in progress" and
 * every stat (chips, shares) ignores it — chips are calendar-MTD from the
 * endpoint, never recomputed from the bars.
 *
 * Pure TS (no Vue, no DOM) so the fold + conservation maths is unit-testable.
 */
import {
  FOLDED_LANE_ID,
  FOLDED_LANE_LABEL,
  MAX_CHART_LANES,
} from '../reporting/charts/fold-lanes'

// ── wire shapes (the /api/v1/me/consumption `hero` payload) ────────────────

export interface HeroLaneWeekWire {
  week_start: string // 'YYYY-MM-DD' Monday UTC
  usd: string
}

export interface HeroLaneWire {
  lane: string
  label: string
  mtd_usd: string
  weekly: HeroLaneWeekWire[]
}

export interface HeroGroupWire {
  id: string
  label: string
  basis: string
  lanes: HeroLaneWire[]
}

// ── built shapes ────────────────────────────────────────────────────────────

export interface BuiltHeroChip {
  lane: string
  label: string
  /** Calendar-MTD total from the lane's OWN source (endpoint-provided). */
  mtdUsd: number
  /** Share of the group's visible MTD Σ (0..1) — PER BASIS GROUP, never cross-basis. */
  share: number
  /** Remainder chip only: itemisation of the folded lanes' MTD totals. */
  foldedTitle?: string
}

export interface BuiltHeroSegment {
  lane: string
  label: string
  usd: number
}

export interface BuiltHeroBar {
  weekStart: string
  /** True for the in-progress current week (dashed, excluded from stats). */
  partial: boolean
  totalUsd: number
  segments: BuiltHeroSegment[]
}

export interface BuiltHeroGroup {
  id: string
  label: string
  basis: string
  /** Rendered lane ids (kept + the folded remainder) — legend/chips source. */
  laneIds: string[]
  chips: BuiltHeroChip[]
  bars: BuiltHeroBar[]
  /** This group's OWN y-scale max (bases differ — scales never shared). */
  maxUsd: number
}

export interface BuiltHero {
  /** The shared x-axis: dense Mon-UTC week list covering the window. */
  weeks: Array<{ weekStart: string; partial: boolean }>
  groups: BuiltHeroGroup[]
}

/** Monday (UTC) of the ISO week containing `d`, as 'YYYY-MM-DD'. */
export function isoWeekStartUtc(d: Date): string {
  const offset = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset)
  return new Date(monday).toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000

/**
 * Build both basis-group stacks over ONE dense shared week axis (the trailing
 * `windowDays` ending `todayIso`, UTC). Per group: fold membership ranked once
 * over the COMPLETE weeks of the window (ties → input order), remainder =
 * per-week Σ of exactly the folded lanes (conservation-preserving), MTD chips
 * with share-of-visible per group.
 *
 * `todayIso` ('YYYY-MM-DD', UTC) is REQUIRED and must be SERVER-provided (the
 * endpoint's `hero.as_of`) — never a client-side `new Date()`: SSR and client
 * hydration can straddle a UTC midnight and disagree on the partial-week flag
 * (hydration mismatch — iter2 review r1).
 */
export function buildConsumptionHero(
  groups: readonly HeroGroupWire[],
  windowDays: number,
  todayIso: string,
): BuiltHero {
  const today = new Date(`${todayIso}T00:00:00.000Z`)
  // Dense Mon-UTC week axis covering [today-(windowDays-1) .. today].
  const currentWeek = isoWeekStartUtc(today)
  const firstWeek = isoWeekStartUtc(new Date(today.getTime() - (windowDays - 1) * DAY_MS))
  const weeks: Array<{ weekStart: string; partial: boolean }> = []
  for (let t = Date.parse(firstWeek); ; t += 7 * DAY_MS) {
    const weekStart = new Date(t).toISOString().slice(0, 10)
    if (weekStart > currentWeek) break
    weeks.push({ weekStart, partial: weekStart === currentWeek })
  }

  const builtGroups = groups.map((g): BuiltHeroGroup => {
    // Per-lane week map (sum duplicate weeks defensively; drop rows outside
    // the axis — the endpoint's window predicate matches, so none in practice).
    const laneWeeks = g.lanes.map((l) => {
      const byWeek = new Map<string, number>()
      for (const w of l.weekly) {
        byWeek.set(w.week_start, (byWeek.get(w.week_start) ?? 0) + Number(w.usd))
      }
      return { ...l, byWeek }
    })

    // Fold membership: rank once on COMPLETE weeks only (r1-F4), ties resolve
    // to input order via an explicit secondary key (the fold-lanes rule).
    const completeTotal = (byWeek: Map<string, number>) =>
      weeks.reduce((a, w) => (w.partial ? a : a + (byWeek.get(w.weekStart) ?? 0)), 0)
    let kept = laneWeeks
    let folded: typeof laneWeeks = []
    if (laneWeeks.length > MAX_CHART_LANES) {
      const ranked = laneWeeks
        .map((l, index) => ({ l, index, total: completeTotal(l.byWeek) }))
        .sort((a, b) => b.total - a.total || a.index - b.index)
      const keepSet = new Set(ranked.slice(0, MAX_CHART_LANES - 1).map((r) => r.l))
      kept = laneWeeks.filter((l) => keepSet.has(l))
      folded = laneWeeks.filter((l) => !keepSet.has(l))
    }

    // Bars: kept lanes in INPUT order + the remainder last; zero segments
    // elided per bar (`!== 0` — credits net in, never vanish).
    const bars = weeks.map((w): BuiltHeroBar => {
      const segments: BuiltHeroSegment[] = []
      for (const l of kept) {
        const usd = l.byWeek.get(w.weekStart) ?? 0
        if (usd !== 0) segments.push({ lane: l.lane, label: l.label, usd })
      }
      const remainder = folded.reduce((a, l) => a + (l.byWeek.get(w.weekStart) ?? 0), 0)
      if (remainder !== 0) {
        segments.push({ lane: FOLDED_LANE_ID, label: FOLDED_LANE_LABEL, usd: remainder })
      }
      return {
        weekStart: w.weekStart,
        partial: w.partial,
        totalUsd: segments.reduce((a, s) => a + s.usd, 0),
        segments,
      }
    })

    // MTD chips: per-lane calendar-MTD totals from the ENDPOINT (each lane's
    // own source), share-of-visible within THIS group only.
    const keptChips = kept.map((l) => ({ lane: l.lane, label: l.label, mtdUsd: Number(l.mtd_usd) }))
    const remainderMtd = folded.reduce((a, l) => a + Number(l.mtd_usd), 0)
    const chipRows = folded.length
      ? [
          ...keptChips,
          {
            lane: FOLDED_LANE_ID,
            label: FOLDED_LANE_LABEL,
            mtdUsd: remainderMtd,
            foldedTitle: folded.map((l) => `${l.label} $${Number(l.mtd_usd).toFixed(2)}`).join(' · '),
          },
        ]
      : keptChips
    const groupMtd = chipRows.reduce((a, c) => a + c.mtdUsd, 0)
    const chips: BuiltHeroChip[] = chipRows.map((c) => ({
      ...c,
      share: groupMtd > 0 ? c.mtdUsd / groupMtd : 0,
    }))

    return {
      id: g.id,
      label: g.label,
      basis: g.basis,
      laneIds: [...kept.map((l) => l.lane), ...(folded.length ? [FOLDED_LANE_ID] : [])],
      chips,
      bars,
      maxUsd: Math.max(1e-9, ...bars.map((b) => b.totalUsd)),
    }
  })

  return { weeks, groups: builtGroups }
}
