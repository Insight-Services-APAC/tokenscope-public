/*
 * Freshness tiers — THE one place the §A6.1 age thresholds live. These
 * thresholds feed the UiFreshness dot; the SHARED STALL SIGNAL (§A6.2/§A6.3,
 * the one the banner and the ops-alert worker both evaluate) is
 * server/usage/attribution-stall.ts, not this module.
 *
 * Constraint (§A6.1): an ABSENT age is 'unknown' and must render neutral —
 * never green. A fabricated default here is how a dead read path kept showing
 * a reassuring green dot through a 28-hour outage.
 */

export type FreshnessTier = 'fresh' | 'aging' | 'stale' | 'unknown'

/** Inclusive upper bound of the green tier (§A6.1: green ≤ 60 min). */
export const FRESHNESS_FRESH_MAX_MINUTES = 60

/** Inclusive upper bound of the amber tier (§A6.1: amber ≤ 6 h); red beyond. */
export const FRESHNESS_AGING_MAX_MINUTES = 360

/**
 * Negative-age skew tolerance: a just-written row plus clock skew can measure
 * a few minutes in the future and is still a real measurement; anything more
 * negative is a MALFORMED (future) timestamp and must classify 'unknown' —
 * never a reassuring green (§A6.1).
 */
export const FRESHNESS_NEGATIVE_SKEW_TOLERANCE_MINUTES = 5

/**
 * Classify an age in minutes. null / undefined / NaN (any non-finite number —
 * an Infinity is a computation artefact, not a measurement) = 'unknown'.
 * Negative ages within the skew tolerance classify 'fresh'; below it they are
 * malformed future timestamps and classify 'unknown'.
 */
export function freshnessTier(minutes: number | null | undefined): FreshnessTier {
  if (minutes == null || !Number.isFinite(minutes)) return 'unknown'
  if (minutes < -FRESHNESS_NEGATIVE_SKEW_TOLERANCE_MINUTES) return 'unknown'
  if (minutes <= FRESHNESS_FRESH_MAX_MINUTES) return 'fresh'
  if (minutes <= FRESHNESS_AGING_MAX_MINUTES) return 'aging'
  return 'stale'
}
