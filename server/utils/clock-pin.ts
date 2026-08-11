/*
 * THE CLOCK PIN — a demo-env-only seam that lets a BROWSER pin the server clock.
 *
 * WHY THIS EXISTS (fix sprint D29). Two of the nine snags — S3's tile breakpoint
 * and S4's month-start spark — shipped to Dev because the parity gate only ever
 * shot 1600px, mid-month. The width half is a screenshot argument. The clock half
 * is not: "the hero spark is replaced by prose for the first six days of every
 * month" is only visible if the product believes it is the first six days of the
 * month, and the gate had no way to make it believe that.
 *
 * F1 built the seam server-side — `requestClock(event)` returns a pre-seeded
 * `event.context.serverClock` if one is there, which is how the unit and
 * integration tests pin an instant. This module is the HTTP path to that same
 * seam, so a headless browser can use it too:
 *
 *     GET /projects/acme?clock=2026-08-01T09:00:00Z
 *
 * The query param seeds the request AND sets a session cookie, so the client-side
 * `/api/v1/clock` fetch that lands a moment later resolves to the SAME instant.
 * Without the cookie the pin would survive exactly one request — the SSR render —
 * and the hydrated page would silently snap back to the wall clock, which is the
 * worst of the three possible outcomes.
 *
 * ── THE GATE ─────────────────────────────────────────────────────────────────
 * `demoCapable` — env ∈ {local, sandbox}, the SAME structural allowlist
 * `evaluatePersonaGate` uses (`shared/env/deploy-env.ts`). Not a feature flag,
 * not `NODE_ENV`, not a dev-mode boolean: one allowlist, decided in one place, so
 * no single env var can re-open this on a pilot-prod deployment. Outside those
 * envs the param and the cookie are both inert — not rejected, INERT, because a
 * 400 would leak that the mechanism exists.
 *
 * ── WHY A BAD VALUE IS A 400 AND NOT A SHRUG ─────────────────────────────────
 * Silently ignoring an unparseable `?clock=` would let the gate shoot a mid-month
 * page and file it as the day-1 shot. That is precisely the defect class this
 * project keeps paying for — a surface asserting something it has not measured.
 * Inside a demo-capable env a malformed pin is loud.
 *
 * "Malformed" is decided by `parseIsoUtcInstant` below, and PRESENCE is what
 * arms it: `?clock=` (empty) or `?clock=%20` is a pin the caller asked for and
 * the server could not honour, so it is a 400 — not a shrug that falls through
 * to the cookie and answers with some other instant entirely.
 */
import { resolveServerClock, type ServerClock } from '../../shared/reports/clock'

/** The cookie the pin rides between the SSR render and the client's clock fetch. */
export const CLOCK_PIN_COOKIE = 'ts_clock_pin'

/** The query parameter, and the literal that clears the pin. */
export const CLOCK_PIN_PARAM = 'clock'
export const CLOCK_PIN_OFF = 'off'

/**
 * A full ISO-8601 UTC instant, and only that. No offsets (`+02:00`), no bare
 * dates: `resolveServerClock` slices `today` off the ISO string, so anything
 * whose serialisation is not already UTC would pin a day the caller did not ask
 * for. One spelling, no coercion.
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/**
 * The ONE parse. Returns the instant, or null — and null is the only failure,
 * so no caller can hand `resolveServerClock` something that is not a date.
 *
 * The regex is a SHAPE test and is not sufficient on its own; two whole classes
 * get through it, and both used to reach production behaviour:
 *
 *   1. NON-EXISTENT instants (`2026-13-01T…Z`, `…T25:00:00Z`, `…T23:59:60Z`).
 *      `new Date` yields Invalid Date, and `resolveServerClock` then throws a
 *      RangeError inside `toISOString()` — a 500 on the exact path whose
 *      contract is "a malformed pin is a 400".
 *   2. OVERFLOWING calendar dates (`2026-02-30T00:00:00Z`). These parse fine —
 *      into 2026-03-02. A pin that silently answers a DIFFERENT day than it was
 *      asked for is worse than a rejection: the capture is filed under the day
 *      in the URL. Hence the round-trip: the instant must serialise back to the
 *      calendar fields it was given.
 *
 * The round-trip compares only `YYYY-MM-DDTHH:MM:SS` because the fractional
 * part is optional and 1-3 digits on the way in, and always exactly 3 on the way
 * out — a full-string compare would reject well-formed `…:00.5Z`.
 */
function parseIsoUtcInstant(raw: string): Date | null {
  if (!ISO_UTC.test(raw)) return null
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return null
  if (at.toISOString().slice(0, 19) !== raw.slice(0, 19)) return null
  return at
}

export interface ClockPinInput {
  /** env ∈ {local, sandbox} — the only envs that may ever pin a clock. */
  demoCapable: boolean
  /** `?clock=` on this request: an ISO instant, `'off'`, or absent. */
  query: string | undefined
  /** The pin cookie the browser already carries, if any. */
  cookie: string | undefined
}

export type ClockPinVerdict =
  /** No pin in force; the request reads the wall clock as usual. */
  | { action: 'none' }
  /** Drop the cookie — either an explicit `?clock=off` or a corrupt cookie. */
  | { action: 'clear' }
  /** Pin this request. `setCookie` is true only when the pin arrived on the URL. */
  | { action: 'pin'; clock: ServerClock; setCookie: boolean }
  /** A malformed `?clock=` inside a demo-capable env — fail loudly. */
  | { action: 'reject'; reason: string }

/**
 * Decide the clock pin for one request. Pure — no `H3Event`, no `process.env`,
 * no wall clock of its own. The middleware supplies the three operands and
 * follows the verdict.
 */
export function resolveClockPin(input: ClockPinInput): ClockPinVerdict {
  // The structural floor, before anything else is consulted.
  if (!input.demoCapable) return { action: 'none' }

  // PRESENCE, not truthiness: `?clock=` with an empty (or whitespace-only)
  // value is a pin that was ASKED FOR and cannot be honoured. Treating it as
  // absent would fall through to the cookie and serve a different instant under
  // a URL that names one — the silent-wrong-day outcome this module exists to
  // prevent. Only an absent parameter defers to the cookie.
  if (input.query !== undefined) {
    const q = input.query.trim()
    if (q === CLOCK_PIN_OFF) return { action: 'clear' }
    const at = q === '' ? null : parseIsoUtcInstant(q)
    if (!at) {
      return {
        action: 'reject',
        reason: `?${CLOCK_PIN_PARAM}= must be an ISO-8601 UTC instant (2026-08-01T09:00:00Z) or "${CLOCK_PIN_OFF}"`,
      }
    }
    return { action: 'pin', clock: resolveServerClock(at), setCookie: true }
  }

  if (input.cookie === undefined) return { action: 'none' }
  // A cookie we cannot parse is self-healed rather than obeyed: an unparseable
  // pin must never degrade into "some clock". It is not a 400 — the browser is
  // replaying a value the SERVER minted, so the fault is ours and the repair is
  // to drop it. An empty cookie is the same case: junk we did not write.
  const at = parseIsoUtcInstant(input.cookie.trim())
  if (!at) return { action: 'clear' }
  return { action: 'pin', clock: resolveServerClock(at), setCookie: false }
}
