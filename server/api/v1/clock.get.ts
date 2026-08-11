/*
 * GET /api/v1/clock — the server's clock, resolved once and shipped.
 *
 * The shipping vehicle D3 (`docs/design/clock-and-day-boundary.md`) requires and
 * which did not exist: before this route, `settledThrough` had zero occurrences
 * in the repo and no response contract carried `today` or `now`. Fourteen client
 * surfaces each answered "what is today" with their own `new Date()`, so a
 * control could label a period the server was not serving.
 *
 * DELIBERATELY TRIVIAL. No database, no scope, no per-caller variation: the day
 * is UTC for everyone (D1), so there is nothing here to clamp or authorise. It
 * is behind `requireAuth` only because every `/api/v1` route is — the payload is
 * three strings that a wall clock already tells you, except for the one thing it
 * cannot: which day the product considers COMPLETE.
 *
 * IT DELEGATES TO `requestClock`, and that is load-bearing, not tidiness. This
 * route used to call `resolveServerClock(new Date())` itself — a SECOND clock
 * read on a request that may already have one seeded, so the payload the browser
 * draws with could disagree with the payload the page was rendered from. It also
 * made the pin unusable: the parity capture (D29) pins the clock at the request
 * boundary, and a route that re-reads the wall clock would hand the browser the
 * real day while every server-rendered figure said day 1.
 *
 * Cache: `no-store`. A clock is the one payload a cache must never answer.
 */
import { defineEventHandler, setHeader } from 'h3'
import { requireAuth } from '../../auth/rbac'
import { requestClock } from '../../utils/request-clock'
import type { ServerClock } from '../../../shared/reports/clock'

export default defineEventHandler(async (event): Promise<ServerClock> => {
  await requireAuth(event)
  setHeader(event, 'cache-control', 'no-store')
  return requestClock(event)
})
