/*
 * build-tier-exposure — the PURE view model behind the Behavioural-exposure card.
 *
 * Separated from the component so every render state is unit-testable without a
 * Nuxt runtime, the same split `build-surface-hero.ts` and
 * `build-chargeback-trend.ts` already use.
 *
 * IT COMPUTES NO SHARE. Every percentage on this card comes from the primitive
 * (`server/reporting/engine/tier-exposure.ts`), which computed it beside the
 * figures it divides. A second computation here is how the bar and the CSV would
 * eventually disagree — the "one number, one home" defect the reporting
 * consolidation exists to remove. This module only decides what to DRAW.
 */
import { TIER_BAND_LABELS, type TierBand, type TierExposureArm } from '#shared/reports/tier-exposure'

/**
 * Band → brand CSS custom property. The tokens, never hexes: the chart kit's
 * rule is that a rebrand or a dark theme flows in by redefining the variable
 * (`useChartTheme.ts` header).
 *
 * The scale is ORDINAL, not categorical — frontier→economy is an ordering, and
 * the prototype's assignment is kept so the card and the prototype read the
 * same. The two "we do not know" bands take deliberately recessive neutrals:
 * they must be visible (they are never folded into economy) without competing
 * with the three bands a policy can actually move.
 */
export const TIER_BAND_TOKENS: Record<TierBand, string> = {
  frontier: '--brand-hunger',
  mid: '--brand-harmony',
  economy: '--brand-vision',
  specialised: '--brand-zeal',
  unclassified: '--carbon-3',
  'no-model': '--calm',
}

/**
 * Context-window bands are POSITIONAL, not a fixed vocabulary (the band
 * strings are the provider's to extend — W0a D6), so their colours cycle by
 * sorted position: the small-window band takes the calm token, the wide/
 * premium band the hot one — the same reading order the retired ghost used.
 * The remainder is not a band and always renders in the recessive neutral.
 */
export const CONTEXT_BAND_TOKEN_CYCLE = [
  '--brand-harmony',
  '--brand-hunger',
  '--brand-vision',
  '--brand-zeal',
] as const

export function contextBandToken(index: number): string {
  return CONTEXT_BAND_TOKEN_CYCLE[index % CONTEXT_BAND_TOKEN_CYCLE.length]!
}

export const CONTEXT_REMAINDER_TOKEN = '--calm'

/** One segment of a share bar. */
export interface ExposureSegment {
  band: TierBand
  label: string
  token: string
  /** Fraction in [0,1] — the width. */
  sharePct: number
}

/** One legend row under the bars. */
export interface ExposureLegendRow {
  band: TierBand
  label: string
  token: string
  spendUsd: number
  spendSharePct: number | null
  consumption: number | null
  consumptionSharePct: number | null
}

export interface ExposureBars {
  /**
   * The MONEY bar. Empty on a `mix-only` arm — that provider bands no money, and
   * an empty bar is the honest render of "there is nothing to band here".
   */
  money: ExposureSegment[]
  /**
   * The VOLUME bar, over the bands that CARRY a consumption count. Bands with
   * `consumption: null` are ABSENT from it rather than drawn at zero width, so
   * the bar is explicitly over a subset — which is why the card must state
   * {@link ExposureView.volumeCoverageNote} beside it.
   */
  volume: ExposureSegment[]
}

export interface ExposureView {
  bars: ExposureBars
  legend: ExposureLegendRow[]
  /**
   * What the volume bar actually spans, in words, when it spans less than the
   * money bar. `null` when the two cover the same money (nothing to caveat) or
   * when there is no volume bar at all.
   */
  volumeCoverageNote: string | null
}

/**
 * Turn one provider arm into what the card draws.
 *
 * @param arm the primitive's own output — shares included, never recomputed here
 */
export function buildExposureView(arm: TierExposureArm): ExposureView {
  const seg = (band: TierBand, sharePct: number): ExposureSegment => ({
    band,
    label: TIER_BAND_LABELS[band],
    token: TIER_BAND_TOKENS[band],
    sharePct,
  })

  const money: ExposureSegment[] = []
  const volume: ExposureSegment[] = []
  const legend: ExposureLegendRow[] = []

  for (const b of arm.bands) {
    // A band with no money AND no count never happened in this window; drawing
    // it would put a zero-width segment and a $0.00 legend row on screen for a
    // model nobody used.
    const present = b.spendUsd !== 0 || b.consumption !== null
    if (b.spendSharePct !== null && b.spendUsd !== 0) money.push(seg(b.band, b.spendSharePct))
    if (b.consumptionSharePct !== null) volume.push(seg(b.band, b.consumptionSharePct))
    if (present) {
      legend.push({
        band: b.band,
        label: TIER_BAND_LABELS[b.band],
        token: TIER_BAND_TOKENS[b.band],
        spendUsd: b.spendUsd,
        spendSharePct: b.spendSharePct,
        consumption: b.consumption,
        consumptionSharePct: b.consumptionSharePct,
      })
    }
  }

  /*
   * THE CAVEAT IS COMPUTED, NOT ASSUMED. The prototype states "the token bar is
   * over the model-attributed subset" unconditionally; that is only true when a
   * band actually lacks a count. Stating it when the two bars cover the same
   * money would teach the reader to discount a comparison that is in fact exact.
   *
   * ONE CLAUSE. It used to explain WHY the uncovered bands are absent rather than
   * zero-width, which is this function's own implementation. The reader needs the
   * fact that the two bars have different denominators, not the mechanism.
   */
  const uncovered = arm.bandedSpendUsd - arm.consumptionCoveredSpendUsd
  const volumeCoverageNote =
    volume.length > 0 && uncovered > 0
      ? `Volume bar covers the ${arm.unit === 'tokens' ? 'token-counted' : 'activity-counted'} subset only.`
      : null

  return { bars: { money, volume }, legend, volumeCoverageNote }
}
