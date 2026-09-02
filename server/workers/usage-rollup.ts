/*
 * usage-rollup — materialises usage_rollup_daily from v_complete_usage
 * (design: docs/design/usage-rollup-lane.md R3/R4; table: mig 0136).
 *
 * The source is THE VIEW, not the base tables: the rollup's content is
 * defined as an aggregate of the §A lane, so quarantine exclusion, fill arms
 * and remainder rows can never diverge from the lane's own definition, and a
 * future view migration propagates here without a second implementation.
 * 0135 makes the windowed view scan affordable at cadence.
 *
 * Recompute is DELETE + upsert per day-chunk in chunked transactions (the
 * aggregate-rollup mechanics): DELETE covers cells that vanished, the
 * ON CONFLICT upsert makes concurrent runs harmless, chunking bounds lock
 * windows. Three recompute signals, each with its own reason to exist:
 *
 *   1. TRAILING WINDOW — every run recomputes a trailing span of calendar
 *      days (data or not — an emptied day must be deleted, so the day-set
 *      cannot come from "days with data"). Steady state is NARROW: today +
 *      NARROW_REFRESH_DAYS prior (the still-filling edge). ONE run per UTC
 *      day — the first incremental run at/after WIDE_HOUR_UTC — re-runs the
 *      full REFRESH_DAYS window as belt-and-braces for unknown writers
 *      (performance-observability-baseline.md O5). The wide pass is gated by
 *      the worker-owned kv marker 'usage-rollup'/'wide-through', written
 *      ONLY after every chunk of the wide run committed, so a mid-run crash
 *      re-runs wide (dr-H5). Covers new writes, provider walk-back and
 *      reconciliation lag.
 *   2. SOURCE-WRITE SIGNAL — event-days of §A source rows WRITTEN OR MUTATED
 *      inside the (downtime-widened) lookback, one write-instant column per
 *      arm: attribution_record.ts_recorded (every ledger mutation bumps it —
 *      tag-session and the governance re-home lanes), actual_spend.pulled_at,
 *      provider_usage_fact.pulled_at, reconciliation_record.computed_at,
 *      unaccounted_usage GREATEST(computed_at, tagged_at) (the reconcile
 *      recompute and the tag-unaccounted path; model children are written
 *      with their parent). This is what lets a historical re-pull or an
 *      old-day re-tag land in the rollup no matter how old the DATA day is.
 *      Runs in BOTH modes, so a write racing the backfill is not stranded
 *      behind the "day already has rows" resume probe.
 *   3. REFRESH QUEUE — usage_rollup_refresh rows (a quarantine flip, a
 *      placement re-home: retro mutations with NO write instant the signal
 *      can see on the affected SOURCE rows). Drained per teammate, at most
 *      MAX_REFRESH_PER_RUN per run: recompute that teammate's FULL history,
 *      delete the request only after (a crashed run re-drains).
 *
 * Backfill is FULL history and RESUMES ACROSS RUNS: at most
 * MAX_CHUNKS_PER_RUN day-chunks are processed per invocation (the dispatch
 * budget, shared/workers/dispatch-budget.ts, caps a run at ~200 s — a
 * whole-history backfill at enterprise scale must not race it), oldest days
 * first, and backfillComplete is only reported true when no unprocessed day
 * remains. Completion state is the worker-OWNED kv_store marker
 * ('usage-rollup'/'backfill-complete'), written by the run that observes zero
 * remaining days; worker_run's result.backfillComplete is a compatibility
 * fallback only (run-health bookkeeping is fail-open). Never inferred from
 * row count — a crashed partial backfill must not look done (the
 * aggregate-rollup rule).
 */
import { sql } from 'drizzle-orm'
import { sourceWritesSql } from '../usage/source-writes'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

/** WIDE trailing window: today + this many PRIOR days (41 total). Paid once
 *  per UTC day by the wide pass (performance-observability-baseline.md O5). */
export const REFRESH_DAYS = 40
/** NARROW steady-state window: today + this many PRIOR days (3 total) — the
 *  still-filling edge. Every other retro path must arrive via the source-write
 *  signal or the refresh queue (O5; dr-H4 put confirm-instance on the signal). */
export const NARROW_REFRESH_DAYS = 2
/** First incremental run at/after this UTC hour pays the day's wide pass. */
const WIDE_HOUR_UTC = 3
/** Source-write signal lookback: this many prior days on each write instant. */
/**
 * Floor on how far back a source WRITE is looked for. Exported because the
 * read-side gate must use the SAME floor: anything the worker cannot see as
 * pending, the gate cannot prove is settled.
 */
export const DEFAULT_RETAG_LOOKBACK_DAYS = 2
/** Days recomputed per transaction — bounds lock duration. */
const CHUNK_DAYS = 10
/** Chunks per invocation — keeps any single run far inside the dispatch budget. */
const MAX_CHUNKS_PER_RUN = 8
/** Refresh-queue drains per invocation — a mass re-home must not blow the budget. */
const MAX_REFRESH_PER_RUN = 50

export interface UsageRollupResult {
  mode: 'incremental' | 'backfill'
  daysRecomputed: number
  cells: number
  refreshedTeammates: number
  /** Persisted to worker_run.result — gates future runs out of backfill. */
  backfillComplete: boolean
  /** True when this run paid the wide (REFRESH_DAYS) trailing window — the
   *  once-per-UTC-day belt-and-braces pass (O5). Always false in backfill. */
  wide: boolean
}

interface DayRow extends Record<string, unknown> {
  day: string // 'YYYY-MM-DD'
}

/** The grain + measure SELECT over the lane, windowed to a day-chunk or a teammate.
 *
 *  CONSTRAINT — identity_state is NULLIF-normalised ('' -> NULL) because the
 *  grain index arbiter buckets NULL and '' into ONE key (the 0138 COALESCE
 *  sentinel), and attribution_record carries no CHECK on the column: grouping
 *  them as two cells would make one upsert statement hit the same arbiter key
 *  twice (a cardinality violation). The 0138 reseed aggregates with the same
 *  expression — structural agreement, not data cleanup
 *  (usage-rollup-lane.md R5b.1). */
const cellsSelect = (predicate: ReturnType<typeof sql>): ReturnType<typeof sql> => sql`
  SELECT (u.ts_event AT TIME ZONE 'UTC')::date AS day,
         u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
         u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
         NULLIF(u.identity_state, '') AS identity_state,
         COALESCE(SUM(u.cost_usd), 0) AS cost_usd,
         COALESCE(SUM(u.tokens), 0) AS tokens,
         COUNT(*) AS record_count
  FROM v_complete_usage u
  WHERE ${predicate}
  GROUP BY (u.ts_event AT TIME ZONE 'UTC')::date,
           u.teammate_id, u.region_id, u.org_unit_id, u.cost_owning_unit_id, u.project_id,
           u.tool, u.model, u.usage_provenance, u.model_gap_reason, u.activity,
           NULLIF(u.identity_state, '')`

const SENTINEL = '00000000-0000-0000-0000-000000000000'

/** INSERT … ON CONFLICT targeting the sentinel grain index (0136, widened by
 *  0138 with identity_state as a grain dim). */
const upsertFromCells = (cells: ReturnType<typeof sql>): ReturnType<typeof sql> => sql`
  WITH cells AS (${cells}), inserted AS (
    INSERT INTO usage_rollup_daily
      (day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
       tool, model, usage_provenance, model_gap_reason, activity, identity_state,
       cost_usd, tokens, record_count, refresh_at)
    SELECT day, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
           tool, model, usage_provenance, model_gap_reason, activity, identity_state,
           cost_usd, tokens, record_count, now()
    FROM cells
    ON CONFLICT (day, teammate_id,
                 COALESCE(region_id, ${SENTINEL}::uuid),
                 COALESCE(org_unit_id, ${SENTINEL}::uuid),
                 COALESCE(cost_owning_unit_id, ${SENTINEL}::uuid),
                 COALESCE(project_id, ${SENTINEL}::uuid),
                 tool, COALESCE(model, ''), usage_provenance,
                 COALESCE(model_gap_reason, ''), COALESCE(activity, ''),
                 COALESCE(identity_state, ''))
    DO UPDATE SET cost_usd = EXCLUDED.cost_usd, tokens = EXCLUDED.tokens,
                  record_count = EXCLUDED.record_count, refresh_at = now()
    RETURNING 1
  )
  SELECT COUNT(*)::text AS n FROM inserted`

interface SignalOpts {
  lookbackDays: number
}

/** True until a completed backfill is recorded — kv marker first (worker-owned),
 *  worker_run second (pre-marker deploys).
 *
 *  An EMPTY usage_rollup_daily forces backfill REGARDLESS of either record, and
 *  deletes the stale 'backfill-complete' + 'wide-through' markers (dr-H5): a
 *  truncated/restored table must rebuild, never limp on the narrow window with
 *  a marker claiming completion. This is also the documented reset runbook —
 *  truncate the table, delete the markers. The cost is a cheap LIMIT-1 probe;
 *  a genuinely usage-free estate re-enters backfill vacuously (zero missing
 *  days), which is accepted. */
async function isBackfillMode(db: Db): Promise<boolean> {
  const probe = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM usage_rollup_daily LIMIT 1
  `)
  if ([...probe].length === 0) {
    // An empty rollup beside a NON-empty lane is a wipe/restore — rebuild.
    // An empty rollup beside an EMPTY lane is just a usage-free estate
    // (r3-L12): without this probe every tick would delete the markers,
    // re-backfill zero days and re-write them, churning kv forever.
    const lane = await db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM v_complete_usage LIMIT 1
    `)
    if ([...lane].length === 0) return false
    await db.execute(sql`
      DELETE FROM kv_store
      WHERE mount = 'usage-rollup' AND key IN ('backfill-complete', 'wide-through')
    `)
    return true
  }
  const prior = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM kv_store
    WHERE mount = 'usage-rollup' AND key = 'backfill-complete'
    UNION ALL
    SELECT 1 AS ok FROM worker_run
    WHERE worker_name = 'usage-rollup' AND status = 'success'
      AND (result->>'backfillComplete') = 'true'
    LIMIT 1
  `)
  return [...prior].length === 0
}

/**
 * The once-per-UTC-day wide gate (O5): wide iff the SQL clock — never a JS
 * `new Date()`; the server owns the clock — is at/after `wideHourUtc` AND the
 * 'wide-through' marker is absent or names an earlier UTC day. Returns the
 * clock's UTC day so the post-run marker write stamps the SAME day the gate
 * was judged on.
 */
async function resolveWideGate(
  db: Db,
  wideHourUtc: number,
): Promise<{ todayUtc: string; wide: boolean }> {
  const [row] = await db.execute<{ today: string; hour: number; through: string | null }>(sql`
    SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS today,
           EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int AS hour,
           (SELECT value FROM kv_store
             WHERE mount = 'usage-rollup' AND key = 'wide-through') AS through
  `)
  // ISO 'YYYY-MM-DD' strings order lexicographically = chronologically.
  const stale = row!.through == null || row!.through < row!.today
  return { todayUtc: row!.today, wide: row!.hour >= wideHourUtc && stale }
}

/** Downtime-widened lookback (the aggregate-rollup shape). */
async function resolveLookbackDays(db: Db, floorDays: number): Promise<number> {
  const [last] = await db.execute<{ days: string | null }>(sql`
    SELECT (EXTRACT(EPOCH FROM (now() - MAX(started_at))) / 86400.0)::text AS days
    FROM worker_run WHERE worker_name = 'usage-rollup' AND status = 'success'
  `)
  const sinceDays = last?.days != null ? Math.ceil(Number(last.days)) + 1 : floorDays
  return Math.max(floorDays, sinceDays)
}

/**
 * Signal 2 — days whose §A source rows were written/mutated inside the
 * lookback AND whose rollup state predates that write. The refresh_at
 * comparison is what makes a CAPPED run make progress: a recomputed day drops
 * out of the signal on the next tick, so successive slices ADVANCE through a
 * large restamp instead of re-taking the same oldest days until the stamps
 * age out of the lookback. The one-minute margin guards the race where a
 * source write lands during the recompute transaction whose refresh_at then
 * stamps microseconds later without having seen it. A day recomputed to
 * EMPTY has no refresh_at to prove currency and stays a candidate until its
 * stamp ages out — bounded by the lookback, and idempotent.
 */
async function staleSignalDays(db: Db, opts: SignalOpts): Promise<string[]> {
  const rows = await db.execute<DayRow>(sql`
    WITH writes AS (
      ${sourceWritesSql({ since: sql`now() - make_interval(days => ${opts.lookbackDays})` })}
    ), cand AS (
      SELECT day, MAX(w) AS w FROM writes GROUP BY day
    )
    SELECT (c.day)::text AS day FROM cand c
    WHERE NOT EXISTS (
      SELECT 1 FROM usage_rollup_daily r
      WHERE r.day = c.day AND r.refresh_at >= c.w + interval '1 minute'
    )
  `)
  return [...rows].map((r) => r.day)
}

/** Backfill mode: days the lane has that the rollup does not, oldest first. */
async function missingBackfillDays(db: Db): Promise<string[]> {
  const rows = await db.execute<DayRow>(sql`
    SELECT DISTINCT ((u.ts_event AT TIME ZONE 'UTC')::date)::text AS day
    FROM v_complete_usage u
    WHERE NOT EXISTS (
      SELECT 1 FROM usage_rollup_daily r
      WHERE r.day = (u.ts_event AT TIME ZONE 'UTC')::date
    )
    ORDER BY day ASC
  `)
  return [...rows].map((r) => r.day)
}

/** Steady state: anchor + refreshDays prior calendar days, data or not — an
 *  emptied day must be deleted, so the set cannot come from "days with data".
 *  `anchorDayUtc` is the wide gate's captured day when a gate ran (r3-L10:
 *  a second clock read across UTC midnight would cover D+1 while the marker
 *  stamps D, buying an unnecessary second wide pass); null = read the SQL
 *  clock here (backfill-signal appends, explicit-window callers). */
async function trailingWindowDays(
  db: Db,
  refreshDays: number,
  anchorDayUtc: string | null,
): Promise<string[]> {
  const anchor =
    anchorDayUtc != null ? sql`${anchorDayUtc}::date` : sql`(now() AT TIME ZONE 'UTC')::date`
  const rows = await db.execute<DayRow>(sql`
    SELECT (d::date)::text AS day
    FROM generate_series(
      ${anchor} - ${refreshDays}::int,
      ${anchor},
      interval '1 day'
    ) AS d
  `)
  return [...rows].map((r) => r.day)
}

/** DELETE + full re-insert for one day-chunk, one short transaction. */
async function recomputeDayChunk(db: Db, chunk: string[]): Promise<number> {
  const dayList = sql.join(
    chunk.map((d) => sql`${d}::date`),
    sql`, `,
  )
  // Sargable ts_event range over the chunk's contiguous span; the exact
  // ::date IN (...) pins correctness within it (aggregate-rollup shape).
  const minDay = chunk[0]!
  const maxDay = chunk[chunk.length - 1]!
  const predicate = sql`
    u.ts_event >= (${minDay}::timestamp AT TIME ZONE 'UTC')
      AND u.ts_event < ((${maxDay}::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND (u.ts_event AT TIME ZONE 'UTC')::date IN (SELECT d FROM unnest(ARRAY[${dayList}]) AS d)`
  let cells = 0
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM usage_rollup_daily
      WHERE day IN (SELECT d FROM unnest(ARRAY[${dayList}]) AS d)
    `)
    const ins = await tx.execute<{ n: string }>(upsertFromCells(cellsSelect(predicate)))
    cells = Number([...ins][0]?.n ?? 0)
  })
  return cells
}

/**
 * Drain the retro-mutation queue, capped per run: per-teammate full-history
 * recompute; the request row is deleted only for requests captured BEFORE the
 * recompute began, so one arriving mid-recompute survives to the next run.
 */
async function drainRefreshQueue(db: Db): Promise<number> {
  const queued = [
    ...(await db.execute<{ teammate_id: string; requested_at: string }>(sql`
      SELECT teammate_id::text AS teammate_id, requested_at::text AS requested_at
      FROM usage_rollup_refresh
      ORDER BY requested_at ASC
      LIMIT ${MAX_REFRESH_PER_RUN}
    `)),
  ]
  for (const req of queued) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM usage_rollup_daily WHERE teammate_id = ${req.teammate_id}::uuid
      `)
      await tx.execute(
        upsertFromCells(cellsSelect(sql`u.teammate_id = ${req.teammate_id}::uuid`)),
      )
      /*
       * Delete EXACTLY the request that was read, matched on its stamp.
       *
       * `<=` looked equivalent and was not: a request arriving during the
       * rebuild is work this run did not do, and any comparison that admits
       * "at or before" can consume it. Two ways it did. Enqueues stamped
       * transaction-start `now()`, so a slow writer's request could carry an
       * instant from before this capture; and `DO UPDATE SET requested_at`
       * overwrote unconditionally, so a fresh request could move an existing
       * stamp BACKWARD into the delete window. Both dropped an invalidation
       * whose work was never done, leaving the rollup wrong until the wide
       * sweep -- the exact durability the read gate now depends on.
       *
       * The STRICTLY ADVANCING stamp at every enqueue site is what closes it,
       * and equality here is what consumes the closure. A request always ends
       * up with an instant no earlier-captured value can equal, so this delete
       * can only ever remove the exact row this run served.
       *
       * Strictly advancing, not merely "current": statement_timestamp() is
       * fixed when the enqueue STATEMENT starts, so a statement that began
       * before this capture and committed after the recompute could otherwise
       * leave GREATEST() returning the captured value unchanged -- and this
       * delete would consume work the recompute never saw. The
       * `+ interval '1 microsecond'` term removes that case by construction.
       */
      await tx.execute(sql`
        DELETE FROM usage_rollup_refresh
        WHERE teammate_id = ${req.teammate_id}::uuid
          AND requested_at = ${req.requested_at}::timestamptz
      `)
    })
  }
  return queued.length
}

export async function runUsageRollup(
  db: Db,
  opts: {
    refreshDays?: number
    retagLookbackDays?: number
    maxChunksPerRun?: number
    /** Test seam: pay the wide pass now, regardless of the hour/marker gate. */
    forceWide?: boolean
    /** Test seam: UTC hour at/after which the gate opens (default WIDE_HOUR_UTC). */
    wideHourUtc?: number
  } = {},
): Promise<UsageRollupResult> {
  const retagLookbackDays = opts.retagLookbackDays ?? DEFAULT_RETAG_LOOKBACK_DAYS
  const maxChunks = opts.maxChunksPerRun ?? MAX_CHUNKS_PER_RUN

  const isBackfill = await isBackfillMode(db)
  const lookback = await resolveLookbackDays(db, retagLookbackDays)
  // Runs in BOTH modes, so a write racing the backfill is not stranded behind
  // the "day already has rows" resume probe.
  const signalDays = await staleSignalDays(db, { lookbackDays: lookback })

  // The wide gate (O5) applies only to incremental runs on the DEFAULT window:
  // backfill has full-history semantics of its own, and an explicit
  // opts.refreshDays is the caller's window — it must neither consume nor
  // write the once-per-day marker.
  let wide = false
  let todayUtc: string | null = null
  if (!isBackfill && opts.refreshDays == null) {
    const gate = await resolveWideGate(db, opts.wideHourUtc ?? WIDE_HOUR_UTC)
    todayUtc = gate.todayUtc
    wide = opts.forceWide === true || gate.wide
  }

  let days: string[]
  let windowDays: string[] = []
  let backfillHasRemainder = false
  if (isBackfill) {
    const missing = await missingBackfillDays(db)
    const capped = missing.slice(0, maxChunks * CHUNK_DAYS)
    backfillHasRemainder = missing.length > capped.length
    days = [...new Set([...capped, ...signalDays])].sort()
  } else {
    const refreshDays = opts.refreshDays ?? (wide ? REFRESH_DAYS : NARROW_REFRESH_DAYS)
    windowDays = await trailingWindowDays(db, refreshDays, todayUtc)
    days = [...new Set([...windowDays, ...signalDays])].sort()
  }

  // The COMBINED set is capped per invocation — a historical re-pull stamps a
  // fresh write instant on every affected day, and an uncapped union would put
  // the whole estate's history into one run, straight past the dispatch
  // budget. The remainder is not lost: a recomputed day drops OUT of the
  // signal (staleSignalDays' refresh_at filter), so successive capped runs
  // advance through the set instead of re-taking the same slice, and
  // capped-out backfill days re-derive from the missing-day probe.
  const uncapped = days
  days = days.slice(0, maxChunks * CHUNK_DAYS)
  if (isBackfill && uncapped.length > days.length) {
    // Signal days can displace missing days past the cap; completion must be
    // judged on what actually RAN, or the kv marker would seal a backfill
    // with unprocessed history behind it.
    const ran = new Set(days)
    backfillHasRemainder ||= uncapped.some((d) => !ran.has(d))
  }

  let cells = 0
  for (let i = 0; i < days.length; i += CHUNK_DAYS) {
    cells += await recomputeDayChunk(db, days.slice(i, i + CHUNK_DAYS))
  }

  // dr-H5: the 'wide-through' marker is written ONLY here — after EVERY chunk
  // of the wide run committed — and only when the cap displaced none of the
  // wide window's own days (old signal days sort first and can push the recent
  // edge past the cap). A crashed or truncated wide run leaves the marker
  // stale, so the next gated run re-runs wide.
  if (wide && todayUtc != null) {
    const ran = new Set(days)
    if (windowDays.every((d) => ran.has(d))) {
      await db.execute(sql`
        INSERT INTO kv_store (mount, key, value)
        VALUES ('usage-rollup', 'wide-through', ${todayUtc})
        ON CONFLICT (mount, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `)
    }
  }

  // NEVER during backfill: a per-teammate recompute would materialise a
  // PARTIAL day (one teammate's rows), and the resume probe treats "day has
  // rows" as "day is done" — it would skip that day for everyone else. The
  // queue survives and drains on the first incremental run.
  const refreshedTeammates = isBackfill ? 0 : await drainRefreshQueue(db)

  const backfillComplete = !(isBackfill && backfillHasRemainder)
  if (isBackfill && backfillComplete) {
    // The worker-OWNED completion marker — run-health's worker_run bookkeeping
    // is deliberately fail-open, and a persistence gap there would otherwise
    // pin every future run in backfill mode, each paying a full-history
    // missing-day enumeration.
    await db.execute(sql`
      INSERT INTO kv_store (mount, key, value)
      VALUES ('usage-rollup', 'backfill-complete', now()::text)
      ON CONFLICT (mount, key) DO NOTHING
    `)
  }

  return {
    mode: isBackfill ? 'backfill' : 'incremental',
    daysRecomputed: days.length,
    cells,
    refreshedTeammates,
    // A backfill with unprocessed days left reports FALSE, so the next run
    // stays in backfill and continues where this one stopped.
    backfillComplete,
    wide,
  }
}
