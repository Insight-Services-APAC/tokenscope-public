/*
 * resolveTimeoutMs — the env parse in front of the cron trigger's abort timer.
 *
 * `setTimeout(fn, NaN)` fires on the next tick. So a bare `Number(env)` on a
 * malformed CRON_TRIGGER_TIMEOUT_MS would abort the fetch instantly and report a
 * FAILED execution for a worker that never got to run -- recreating the exact
 * false-failure this change removes, from a typo in the bicep.
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveTimeoutMs } from '../../../scripts/lib/dispatch-timeout.mjs'

const FALLBACK = 200_000

describe('resolveTimeoutMs', () => {
  it('uses a valid numeric override', () => {
    expect(resolveTimeoutMs('90000', FALLBACK, () => {})).toBe(90_000)
  })

  it('falls back when the value is absent', () => {
    expect(resolveTimeoutMs(undefined, FALLBACK, () => {})).toBe(FALLBACK)
    expect(resolveTimeoutMs('', FALLBACK, () => {})).toBe(FALLBACK)
  })

  it.each([
    ['non-numeric', '200s'],
    ['words', 'default'],
    ['zero', '0'],
    ['negative', '-1'],
    ['whitespace', '   '],
  ])('rejects a %s value rather than letting it reach setTimeout', (_label, raw) => {
    const warn = vi.fn()
    expect(resolveTimeoutMs(raw, FALLBACK, warn)).toBe(FALLBACK)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('warns loudly when it rejects, naming the offending value', () => {
    // A silently-ignored override is how a deliberate config change goes missing.
    const warn = vi.fn()
    resolveTimeoutMs('oops', FALLBACK, warn)
    expect(warn.mock.calls[0]![0]).toContain('oops')
    expect(warn.mock.calls[0]![0]).toContain(String(FALLBACK))
  })

  it('does not warn on the ordinary paths', () => {
    const warn = vi.fn()
    resolveTimeoutMs('90000', FALLBACK, warn)
    resolveTimeoutMs(undefined, FALLBACK, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('never returns a value setTimeout would treat as immediate', () => {
    for (const raw of [undefined, '', '   ', 'x', '0', '-5', 'NaN', 'Infinity']) {
      const ms = resolveTimeoutMs(raw, FALLBACK, () => {})
      expect(Number.isFinite(ms)).toBe(true)
      expect(ms).toBeGreaterThan(0)
    }
  })
})
