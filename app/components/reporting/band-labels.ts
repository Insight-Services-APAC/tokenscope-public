/*
 * band-labels — the strings a reporting scope's two band headers carry.
 *
 * WHY A MODULE AND NOT TWO TEMPLATES. The Region scope renders at two widths
 * (whole-company and one region) from two different view components, and the
 * Cost-centre / Finance scopes have the same shape. If each wrote its own band
 * header, the widths would eventually disagree about what the same window is
 * called — the "two places rendering one fact will diverge" failure the
 * consolidation exists to remove. The strings are decided once, here, and both
 * views read them.
 *
 * Pure and dependency-free apart from `monthLabel`, so the interesting cases —
 * a custom range, a closed month, a month still running — are unit-testable
 * without mounting anything.
 */
import { monthLabel } from './window-labels'

/** The window fields a report's `meta` carries (structurally, so this module
 *  never depends on one scope's response type). */
export interface BandWindow {
  /** `YYYY-MM`. In range mode this is the window's start-month, not the window. */
  month: string
  /** Present ONLY in custom-range mode; both bounds inclusive `YYYY-MM-DD`. */
  range?: { from: string; to: string } | null
}

/**
 * What the PERIOD band's cards were measured over, named the way a reader names
 * it: "July 2026", or the range's own bounds.
 *
 * A range is printed rather than named. `meta.month` in range mode is only the
 * start-month representative, so labelling a `2026-06-14 → 2026-08-02` window
 * "June 2026" would name a period the figures beneath it do not cover — the
 * exact bug window-labels.ts documents at length.
 */
export function periodBandWindow(meta: BandWindow): string {
  return meta.range ? `${meta.range.from} → ${meta.range.to}` : monthLabel(meta.month)
}

/**
 * What the PERIOD band's figures ARE: lane, scope, and how much of the window
 * has actually happened.
 *
 * `inProgress` is the caller's forecast presence, not a date computed here — the
 * server decides whether a month is still running (it holds the data clock), and
 * a component recomputing it from `new Date()` would disagree with the server
 * across a UTC midnight and print "month to date" over a closed month.
 *
 * `scopeLabel` IS OMITTED WHEN NULL rather than defaulted to something readable
 * (contract C11). The only honest source for it is the resolver that built the
 * SQL clamp: a manager and a region admin both hold `regional: 'own-region'` but
 * the manager's §A clamp is their org SUBTREE, so a band header that inferred
 * "APAC" would print a region's name over one unit's numbers — the defect
 * BudgetCoverageNote already carries a long comment about. A band with no scope
 * word still states its window, which is the part it exists for.
 */
export function periodBandBasis(
  meta: BandWindow,
  opts: { scopeLabel: string | null; lane: 'usage' | 'chargeback'; inProgress: boolean },
): string {
  const lane = opts.lane === 'chargeback' ? 'chargeback · billed' : 'attributed usage'
  const span = meta.range ? 'the selected range' : opts.inProgress ? 'month to date' : 'full month'
  return [lane, opts.scopeLabel, span].filter(Boolean).join(' · ')
}

/**
 * The ROLLING band's caveat — "does not sum into July" — or `null` when there is
 * no honest sentence to write.
 *
 * `sameWindow` IS THE RENDERED COMPARISON, and it is an argument rather than
 * something derived from `meta` here, because the only thing that matters is
 * whether the two band HEADERS say the same thing. In custom-range mode the same
 * `from`/`to` drives both bands, and a caller that supplies no rolling label at
 * all falls back to the period's own — both cases put one window under two
 * headers, and "does not sum into July" over them would be false in the most
 * damaging direction: telling a reader two identical windows cannot be compared.
 *
 * The month is named BARE ("July"), not "July 2026": the sentence is about the
 * band directly above, whose header already carries the year.
 */
export function rollingBandNote(meta: BandWindow, sameWindow: boolean): string | null {
  if (sameWindow || meta.range) return 'same window as the band above'
  const label = monthLabel(meta.month)
  const bare = label.split(' ')[0]
  // `monthLabel` returns its input unchanged for an unparseable month, and a
  // note reading "does not sum into 2026-13" is worse than no note at all.
  return bare && bare !== meta.month ? `does not sum into ${bare}` : null
}
