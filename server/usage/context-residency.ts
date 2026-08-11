/*
 * context-residency — the banded context-window read behind the /usage
 * residency card (developer-pages-consolidation/01-build-design.md W0a, D5).
 *
 * WHAT IT ANSWERS. "Where does my money sit against the context window?" —
 * the restart-the-session lever, priced. Σ `cost_usd` of the caller's
 * `provider_usage_fact` COST rows for the window, grouped by the
 * provider-reported `context_window` band (mig 0127). NO DERIVATION ANYWHERE —
 * the provider reports the dimension itself; this module only sums it.
 *
 * THE REMAINDER IS REASON-TYPED, NEVER FOLDED. Rows whose capture predates
 * collection carry `context_window IS NULL` and can never heal (raw stores
 * only what `group_by` asked — W0a D4), so they render as their own remainder
 * ("not banded — before collection began"), the same way `ModelSplitPanel`
 * types its remainders (07-model-axis D6 idiom). The remainder shrinks day by
 * day as the trailing poll window rolls; the card never pretends the un-banded
 * past is standard-band.
 *
 * ANTHROPIC ROWS ONLY, by construction, and the filter is what keeps the
 * remainder's reason TRUE: the context window is a dimension of the Anthropic
 * wire. A GitHub row's `context_window` is NULL because Copilot has no such
 * dimension to collect — filing its day-grain credits under "before collection
 * began" would assert a history that never existed. The GitHub arm is a
 * different card with its own vocabulary (W2 D22); no fake symmetry.
 *
 * ACCESS PATH: the partial `provider_usage_fact_teammate_date_tool_idx`
 * `(teammate_id, date, tool) WHERE teammate_id IS NOT NULL` (mig 0121) — the
 * same by-key read the provider-day drawer uses, leading on the two columns
 * this query filters.
 *
 * Deployed inert (W0a): no endpoint consumes this until W2 mounts the card.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import {
  CONTEXT_UNBANDED_REASON_LABELS,
  compareContextBands,
  type ContextUnbandedReason,
} from '../../shared/reports/context-window'

type AnyDb = PostgresJsDatabase<Record<string, unknown>>

/** One banded segment — the band string is the provider's own, verbatim. */
export interface ContextResidencySegment {
  band: string
  costUsd: number
}

/** The un-banded remainder, typed with WHY (07-D6 idiom) — never a band. */
export interface ContextResidencyRemainder {
  costUsd: number
  reason: ContextUnbandedReason
  /** The card-footer wording for {@link reason}. */
  label: string
}

export interface ContextResidency {
  /** Inclusive day bounds (`YYYY-MM-DD`) the figures were computed over. */
  window: { from: string; to: string }
  /** Banded segments in {@link compareContextBands} order — observed bands
   *  only; there is no fixed vocabulary to zero-fill. */
  segments: ContextResidencySegment[]
  /** `null` when every in-window dollar is banded — the healed steady state. */
  remainder: ContextResidencyRemainder | null
  /** Σ segments + remainder — the caller's Anthropic cost-row total for the
   *  window. The card's honesty invariant: the pieces always foot to this. */
  totalUsd: number
}

/**
 * The caller's context-window residency for an inclusive day window.
 *
 * Cost rows only (`cost_type IS NOT NULL`): the measure-exclusivity CHECK
 * (0118) puts money on cost rows and tokens on token rows, and this card
 * prices the lever — a token row entering here would mint zero-dollar
 * segments for bands the money never touched.
 */
export async function contextWindowResidency(
  db: AnyDb,
  teammateId: string,
  window: { from: string; to: string },
): Promise<ContextResidency> {
  const rows = await db.execute<{ context_window: string | null; cost_usd: string }>(sql`
    SELECT context_window,
           COALESCE(SUM(cost_usd), 0)::text AS cost_usd
      FROM provider_usage_fact
     WHERE teammate_id = ${teammateId}::uuid
       AND date >= ${window.from}::date
       AND date <= ${window.to}::date
       AND provider = 'anthropic'
       AND cost_type IS NOT NULL
     GROUP BY context_window`)

  const segments: ContextResidencySegment[] = []
  let unbandedUsd = 0
  for (const r of rows) {
    const usd = Number(r.cost_usd)
    if (r.context_window === null) unbandedUsd += usd
    else segments.push({ band: r.context_window, costUsd: usd })
  }
  segments.sort((a, b) => compareContextBands(a.band, b.band))

  const remainder: ContextResidencyRemainder | null =
    unbandedUsd > 0
      ? {
          costUsd: unbandedUsd,
          reason: 'before-collection',
          label: CONTEXT_UNBANDED_REASON_LABELS['before-collection'],
        }
      : null

  return {
    window,
    segments,
    remainder,
    totalUsd: segments.reduce((a, s) => a + s.costUsd, 0) + unbandedUsd,
  }
}
