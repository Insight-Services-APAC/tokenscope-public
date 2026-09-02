/*
 * May a §A read on this window use `usage_rollup_daily` for its settled days?
 *
 * The rollup is derived from `v_complete_usage` by a worker (usage-rollup-lane.md
 * R3), so it is identical BY CONSTRUCTION to the lane it summarises — but only
 * for days the worker has actually materialised. A reader that assumes coverage
 * gets a number that is lower than the truth and looks entirely legitimate,
 * which is the worst failure mode a money figure has.
 *
 * So this gate answers two questions — does the rollup HAVE these days, and is
 * it UP TO DATE with them — and opens only on a yes to both. Each condition
 * closes a different way of being wrong:
 *
 *   1. `backfill-complete` — history was materialised at least once. Without it
 *      the table may simply not go back far enough.
 *   2. `wide-through` within the last day — the 40-day sweep has run recently, so
 *      every day in that horizon was regenerated rather than merely never
 *      contradicted. Not strictly today: the sweep runs at/after 03:00 UTC, so
 *      that would close the gate for three hours every day for no reason.
 *   3. A RECENT SUCCESSFUL RUN. The two markers above record what was true when
 *      the sweep FINISHED, so a worker that dies immediately after leaves them
 *      both healthy until the next UTC day. Liveness is what makes an outage
 *      degrade to the view instead of to quietly stale money.
 *   4. NO PENDING REFRESH REQUEST for this teammate, and NO STALE SETTLED DAY in
 *      the window. These are currency rather than coverage, and they are what
 *      let other §A reads stay on the view safely — see the block above the
 *      second query.
 *
 * Plus the window must sit inside the sweep's horizon: beyond REFRESH_DAYS the
 * rollup relies on the original backfill and mutation signals rather than a
 * periodic regeneration, which is a weaker guarantee than this gate can assert.
 *
 * Returns null when ANY condition fails, and null means "read the view for the
 * whole window" — never a partial or best-effort read. A page that mixes a
 * gated and an ungated figure can disagree with itself.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { REFRESH_DAYS, DEFAULT_RETAG_LOOKBACK_DAYS } from '../workers/usage-rollup'
import { sourceWritesSql } from './source-writes'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/**
 * How stale a successful run may be before the gate closes.
 *
 * The worker runs at 7,22,37,52 past the hour — every 15 minutes, so the
 * longest ordinary gap is 15 minutes. This allows two
 * missed ticks plus slack: short enough that an outage closes the gate quickly,
 * long enough that one slow run does not flap the whole page onto the view.
 */
export const MAX_RUN_AGE_MINUTES = 45

export interface RollupGate {
  /**
   * Inclusive last day servable from the rollup — always the day BEFORE the
   * request's today. Today itself is never taken from the rollup: it is still
   * filling, and the page's window end is clamped to `now`, which a whole-day
   * grain cannot express.
   */
  settledThrough: string
  /** The request's UTC day. Rows on or after it come from the live view. */
  todayUtc: string
}

/**
 * @param window the read's own bounds. BOTH ends matter: the start decides the
 *   horizon check, and the end bounds which days currency is asked about — a
 *   completed month must not be forced onto the view by a pending write to a
 *   day it does not contain.
 * @param nowIso the REQUEST's clock (never `new Date()` here) — the same instant
 *   the handler clamped its window with, so the boundary cannot disagree with
 *   the window it is splitting.
 */
/**
 * Coverage: the half of the gate that does NOT depend on the window.
 *
 * Backfill, sweep recency, worker liveness and the pending-refresh queue are
 * facts about the ROLLUP, not about any particular read, so a request resolving
 * three gates was asking the same four questions three times. Opaque on purpose
 * — its only use is to be handed straight back to {@link resolveRollupGates},
 * so nothing downstream can start reasoning about a half-finished proof.
 */
export interface RollupCoverage {
  readonly todayUtc: string
}

export async function resolveRollupCoverage(
  tx: Tx,
  nowIso: string,
  teammateId: string,
): Promise<RollupCoverage | null> {
  const todayUtc = nowIso.slice(0, 10)
  const [row] = [
    ...(await tx.execute<{
      backfilled: boolean
      wide_today: boolean
      run_fresh: boolean
      refresh_pending: boolean
    }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM kv_store
                 WHERE mount = 'usage-rollup' AND key = 'backfill-complete') AS backfilled,
        -- A wide sweep within the last day, not strictly TODAY. The sweep runs
        -- at/after 03:00 UTC (WIDE_HOUR_UTC), so demanding today's date would
        -- close this gate for the first three hours of every UTC day for no
        -- reason: a sweep 23 hours ago still proves the 40-day horizon was
        -- regenerated, which is the property being asserted.
        EXISTS (SELECT 1 FROM kv_store
                 WHERE mount = 'usage-rollup' AND key = 'wide-through'
                   AND value >= (${todayUtc}::date - 1)::text) AS wide_today,
        EXISTS (SELECT 1 FROM worker_run
                 WHERE worker_name = 'usage-rollup' AND status = 'success'
                   AND started_at > now() - (${String(MAX_RUN_AGE_MINUTES)} || ' minutes')::interval)
          AS run_fresh,
        -- THE INVALIDATION CHANNEL NO TIMESTAMP CAN CARRY. The currency test
        -- compares source WRITE instants against refresh_at, which sees an
        -- insert or an update and cannot see a DELETE or a re-homing: a
        -- quarantined session simply leaves v_complete_usage, and the rollup
        -- keeps the row it built before. The worker learns about those through
        -- this queue, drained MAX_REFRESH_PER_RUN teammates per run, so a
        -- pending entry means "this teammate's rollup may be wrong for a reason
        -- nothing else here can detect".
        EXISTS (SELECT 1 FROM usage_rollup_refresh
                 WHERE teammate_id = ${teammateId}::uuid) AS refresh_pending
    `)),
  ]
  if (!row?.backfilled || !row.wide_today || !row.run_fresh || row.refresh_pending) return null
  return { todayUtc }
}

/** The day bounds one window contributes to the currency question. */
function currencyDays(coverage: RollupCoverage, window: { startIso: string; endIso: string }) {
  const settledThroughDay = new Date(
    Date.parse(`${coverage.todayUtc}T00:00:00.000Z`) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10)
  const lastWholeDay = new Date(
    Date.parse(`${new Date(window.endIso).toISOString().slice(0, 10)}T00:00:00.000Z`) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10)
  return {
    settledThroughDay,
    startDay: new Date(window.startIso).toISOString().slice(0, 10),
    /*
     * The last day currency is asked about: the last SETTLED day this window
     * can actually be served from the rollup. Beyond it the rollup arm reads
     * nothing, so a lag there cannot reach this response.
     */
    throughDay: lastWholeDay < settledThroughDay ? lastWholeDay : settledThroughDay,
  }
}

/**
 * Currency + horizon for SEVERAL windows in one round trip, given coverage.
 *
 * Returns one answer per input window, positionally. A null means "read the
 * view for the whole of that window" — never a partial or best-effort read,
 * because a page mixing a gated and an ungated figure can disagree with itself.
 *
 * Batched because the page resolves a gate per window and every one of them was
 * a separate round trip: on a request already issuing ~50 statements against a
 * credit-throttled server, six of them being this gate was a cost worth
 * removing. The windows a request knows at the same time are asked together;
 * the previous-period window is discovered later (it depends on the frontier
 * day the page read returns) and so asks separately.
 */
export async function resolveRollupGates(
  tx: Tx,
  coverage: RollupCoverage | null,
  windows: ReadonlyArray<{ startIso: string; endIso: string }>,
  nowIso: string,
  teammateId: string,
): Promise<Array<RollupGate | null>> {
  if (!coverage || windows.length === 0) return windows.map(() => null)
  const todayUtc = coverage.todayUtc
  const days = windows.map((w) => currencyDays(coverage, w))

  /*
   * The horizon check, per window, and BEFORE the query: beyond REFRESH_DAYS
   * the rollup rests on the original backfill and mutation signals rather than
   * a periodic regeneration, which is a weaker guarantee than this gate can
   * assert. A window that fails it needs no currency answer, and dropping it
   * here also narrows the day range the query below scans.
   */
  const horizonStart = new Date(Date.parse(`${todayUtc}T00:00:00.000Z`) - REFRESH_DAYS * 86_400_000)
  const asked = windows
    .map((w, i) => ({ i, d: days[i]! }))
    .filter(({ i }) => Date.parse(windows[i]!.startIso) >= horizonStart.getTime())
    // A window whose settled range is empty has nothing to be stale ABOUT.
    .filter(({ d }) => d.throughDay >= d.startDay)
  if (asked.length === 0) {
    return windows.map((_, i) =>
      Date.parse(windows[i]!.startIso) >= horizonStart.getTime()
        ? { settledThrough: days[i]!.settledThroughDay, todayUtc }
        : null,
    )
  }

  const scanFrom = asked.reduce((a, x) => (x.d.startDay < a ? x.d.startDay : a), asked[0]!.d.startDay)
  const scanTo = asked.reduce((a, x) => (x.d.throughDay > a ? x.d.throughDay : a), asked[0]!.d.throughDay)
  const wanted = sql.join(
    asked.map(({ i, d }) => sql`(${String(i)}::int, ${d.startDay}::date, ${d.throughDay}::date)`),
    sql`, `,
  )

  /*
   * CURRENCY, not just coverage — the condition that makes mixed bases safe.
   *
   * Coverage proves the rollup HAS these days. It does not prove it is CURRENT:
   * a row written after the last run sits in the view and not yet in the
   * rollup, so a split figure reads lower than a view figure until the worker
   * re-presents that day. Everywhere those two meet in one response — the
   * untagged remainder against its no-project decomposition, the attributed
   * headline against declared-personal — that lag is an asserted invariant
   * breaking transiently.
   *
   * The test is the WORKER'S OWN (server/usage/source-writes.ts, shared with
   * staleSignalDays so the two inventories cannot drift): a day whose §A source
   * rows carry a write instant newer than that day's refresh_at. Any stale
   * settled day closes that window's gate and it reads the view, where no lag
   * can exist because there is only one source.
   *
   * Bounded by the WORKER'S write lookback rather than a bound of this module's
   * choosing. A tighter one would be unsound in the case that matters: the
   * worker's per-run chunk cap means a detected day can stay pending across
   * several ticks, so a write it is still working through would fall outside a
   * short window and the gate would open over the lag it exists to catch.
   *
   * WHAT THIS CANNOT SEE. These columns default to now(), which is TRANSACTION
   * START, so a source transaction that opens before a recompute and commits
   * after it carries an instant the recompute could not have seen. The bound is
   * therefore "no lag a committed write instant can reveal", not "no lag" — do
   * not restate it more strongly anywhere. The worker's signal shares the blind
   * spot exactly, so such a day is one it also will not recompute before its
   * next wide sweep; what would close it, and what each option costs, is in
   * usage-rollup-lane.md.
   */
  const rows = [
    ...(await tx.execute<{ i: number; any_stale: boolean }>(sql`
      WITH asked (i, start_day, through_day) AS (VALUES ${wanted}),
      writes AS (
        ${sourceWritesSql({
          since: sql`now() - make_interval(days => ${DEFAULT_RETAG_LOOKBACK_DAYS})`,
          teammateId,
          days: { from: sql`${scanFrom}::date`, toInclusive: sql`${scanTo}::date` },
        })}
      ), cand AS (SELECT day, MAX(w) AS w FROM writes GROUP BY day)
      SELECT a.i, EXISTS (
        SELECT 1 FROM cand c
         WHERE c.day >= a.start_day AND c.day <= a.through_day
           AND NOT EXISTS (
             /*
              * The witness must match the CANDIDATE on every identity dimension
              * it certifies, teammate included. Without that, a colleague's cell
              * refreshed on the same day satisfies this reader's proof: the
              * queue drain recomputes ONE teammate at a time, so a same-day cell
              * belonging to someone else is not evidence about this one. The
              * worker's own signal is day-scoped and correct to be, because its
              * unit of work IS the whole day.
              */
             SELECT 1 FROM usage_rollup_daily r
              WHERE r.day = c.day AND r.teammate_id = ${teammateId}::uuid
                AND r.refresh_at >= c.w + interval '1 minute'
           )
      ) AS any_stale
      FROM asked a
    `)),
  ]
  const staleByIndex = new Map(rows.map((r) => [Number(r.i), r.any_stale]))

  return windows.map((w, i) => {
    if (Date.parse(w.startIso) < horizonStart.getTime()) return null
    if (staleByIndex.get(i) === true) return null
    return { settledThrough: days[i]!.settledThroughDay, todayUtc }
  })
}

/**
 * One window, coverage included — the shape every caller outside the /me/usage
 * handler wants, and the one the gate's own tests drive.
 *
 * Two statements. A caller resolving SEVERAL gates should take coverage once
 * and batch the rest rather than calling this repeatedly.
 */
export async function resolveRollupGate(
  tx: Tx,
  window: { startIso: string; endIso: string },
  nowIso: string,
  teammateId: string,
): Promise<RollupGate | null> {
  const coverage = await resolveRollupCoverage(tx, nowIso, teammateId)
  if (!coverage) return null
  const [gate] = await resolveRollupGates(tx, coverage, [window], nowIso, teammateId)
  return gate ?? null
}

/**
 * The bounds a split read needs, derived ONCE.
 *
 * Every defect this split has produced was in this arithmetic: a rollup arm
 * without the window's upper bound reported a completed month's neighbours
 * inside it; a live arm without the window's lower bound would admit rows
 * before a future-starting window. Both were invisible until a test seeded
 * spend exactly on the boundary. Five call sites deriving it independently is
 * five chances to get it wrong again, so they derive it here.
 *
 * The contract, and it is exact:
 *   - the rollup arm covers WHOLE SETTLED DAYS inside the window: from the
 *     window's start day, through the earlier of settledThrough and the last
 *     day strictly before the window's exclusive end;
 *   - the live arm covers instants from the later of today and the window
 *     start, up to the window's exclusive end;
 *   - the two are disjoint, and their union is EXACTLY [startIso, endIso).
 *
 * WHICH IS WHY IT CAN REFUSE. A whole-day arm cannot express a partial day, so
 * two window shapes have no correct split and get null — meaning "read the view
 * for the whole window", the same answer a closed gate gives:
 *
 *   - a start that is not a UTC midnight, where a rollup arm exists: its start
 *     day would be admitted whole, counting spend from before the window;
 *   - an end that is not a UTC midnight on a day BEFORE today: the live arm
 *     begins at today and so is empty, and the window's final partial day
 *     would simply be dropped.
 *
 * Neither is reachable from the route today (its starts are UTC midnights and
 * its only mid-day end is today, which the live arm covers). They are refused
 * rather than documented because the alternative is a claim of exact coverage
 * that is true only for the callers that happen to exist.
 */
export interface SplitBounds {
  /** Inclusive first day of the rollup arm. */
  rollupFrom: string
  /** Inclusive last day of the rollup arm; null when it covers nothing. */
  rollupTo: string | null
  /** Inclusive lower instant of the live arm. */
  liveFrom: string
}

const isUtcMidnight = (iso: string) => new Date(iso).toISOString().slice(10) === 'T00:00:00.000Z'

export function splitBounds(
  gate: RollupGate,
  window: { startIso: string; endIso: string },
): SplitBounds | null {
  const startDay = new Date(window.startIso).toISOString().slice(0, 10)
  // endIso is EXCLUSIVE, so the last whole day it can contain is the day before
  // its own date — true for a midnight bound and for a mid-day clamp alike.
  const endDayExclusive = new Date(window.endIso).toISOString().slice(0, 10)
  const lastWholeDay = new Date(Date.parse(`${endDayExclusive}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10)
  const cappedTo = lastWholeDay < gate.settledThrough ? lastWholeDay : gate.settledThrough
  const rollupTo = cappedTo < startDay ? null : cappedTo
  const liveFromDay = `${gate.todayUtc}T00:00:00.000Z`
  const liveFrom = liveFromDay > window.startIso ? liveFromDay : window.startIso

  // A mid-day start is fine when nothing is served from whole days.
  if (rollupTo !== null && !isUtcMidnight(window.startIso)) return null
  // A mid-day end is fine only while the live arm still reaches it.
  if (!isUtcMidnight(window.endIso) && endDayExclusive < gate.todayUtc) return null

  return { rollupFrom: startDay, rollupTo, liveFrom }
}
