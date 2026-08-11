/*
 * reports/tier-exposure — the BEHAVIOURAL EXPOSURE vocabulary and wire contract
 * (docs/design/reporting-consolidation/04-prototype-delta.md §5
 * `fetchTierExposure`).
 *
 * WHAT THE CARD IS FOR. Billed spend against consumption, banded by the CHOICE a
 * developer or a policy can change — not by product, not by surface. A spend
 * share on its own overstates how much a thing is actually used, because every
 * band here bills at a different rate; showing money over volume in the same
 * bands makes the premium visible instead of leaving the reader to guess whether
 * "63% of spend" is a lot of work or a dear one.
 *
 * THE ONE PRINCIPLE: the band vocabulary lives HERE and nowhere else, and it is
 * derived from `model_catalog.tier` — the authority the frontier-share detector
 * already consumes (`server/usage/insights.ts` `resolveTier`, seeded by
 * `drizzle/migrations/0046_consumption_foundations.sql:128-146`). One authority
 * means this card and that detector can never publish two different
 * frontier shares. Inventing a second banding beside the catalog was considered
 * and rejected for exactly that reason (04-prototype-delta.md §5).
 *
 * Pure types + const maps, no runtime deps — safe on both sides of the wire
 * (`#shared/reports/tier-exposure`).
 */
import type { ContextUnbandedReason } from './context-window'

// ── Bands ────────────────────────────────────────────────────────────────────

/**
 * The card's bands, in canonical render order.
 *
 * `unclassified` and `no-model` are SHOWN, never folded into `economy`. That is
 * the migration's own rule for the catalog — *"unmatched models are UNCLASSIFIED
 * — detectors guard on classified_ratio, so unknown models can never fabricate a
 * finding"* (0046:136-138) — applied to a card instead of a detector. Defaulting
 * an unknown model into the cheap band would state a policy conclusion ("this
 * work runs cheap") that nothing in the data supports.
 */
export const TIER_BANDS = [
  'frontier',
  'mid',
  'economy',
  'specialised',
  'unclassified',
  'no-model',
] as const
export type TierBand = (typeof TIER_BANDS)[number]

/**
 * `unclassified` and `no-model` are DIFFERENT facts and are deliberately not one
 * bucket: `unclassified` is a model string the catalog does not recognise (an
 * entry somebody can add), `no-model` is a record that carries no model at all
 * (a lane that does not report one — the residual and ingest-only arms). Merging
 * them would tell an operator to go add a catalog entry for a row that will
 * never carry a model name.
 */
export const TIER_BAND_LABELS: Record<TierBand, string> = {
  frontier: 'Frontier',
  mid: 'Mid',
  economy: 'Economy',
  specialised: 'Specialised',
  unclassified: 'Unclassified',
  'no-model': 'No model on the record',
}

/** The `model_catalog.tier` domain (0046 CHECK constraint) — the banding input. */
export type ModelCatalogTier = 'frontier' | 'workhorse' | 'lightweight' | 'specialised'

/**
 * `model_catalog.tier` → card band. The ONLY place the mapping is written.
 *
 * Cost-ordered as well as capability-ordered, which is why the catalog needs no
 * replacement: the seed sorts fable(10) and opus(20) above sonnet(30) above
 * haiku(40), and Fable 5 is the most expensive model in the estate — the reason
 * it sorts first. An earlier draft proposed re-banding on observed
 * `cost ÷ tokens` on the theory that a capability tier is not a cost tier; it
 * was wrong on the facts and would have produced two frontier shares that drift.
 *
 * @param model the record's model string; `null`/empty ⇒ `no-model`
 * @param tier  `resolveTier(model, catalog)`; `null` (no catalog match) ⇒
 *              `unclassified`
 */
export function bandForModel(
  model: string | null | undefined,
  tier: ModelCatalogTier | null | undefined,
): TierBand {
  if (!model) return 'no-model'
  switch (tier) {
    case 'frontier':
      return 'frontier'
    case 'workhorse':
      return 'mid'
    case 'lightweight':
      return 'economy'
    case 'specialised':
      return 'specialised'
    default:
      return 'unclassified'
  }
}

// ── Wire contract ────────────────────────────────────────────────────────────

/**
 * What a provider's consumption is COUNTED IN. The two providers do not meter
 * the same thing, so the unit rides the arm rather than being assumed by the
 * card (settled by the wire capture of 2026-08-02, not inferred):
 *   - `tokens`       — Anthropic: `input_tokens + output_tokens` per model.
 *   - `interactions` — Copilot: `user_initiated_interaction_count`, the closest
 *     thing it has to "how much work ran on this model". Its language-model rows
 *     carry activity counts and LOC sums, never credits.
 */
export type ExposureUnit = 'tokens' | 'interactions'

/**
 * What a provider gives at MODEL grain, which is what decides the card's shape:
 *   - `cost-and-tokens` — money AND volume per model (Anthropic: `data[].model`
 *     on both reports, 100%, with `amount` per (model, cost_type)).
 *   - `mix-only` — a model dimension but NO money on it. Copilot's
 *     `ai_credits_used` sits at the RECORD ROOT, day grain. Its bands therefore
 *     carry activity mix and NEVER money; the credits are reported separately,
 *     unbanded. Splitting a day's credits across models by activity share would
 *     be a ratio, and this design does not do ratios anywhere.
 */
export type ExposureKind = 'cost-and-tokens' | 'mix-only'

/**
 * Whether the arm has anything to say.
 *   - `ok` — this provider has reached the normalised layer. Its figures may
 *     still be zero for THIS scope and window; that is a genuine zero.
 *   - `no-data-yet` — the provider has never written a row to
 *     `provider_usage_fact` at all (its adapter is unwritten — #49 / Track E).
 *     STRUCTURALLY different from a zero, and the card must render it
 *     differently: a zero says "nobody spent"; this says "we are not looking
 *     yet". A card reading the normalised layer is never BLOCKED on an adapter —
 *     it reports what has arrived and gains the rest when the arm lands.
 */
export type ExposureAvailability = 'ok' | 'no-data-yet'

/** One band's figures over the whole period, for one provider. */
export interface TierExposureBand {
  band: TierBand
  /**
   * Σ banded `cost_usd` in this band over the period. ALWAYS 0 on a `mix-only`
   * arm — that provider's money is day-grain and lives in
   * {@link TierExposureArm.unbandedSpendUsd}.
   */
  spendUsd: number
  /**
   * Σ the arm's consumption measure ({@link TierExposureArm.unit}).
   *
   * `null` means NOT COUNTED — the lane carried no consumption row for this
   * band — and is deliberately not `0`. A band with spend and no volume count
   * (the residual and ingest-only arms carry money with no tokens) must say so;
   * substituting 0 would put it in the volume bar at zero width and imply the
   * work was free of tokens rather than uncounted.
   */
  consumption: number | null
  /**
   * `spendUsd ÷ ` {@link TierExposureArm.bandedSpendUsd}, a FRACTION in [0,1]
   * (the codebase `pct()` convention — do NOT pre-multiply by 100). `null` when
   * the arm bands no money at all (every `mix-only` arm, and any arm whose
   * banded total is 0) — never a 0/0 rendered as 0%.
   */
  spendSharePct: number | null
  /**
   * `consumption ÷ ` {@link TierExposureArm.totalConsumption}, a FRACTION in
   * [0,1]. `null` whenever {@link consumption} is `null` — the band is ABSENT
   * from the volume bar rather than re-based into it.
   */
  consumptionSharePct: number | null
}

/** One `(day, band)` cell of the trend the card draws under the bars. */
export interface TierExposureCell {
  /** `YYYY-MM-DD` (UTC day, `provider_usage_fact.date`). */
  day: string
  band: TierBand
  /** Σ banded `cost_usd` for that (day, band). Always 0 on a `mix-only` arm. */
  spendUsd: number
  /** Σ the arm's consumption measure for that (day, band); `null` = not counted. */
  consumption: number | null
}

/**
 * One provider's exposure. The response is discriminated by provider BECAUSE
 * THEY DO NOT METER THE SAME THING — a single shape would have to invent one of
 * Copilot's missing measures to fill it.
 */
export interface TierExposureArm {
  /** `provider_usage_fact.provider` — `'anthropic'` | `'github'`. */
  provider: string
  kind: ExposureKind
  availability: ExposureAvailability
  unit: ExposureUnit
  /**
   * Σ money the bands carry — the lane total the bands sum back to
   * (`Σ bands[].spendUsd === bandedSpendUsd`, the card's headline invariant).
   * 0 on a `mix-only` arm.
   */
  bandedSpendUsd: number
  /**
   * Money this provider meters but CANNOT band, carried so the arm's total is
   * still honest. Copilot's `ai_credits_used` (day grain, record root) is the
   * whole of it. NEVER apportioned across bands.
   */
  unbandedSpendUsd: number
  /** Why {@link unbandedSpendUsd} cannot be banded; `null` when it is 0. */
  unbandedNote: string | null
  /**
   * Σ {@link TierExposureBand.consumption} over the bands that HAVE one — the
   * denominator `consumptionSharePct` is taken over, and NOT the same population
   * as `bandedSpendUsd`. `null` when no band carried a consumption count.
   */
  totalConsumption: number | null
  /**
   * Σ `spendUsd` of the bands that carry a consumption count. The card states
   * this beside the volume bar: it is how much of the money the volume bar
   * actually covers, so "63% of spend against 13% of tokens" cannot be read as
   * spanning money it does not.
   */
  consumptionCoveredSpendUsd: number
  /** Every band in {@link TIER_BANDS} order — zero bands included, so the bar's
   *  segments are stable across windows. */
  bands: TierExposureBand[]
  /** The day-grain trend. Cells with neither spend nor a consumption count are
   *  omitted (a gap in the line, never a claimed zero). */
  series: TierExposureCell[]
  /**
   * The context-window exposure (W0a D6) — real data from
   * `provider_usage_fact.context_window`, same window and scope as the tier
   * bands (one scan feeds both, so the two chips cannot disagree). `null` on a
   * `mix-only` arm: that provider's wire carries no such dimension.
   */
  contextWindow: ContextWindowExposure | null
}

/*
 * THE UNCOLLECTED-EXPOSURE CONSTANT IS GONE (W0a, D6). It hardcoded
 * 'context-window' as a ghosted chip with the note "if a group_by request
 * lands them, this constant goes and the exposure becomes real data" — the
 * request landed (mig 0127 + analytics-poller group_by), so the context-tier
 * exposure now reads `provider_usage_fact.context_window` and rides the
 * payload as {@link ContextWindowExposure}. `speed` is deliberately NOT taken
 * (no card needs it; target-state T4 not-taken row) — taking it later follows
 * the context_window shape verbatim, and it earns a payload leg then, not a
 * resurrected ghost constant.
 */

/** One observed context-window band's figures over the period, for one
 *  provider. The band string is the PROVIDER'S, verbatim — never an enum. */
export interface ContextWindowExposureBand {
  band: string
  /** Σ `cost_usd` of this band's cost rows over the period. */
  spendUsd: number
  /**
   * `spendUsd ÷ ` {@link ContextWindowExposure.bandedSpendUsd}, a FRACTION in
   * [0,1] (the `pct()` convention). `null` when no money is banded at all.
   */
  spendSharePct: number | null
  /** Σ `input + output` tokens of this band's token rows; `null` = NOT COUNTED
   *  (no token row carried the band) — never substituted with 0. */
  tokens: number | null
  /** `tokens ÷ Σ counted band tokens`, [0,1]; `null` when {@link tokens} is. */
  tokensSharePct: number | null
}

/**
 * One provider's context-window exposure — the real data behind the card's
 * "Context tier" chip (W0a D6). Present only on arms whose wire CARRIES the
 * dimension (`kind === 'cost-and-tokens'`); `null` on a `mix-only` arm, which
 * is a different fact from "everything un-banded": Copilot has no
 * context-window dimension to collect, while an Anthropic day before
 * collection began HAS one that was not asked for.
 */
export interface ContextWindowExposure {
  /** Observed bands in {@link compareContextBands} order — only bands with a
   *  row in the window (there is no fixed vocabulary to zero-fill). */
  bands: ContextWindowExposureBand[]
  /** Σ money the bands carry — the share denominator. */
  bandedSpendUsd: number
  /**
   * Money whose capture predates collection (`context_window IS NULL` cost
   * rows) — the reason-typed remainder. It shrinks as the trailing poll window
   * rolls and is NEVER folded into a band: the un-banded past is not
   * standard-band.
   */
  unbandedSpendUsd: number
  /** Why {@link unbandedSpendUsd} is un-banded; `null` when it is 0. Wording
   *  via `CONTEXT_UNBANDED_REASON_LABELS` (#shared/reports/context-window). */
  unbandedReason: ContextUnbandedReason | null
}

/** The whole card's payload for one scope and window. */
export interface TierExposure {
  /** Inclusive window bounds (`YYYY-MM-DD`) the figures were computed over. */
  window: { from: string; to: string }
  /** {@link TIER_BANDS} — carried so a consumer renders the canonical order
   *  without importing the vocabulary (Track C's People hero shares it). */
  bandOrder: TierBand[]
  /** One arm per provider, ALWAYS including the two known providers so a missing
   *  adapter is stated rather than absent. */
  providers: TierExposureArm[]
}

/** The rolling window both behaviour cards are drawn over. */
export const BEHAVIOUR_ROLLING_DAYS = 60
