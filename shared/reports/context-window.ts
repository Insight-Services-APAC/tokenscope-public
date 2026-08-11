/*
 * reports/context-window — the context-window band vocabulary's SHARED half:
 * the un-banded remainder's reason typing and the band ordering
 * (developer-pages-consolidation/01-build-design.md W0a, D5/D6).
 *
 * THE BANDS THEMSELVES ARE NOT ENUMERATED HERE, deliberately. The band strings
 * ('0-200k' / '200k+' today) are the PROVIDER'S vocabulary to extend — the
 * fact column carries them verbatim (mig 0127, no CHECK on values) and every
 * read surface renders whatever arrived. Only the two things the provider does
 * NOT own live here: why a row can be un-banded, and how observed bands sort.
 *
 * Pure types + const maps, no runtime deps — safe on both sides of the wire
 * (`#shared/reports/context-window`), the tier-exposure module's own pattern.
 */

/**
 * Why a fact row's money is not in any band. ONE reason today; a reason TYPE
 * rather than a bare string so the remainder renders like `ModelSplitPanel`'s
 * reason-typed remainders (07-model-axis D6 idiom) and a second cause can be
 * added without re-teaching every consumer.
 *
 * `before-collection`: the capture predates `context_window` joining the
 * poller's `group_by` — raw stores only what was asked, so history older than
 * the trailing poll window can never heal (W0a D4). The remainder therefore
 * SHRINKS day by day as the window rolls, and a card must never pretend the
 * un-banded past is standard-band.
 */
export const CONTEXT_UNBANDED_REASONS = ['before-collection'] as const
export type ContextUnbandedReason = (typeof CONTEXT_UNBANDED_REASONS)[number]

/** The remainder's rendered wording, per reason — the card-footer sentence. */
export const CONTEXT_UNBANDED_REASON_LABELS: Record<ContextUnbandedReason, string> = {
  'before-collection': 'not banded — before collection began',
}

/**
 * Stable render order for observed band strings: by the leading number when
 * both carry one ('0-200k' before '200k+', and a future '1m+' after both),
 * lexicographic otherwise. Never filters — an unrecognised band sorts, it is
 * not dropped.
 */
export function compareContextBands(a: string, b: string): number {
  const lead = (s: string): number => {
    // A k/m unit ON THE LEADING NUMBER scales it, so a future '1m+' sorts
    // after '200k+' rather than between the two current bands.
    const m = /^(\d+(?:\.\d+)?)\s*([km])?/i.exec(s.trim())
    if (!m) return Number.NaN
    const unit = m[2]?.toLowerCase()
    return Number(m[1]) * (unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1)
  }
  const la = lead(a)
  const lb = lead(b)
  if (Number.isFinite(la) && Number.isFinite(lb) && la !== lb) return la - lb
  return a < b ? -1 : a > b ? 1 : 0
}
