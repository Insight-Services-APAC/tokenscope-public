// @vitest-environment node
/*
 * #599: a UTC day is a provider fact, so it reads the same in every browser zone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fmtUtcDay } from '../../../app/composables/useFormat'

const original = process.env.TZ
afterEach(() => {
  process.env.TZ = original
})

describe('fmtUtcDay', () => {
  it('writes the short form and the year form', () => {
    expect(fmtUtcDay('2026-10-26')).toBe('26 Oct')
    expect(fmtUtcDay('2026-10-26', { year: true })).toBe('26 Oct 2026')
  })

  it.each(['Pacific/Honolulu', 'Pacific/Noumea'])('prints the same date in %s', (zone) => {
    process.env.TZ = zone
    expect(fmtUtcDay('2026-10-26')).toBe('26 Oct')
    expect(fmtUtcDay('2026-11-01T00:00:00Z')).toBe('1 Nov')
  })

  it('leaves anything that is not a day alone', () => {
    expect(fmtUtcDay('W27')).toBe('W27')
    expect(fmtUtcDay(null)).toBe('—')
  })
})
