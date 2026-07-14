// @vitest-environment node
/*
 * Allocation write validation (API-6) + tstzrange parsing (FE-1 server half).
 *
 * The regression class: garbage tstzrange bounds passed the old
 * /^\[[^,]+,[^)]+\)$/ regex and surfaced as PG 22007 → 500; budget_usd had
 * no magnitude bound vs NUMERIC(14,2) → 22003 → 500. These schemas must
 * reject both shapes BEFORE Postgres.
 */
import { describe, it, expect } from 'vitest'
import {
  BudgetUsdSchema,
  EffectiveRangeSchema,
  parseTstzrangeText,
} from '../../../server/utils/allocation-validation'

describe('BudgetUsdSchema', () => {
  it('accepts plain and 2-decimal amounts', () => {
    expect(BudgetUsdSchema.safeParse('10000').success).toBe(true)
    expect(BudgetUsdSchema.safeParse('10000.50').success).toBe(true)
    expect(BudgetUsdSchema.safeParse('0.01').success).toBe(true)
  })

  it('rejects more than NUMERIC(14,2) magnitude (12 integer digits)', () => {
    expect(BudgetUsdSchema.safeParse('9999999999999').success).toBe(false) // 13 digits
    expect(BudgetUsdSchema.safeParse('999999999999').success).toBe(true) // 12 digits
  })

  it('rejects negatives, 3 decimals, and non-numeric strings', () => {
    expect(BudgetUsdSchema.safeParse('-5').success).toBe(false)
    expect(BudgetUsdSchema.safeParse('5.001').success).toBe(false)
    expect(BudgetUsdSchema.safeParse('1e9').success).toBe(false)
  })
})

describe('EffectiveRangeSchema', () => {
  it('accepts a well-formed [from,to) range', () => {
    expect(
      EffectiveRangeSchema.safeParse('[2026-05-01T00:00:00Z,2026-06-01T00:00:00Z)').success,
    ).toBe(true)
    expect(
      EffectiveRangeSchema.safeParse('[2026-05-01 00:00:00+00,2026-06-01 00:00:00+00)').success,
    ).toBe(true)
    // REGRESSION (sandbox budget-create failure): the UI builds the bound as
    // `${date}T00:00:00+00` — V8's STRICT ISO parser rejects the bare `+00`
    // on the `T` form (it accepts only `+00:00`), even though PG stores it
    // fine. parseBound must normalise it so the validator isn't stricter than
    // the DB. This exact string round-trips through the live `/allocations`
    // POST and was surfacing as "Validation Error" on the budget step.
    expect(
      EffectiveRangeSchema.safeParse('[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)').success,
    ).toBe(true)
    // Date-only bounds (no time) must NOT be corrupted by the offset normaliser.
    expect(EffectiveRangeSchema.safeParse('[2026-05-01,2026-06-01)').success).toBe(true)
  })

  it('rejects garbage bounds that the old regex let through (PG 22007 → 500)', () => {
    expect(EffectiveRangeSchema.safeParse('[banana,cherry)').success).toBe(false)
    expect(EffectiveRangeSchema.safeParse('[2026-99-99,2026-06-01)').success).toBe(false)
  })

  it('rejects lower >= upper', () => {
    expect(
      EffectiveRangeSchema.safeParse('[2026-06-01T00:00:00Z,2026-05-01T00:00:00Z)').success,
    ).toBe(false)
    expect(
      EffectiveRangeSchema.safeParse('[2026-05-01T00:00:00Z,2026-05-01T00:00:00Z)').success,
    ).toBe(false)
  })

  it('rejects non-range shapes', () => {
    expect(EffectiveRangeSchema.safeParse('2026-05-01').success).toBe(false)
    expect(EffectiveRangeSchema.safeParse('(2026-05-01,2026-06-01)').success).toBe(false)
    expect(EffectiveRangeSchema.safeParse('').success).toBe(false)
  })
})

describe('parseTstzrangeText', () => {
  it('parses PG quoted-bound output into ISO-8601 bounds', () => {
    const parsed = parseTstzrangeText('["2026-05-01 00:00:00+00","2026-06-01 00:00:00+00")')
    expect(parsed.from).toBe('2026-05-01T00:00:00.000Z')
    expect(parsed.to).toBe('2026-06-01T00:00:00.000Z')
  })

  it('parses unquoted bounds too', () => {
    const parsed = parseTstzrangeText('[2026-05-01T00:00:00Z,2026-06-01T00:00:00Z)')
    expect(parsed.from).toBe('2026-05-01T00:00:00.000Z')
    expect(parsed.to).toBe('2026-06-01T00:00:00.000Z')
  })

  it('returns null for unbounded sides (the [x,) case that broke the old client regex)', () => {
    const parsed = parseTstzrangeText('["2026-05-01 00:00:00+00",)')
    expect(parsed.from).toBe('2026-05-01T00:00:00.000Z')
    expect(parsed.to).toBeNull()
  })

  it('returns nulls for null/empty/unparseable input instead of throwing', () => {
    expect(parseTstzrangeText(null)).toEqual({ from: null, to: null })
    expect(parseTstzrangeText('')).toEqual({ from: null, to: null })
    expect(parseTstzrangeText('empty')).toEqual({ from: null, to: null })
    expect(parseTstzrangeText('[garbage,more)')).toEqual({ from: null, to: null })
  })
})
