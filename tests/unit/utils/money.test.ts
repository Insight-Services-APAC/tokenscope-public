// @vitest-environment node
/*
 * formatUsd — one formatter, because two of them disagreed about the same
 * amount seconds apart.
 *
 * The placement dialog said "< $0.01 will move"; the receipt reporting that very
 * move formatted the figure independently and said "$0.00". An operator was
 * asked to approve something and then told nothing had happened.
 */
import { describe, it, expect } from 'vitest'
import { formatUsd } from '../../../app/utils/money'

describe('formatUsd', () => {
  it('never renders a POSITIVE amount as $0.00', () => {
    // The whole reason this helper exists: rounding a figure that IS moving
    // down to a zero-looking one is a lie the operator acts on.
    expect(formatUsd(0.004)).toBe('< $0.01')
    expect(formatUsd(0.0001)).toBe('< $0.01')
  })

  it('renders a genuine zero as $0.00', () => {
    // "Nothing moved" is a real, reportable answer and must not be dressed up.
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('rounds to cents above the threshold', () => {
    expect(formatUsd(0.005)).toBe('$0.01')
    expect(formatUsd(15037.53)).toBe('$15,037.53')
  })

  it('handles a negative amount without the sub-cent rule', () => {
    // A delta can be negative; only POSITIVE sub-cent values get the guard, or
    // "-$0.001" would read as "< $0.01" and flip its sign.
    expect(formatUsd(-12.5)).toBe('-$12.50')
  })
})
