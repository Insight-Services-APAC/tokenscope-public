/*
 * money — one USD formatter, because two of them disagreed.
 *
 * The placement dialog rendered a positive sub-cent amount as `< $0.01` so that
 * a real, moving figure never reads as nothing. The receipt that reports the
 * SAME amount a moment later formatted it independently and showed `$0.00` —
 * the operator approved "< $0.01 will move" and was told "$0.00 moved".
 *
 * Anything that shows an amount the operator is asked to act on uses this.
 */
export function formatUsd(n: number): string {
  /*
   * A positive amount below a cent is `< $0.01`, never `$0.00`. Rounding a
   * figure that IS moving down to a zero-looking one tells somebody nothing
   * will happen while records are re-homed.
   */
  if (n > 0 && n < 0.005) return '< $0.01'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
}
