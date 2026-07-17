/*
 * allocate-cents — largest-remainder allocation of a rounded money total over
 * its parts, so displayed figures ALWAYS sum exactly (#142 review finding 3).
 *
 * Rounding each lane independently with toFixed(2) breaks the conservation
 * claim finance surfaces make ("Σ lanes == the CoU total"): 3.334 + 3.334 +
 * 3.332 rounds to 3.33×3 = 9.99 while the total rounds to 10.00. This helper
 * fixes the display layer: round the TOTAL once, floor every part to cents,
 * then hand the leftover cents to the parts with the largest fractional
 * remainders. Σ(result) == round(total) by construction. Conservation on the
 * raw (unrounded) values is the caller's invariant; this makes the rounded
 * projection honour it too.
 *
 * Pure TS, no imports — usable from server rollups, CSV writers, and UI alike.
 */

/**
 * Allocate `total` (USD float; defaults to the exact sum of `parts`) across
 * `parts` (USD floats, same order) as 2-dp cent-exact values.
 * Returns the per-part values in USD as numbers with ≤2 decimals such that
 * their sum equals `total` rounded to cents. Non-finite parts are treated as 0.
 */
export function allocateCents(parts: readonly number[], total?: number): number[] {
  const clean = parts.map((p) => (Number.isFinite(p) ? p : 0))
  const rawTotal = total !== undefined && Number.isFinite(total) ? total : clean.reduce((a, b) => a + b, 0)
  const totalCents = Math.round(rawTotal * 100)
  const exact = clean.map((p) => p * 100)
  const floored = exact.map((c) => Math.floor(c + 1e-9)) // epsilon: 3.10*100 = 309.999... must floor to 310
  let leftover = totalCents - floored.reduce((a, b) => a + b, 0)
  // Hand leftover cents (usually 0..parts.length, possibly negative when the
  // total rounds below the floors' sum) to the largest/smallest remainders.
  const order = exact
    .map((c, i) => ({ i, rem: c - floored[i]! }))
    .sort((a, b) => (leftover >= 0 ? b.rem - a.rem : a.rem - b.rem))
  const cents = [...floored]
  const step = leftover >= 0 ? 1 : -1
  for (let k = 0; leftover !== 0 && order.length > 0; k = (k + 1) % order.length) {
    const idx = order[k]!.i
    cents[idx] = cents[idx]! + step
    leftover -= step
  }
  return cents.map((c) => c / 100)
}

/** allocateCents, but returning 2-dp strings (the wire shape finance uses). */
export function allocateCentsFixed(parts: readonly number[], total?: number): string[] {
  return allocateCents(parts, total).map((v) => v.toFixed(2))
}
