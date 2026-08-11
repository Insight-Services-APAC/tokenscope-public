// @vitest-environment node
/*
 * The clock pin's REJECTION contract (server/utils/clock-pin.ts).
 *
 * The module promises one thing about bad input: "inside a demo-capable env a
 * malformed pin is loud". These assertions are the ways that promise used to be
 * broken — each one is a distinct escape from the shape regex, and each one had
 * a DIFFERENT wrong outcome, which is why they are pinned separately:
 *
 *   - `?clock=` (empty)          — silently ignored, so the request answered on
 *                                  the wall clock (or the cookie) under a URL
 *                                  that named an instant.
 *   - `2026-02-30T00:00:00Z`     — parsed, and NORMALISED to 2026-03-02: the
 *                                  capture is filed under a day it does not show.
 *   - `2026-13-01T00:00:00Z`     — Invalid Date, which reached `toISOString()`
 *                                  and became a RangeError (a 500) on the path
 *                                  whose contract is a 400.
 *
 * The cookie half self-heals rather than 400s (the browser is replaying a value
 * the server minted), so the same inputs must produce `clear`, never a throw and
 * never "some clock".
 */
import { describe, it, expect } from 'vitest'
import { resolveClockPin, CLOCK_PIN_OFF } from '../../../server/utils/clock-pin'

const pin = (query: string | undefined, cookie?: string) =>
  resolveClockPin({ demoCapable: true, query, cookie })

/** Shape-valid (the regex passes) but not a real instant, or not the one asked for. */
const MALFORMED = [
  '', // ?clock= — present, unhonourable
  '   ',
  'nonsense',
  '2026-08-01', // bare date: no instant
  '2026-08-01T09:00:00+02:00', // an offset would pin a day the caller did not ask for
  '2026-02-30T00:00:00Z', // normalises to 2026-03-02
  '2026-04-31T00:00:00Z',
  '2026-13-01T00:00:00Z', // Invalid Date
  '2026-00-10T00:00:00Z',
  '2026-01-32T00:00:00Z',
  '2026-01-01T25:00:00Z',
  '2026-01-01T00:60:00Z',
  '2026-01-01T23:59:60Z', // leap second: not an instant JS holds
]

describe('clock pin — rejection is TOTAL, and never a 500', () => {
  it('rejects every malformed `?clock=`, including the ones the regex lets through', () => {
    for (const q of MALFORMED) {
      const v = pin(q)
      expect(v, `?clock=${JSON.stringify(q)} must be rejected`).toMatchObject({ action: 'reject' })
    }
  })

  it('never lets an unparseable value reach the clock resolver (no RangeError, no 500)', () => {
    for (const q of MALFORMED) expect(() => pin(q)).not.toThrow()
    for (const c of MALFORMED) expect(() => pin(undefined, c)).not.toThrow()
  })

  it('an impossible date is REJECTED, not normalised into a different day', () => {
    // The proof that a shape check alone is insufficient: this input parses.
    expect(new Date('2026-02-30T00:00:00Z').toISOString()).toBe('2026-03-02T00:00:00.000Z')
    const v = pin('2026-02-30T00:00:00Z')
    expect(v.action).toBe('reject')
    expect(JSON.stringify(v)).not.toContain('2026-03-02')
  })

  it('a present-but-empty `?clock=` does NOT fall through to the cookie', () => {
    // A good cookie is on the request; the empty parameter must still lose.
    expect(pin('', '2026-08-01T09:00:00Z')).toMatchObject({ action: 'reject' })
  })

  it('a malformed COOKIE self-heals to `clear` — never obeyed, never a throw', () => {
    for (const c of MALFORMED) {
      expect(pin(undefined, c), `cookie ${JSON.stringify(c)}`).toEqual({ action: 'clear' })
    }
  })
})

describe('clock pin — the good paths still work', () => {
  it('pins a well-formed instant from the URL and sets the cookie', () => {
    expect(pin('2026-08-01T09:00:00Z')).toEqual({
      action: 'pin',
      setCookie: true,
      clock: { now: '2026-08-01T09:00:00.000Z', today: '2026-08-01', settledThrough: '2026-07-31' },
    })
    // Fractional seconds are 1-3 digits on the way in, always 3 on the way out.
    expect(pin('2026-08-01T09:00:00.5Z')).toMatchObject({
      action: 'pin',
      clock: { now: '2026-08-01T09:00:00.500Z' },
    })
  })

  it('pins from the cookie without re-setting it, and `off` clears', () => {
    expect(pin(undefined, '2026-08-01T09:00:00Z')).toMatchObject({ action: 'pin', setCookie: false })
    expect(pin(CLOCK_PIN_OFF)).toEqual({ action: 'clear' })
  })

  it('is INERT outside a demo-capable env — not a 400, which would leak the seam', () => {
    expect(resolveClockPin({ demoCapable: false, query: 'garbage', cookie: undefined })).toEqual({
      action: 'none',
    })
  })

  it('no pin at all is no pin', () => {
    expect(pin(undefined)).toEqual({ action: 'none' })
  })
})
