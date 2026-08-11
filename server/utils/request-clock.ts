/*
 * THE SERVER SEAM — the clock is resolved ONCE per request and everything on
 * that request reads the same answer.
 *
 * Fix-sprint F1 / D1. Before this, a single report request could consult the
 * wall clock four times: the response-cache key (`report-cache.ts` —
 * `new Date().toISOString().slice(0,10)`, no seam at all), the SQL frontier
 * (`GREATEST(CURRENT_DATE, …)` — the DATABASE's clock, a third one), the
 * window resolver, and the browser drawing the result. Four reads is four
 * chances to straddle a UTC midnight, and the gap between any two of them is a
 * chart that disagrees with the number above it.
 *
 * Memoised on `event.context`, which is per-request by construction — so the
 * SQL, the cache key and the shipped `ServerClock` are the same instant, and a
 * request that begins at 23:59:59.9Z finishes on the day it started.
 *
 * THE TEST SEAM. Pre-seeding `event.context.serverClock` pins the whole request
 * to a chosen instant — server, SQL and (via the shipped contract) the client
 * alike. That is the property `clock-and-day-boundary.md` D3 says makes this
 * testable at all, and the reason the parity capture can shoot a real day-1.
 */
import type { H3Event } from 'h3'
import { resolveServerClock, type ServerClock } from '../../shared/reports/clock'

declare module 'h3' {
  interface H3EventContext {
    /** Set by {@link requestClock}, or pre-seeded by a test to pin the instant. */
    serverClock?: ServerClock
  }
}

/**
 * The clock for this request. Resolves once; every later call on the same event
 * gets the identical answer.
 *
 * This is the ONLY place in a request path that may read the wall clock (plus
 * `server/api/v1/clock.get.ts`, which delegates here in spirit). The static gate
 * `tests/unit/shared/clock-static-gate.test.ts` enforces that.
 */
export function requestClock(event: H3Event): ServerClock {
  const existing = event.context.serverClock
  if (existing) return existing
  const clock = resolveServerClock(new Date())
  event.context.serverClock = clock
  return clock
}
