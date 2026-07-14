/*
 * aggregate-rollup — materialises attribution_aggregate from the raw ledger
 * (design: docs/design/my-consumption-my-projects-brief.md §6.1).
 *
 * Grain: (scope_type ∈ {teammate, project}) × UTC day × tool × model ×
 * token_type, with total_tokens / total_cost_usd / advisory_cost_usd
 * (tier-2 subset) / record_count. Every consumption/project dashboard reads
 * THIS table — never the raw ledger — so the recompute set must cover every
 * way a day's cells can change:
 *
 *   1. NEW ledger writes — the joiner appends continuously with
 *      ts_recorded = insert time.
 *   2. RETROACTIVE re-tags — tagSessionTx bumps ts_recorded = now() on every
 *      ledger mutation (project move, activity-only, full clear), so ONE
 *      signal (ts_recorded inside the lookback window) covers both cases.
 *
 * Recompute is DELETE + upsert per (scope, day-chunk) in CHUNKED
 * transactions — delete handles cells that vanished (a re-tag moving a
 * whole conversation off a project), the ON CONFLICT upsert makes
 * concurrent runs harmless, and chunking keeps lock windows short (a
 * 90-day backfill must not block the ledger for minutes).
 *
 * Self-bootstrapping: until a backfill has FULLY completed at least once, the
 * run materialises the whole BACKFILL_DAYS horizon (ts_EVENT-keyed — an old
 * ledger's insert times predate any ts_recorded window). Completeness is
 * tracked in worker_run (result.backfillComplete), NOT the table's row count:
 * a crashed/partial backfill leaves a non-empty table that must NOT look
 * 'done' (else the next run flips to the 2-day incremental window and the
 * un-backfilled historical days — whose ts_recorded is old — are stranded
 * forever). Incremental runs additionally widen their lookback to cover any
 * worker DOWNTIME since the last success, so a multi-day outage can't strand
 * the days written during it.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'

type Db = PostgresJsDatabase<typeof schema>

/** Incremental window: today + this many prior days, keyed on ts_recorded. */
const DEFAULT_LOOKBACK_DAYS = 2
/** First-run (empty table) backfill horizon, keyed on ts_event. */
const DEFAULT_BACKFILL_DAYS = 90
/** Days recomputed per transaction — bounds lock duration during backfill. */
const CHUNK_DAYS = 10

export interface AggregateRollupResult {
  mode: 'incremental' | 'backfill'
  daysRecomputed: number
  teammateCells: number
  projectCells: number
  // mig 0053 — the durable enriched rollup + its session companion, recomputed
  // in the SAME day-set pass as the legacy scope aggregate so the two can't
  // drift during the read-migration transition.
  rollupCells: number
  sessionCells: number
  /** Persisted to worker_run.result — gates future runs out of backfill. */
  backfillComplete: boolean
}

interface DayRow extends Record<string, unknown> {
  day: string // 'YYYY-MM-DD'
}

export async function runAggregateRollup(
  db: Db,
  opts: { lookbackDays?: number; backfillDays?: number; freezeFloorDays?: number | null } = {},
): Promise<AggregateRollupResult> {
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  const backfillDays = opts.backfillDays ?? DEFAULT_BACKFILL_DAYS

  // Freeze-floor (ledger-retention epic): once raw older than the hot window is
  // archived+dropped, the rollup must NOT recompute those days — a backfill
  // would recompute the now-absent raw to empty and the DELETE would ERASE the
  // durable cold cells. So clamp the day-set to days STRICTLY NEWER than the
  // floor; below it, cells are immutable/authoritative. NULL = no floor (the
  // safe default while nothing is archived); the archive worker sets it to the
  // raw-retention boundary it enforces. Env override for ops.
  const freezeFloorDays =
    opts.freezeFloorDays ??
    (process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS ? Number(process.env.LEDGER_ROLLUP_FREEZE_FLOOR_DAYS) : null)
  // SQL fragment: only recompute event-days newer than (today - floor). Empty
  // when no floor. Kept in-SQL so it shares now() with the rest of the worker.
  const floorPredicate =
    freezeFloorDays != null && Number.isFinite(freezeFloorDays)
      ? sql`AND (ar.ts_event AT TIME ZONE 'UTC')::date > ((now() AT TIME ZONE 'UTC')::date - ${freezeFloorDays}::int)`
      : sql``

  // Backfill until one has fully COMPLETED (recorded in worker_run, not
  // inferred from row count — see header). A crashed backfill never reaches
  // the return that sets the flag, so the next run re-enters backfill and
  // re-materialises the whole horizon (idempotent via ON CONFLICT).
  const priorComplete = await db.execute<{ ok: number }>(sql`
    SELECT 1 AS ok FROM worker_run
    WHERE worker_name = 'aggregate-rollup' AND status = 'success'
      AND (result->>'backfillComplete') = 'true'
    LIMIT 1
  `)
  const isBackfill = [...priorComplete].length === 0

  // Incremental lookback widens to cover worker downtime: a gap longer than
  // the default would strand event-days whose ts_recorded fell in the gap
  // (the joiner's deep-rescan does the same). Backfill ignores it (it sweeps
  // the full horizon regardless).
  let windowDays = backfillDays
  if (!isBackfill) {
    const [last] = await db.execute<{ days: string | null }>(sql`
      SELECT (EXTRACT(EPOCH FROM (now() - MAX(started_at))) / 86400.0)::text AS days
      FROM worker_run WHERE worker_name = 'aggregate-rollup' AND status = 'success'
    `)
    const sinceDays = last?.days != null ? Math.ceil(Number(last.days)) + 1 : lookbackDays
    windowDays = Math.max(lookbackDays, sinceDays)
  }

  // ── Day set ───────────────────────────────────────────────────────────
  // Incremental: event-days of rows WRITTEN OR RE-TAGGED inside the window
  // (tagSessionTx bumps ts_recorded, so one signal covers both — indexed
  // by mig 0046). Backfill: the historical event days themselves — an old
  // ledger's insert times can predate any ts_recorded window.
  const dayRows = isBackfill
    ? await db.execute<DayRow>(sql`
        SELECT DISTINCT ((ar.ts_event AT TIME ZONE 'UTC')::date)::text AS day
        FROM attribution_record ar
        WHERE ar.ts_event >= now() - make_interval(days => ${windowDays})
        ${floorPredicate}
      `)
    : await db.execute<DayRow>(sql`
        SELECT DISTINCT ((ar.ts_event AT TIME ZONE 'UTC')::date)::text AS day
        FROM attribution_record ar
        WHERE ar.ts_recorded >= now() - make_interval(days => ${windowDays})
        ${floorPredicate}
      `)
  const days = [...dayRows].map((r) => r.day).sort()
  if (days.length === 0) {
    // No work this tick. A completed backfill stays complete; an empty-ledger
    // first run reports complete so it doesn't loop in backfill forever.
    return {
      mode: isBackfill ? 'backfill' : 'incremental',
      daysRecomputed: 0,
      teammateCells: 0,
      projectCells: 0,
      rollupCells: 0,
      sessionCells: 0,
      backfillComplete: true,
    }
  }

  // ── Recompute per (scope, day-chunk) — short transactions ────────────
  const recomputeChunk = async (
    scope: 'teammate' | 'project',
    chunk: string[],
  ): Promise<number> => {
    const dayList = sql.join(
      chunk.map((d) => sql`${d}::date`),
      sql`, `,
    )
    // Sargable ts_event range over the chunk's contiguous day-span, so the
    // recompute scan uses a ts_event index instead of seq-scanning on the
    // opaque `(ts_event AT TIME ZONE 'UTC')::date` expression (the exact
    // `::date IN (...)` filter below still pins correctness within the range).
    const minDay = chunk[0]!
    const maxDay = chunk[chunk.length - 1]!
    const scopeId = scope === 'teammate' ? sql`ar.teammate_id` : sql`ar.project_id`
    const scopeFilter = scope === 'project' ? sql`AND ar.project_id IS NOT NULL` : sql``
    let written = 0
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM attribution_aggregate
        WHERE scope_type = ${scope}
          AND period_kind = 'day'
          AND period_start IN (
            SELECT (d::timestamp AT TIME ZONE 'UTC') FROM unnest(ARRAY[${dayList}]) AS d
          )
      `)
      const ins = await tx.execute<{ n: string }>(sql`
        WITH cells AS (
          SELECT
            ${scopeId} AS scope_id,
            (ar.ts_event AT TIME ZONE 'UTC')::date AS day,
            ar.tool,
            ar.model,
            ar.token_type,
            ar.query_source,
            SUM(ar.tokens) AS total_tokens,
            SUM(ar.cost_usd) AS total_cost_usd,
            COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.fidelity_tier = 'tier-2'), 0) AS advisory_cost_usd,
            COUNT(*) AS record_count
          FROM attribution_record ar
          WHERE ar.ts_event >= (${minDay}::timestamp AT TIME ZONE 'UTC')
            AND ar.ts_event < ((${maxDay}::date + 1)::timestamp AT TIME ZONE 'UTC')
            AND (ar.ts_event AT TIME ZONE 'UTC')::date IN (
              SELECT d FROM unnest(ARRAY[${dayList}]) AS d
            )
            ${scopeFilter}
          GROUP BY ${scopeId}, (ar.ts_event AT TIME ZONE 'UTC')::date,
                   ar.tool, ar.model, ar.token_type, ar.query_source
        ), inserted AS (
          INSERT INTO attribution_aggregate
            (scope_type, scope_id, period_start, period_end, period_kind,
             tool, model, token_type, query_source,
             total_tokens, total_cost_usd, advisory_cost_usd, record_count, refresh_at)
          SELECT ${scope}, scope_id,
                 (day::timestamp AT TIME ZONE 'UTC'),
                 ((day + 1)::timestamp AT TIME ZONE 'UTC'),
                 'day', tool, model, token_type, query_source,
                 total_tokens, total_cost_usd, advisory_cost_usd, record_count, now()
          FROM cells
          ON CONFLICT (scope_type, scope_id, period_start, period_end, tool, model, token_type,
                       COALESCE(query_source, ''))
          DO UPDATE SET
            total_tokens = EXCLUDED.total_tokens,
            total_cost_usd = EXCLUDED.total_cost_usd,
            advisory_cost_usd = EXCLUDED.advisory_cost_usd,
            record_count = EXCLUDED.record_count,
            refresh_at = now()
          RETURNING 1
        )
        SELECT COUNT(*)::text AS n FROM inserted
      `)
      written = Number([...ins][0]?.n ?? 0)
    })
    return written
  }

  // ── Durable enriched rollup + session companion (mig 0053) ───────────────
  // Same DELETE+upsert-per-day-chunk shape as recomputeChunk, but at the full
  // contributor × activity grain, carrying point-in-time region/org/cou and the
  // cost_basis-keyed indicative split. The session companion captures
  // COUNT(DISTINCT conversation) per (teammate, project, day) — non-additive at
  // the spend grain, so a separate table. ON CONFLICT targets the COALESCE
  // expression indexes (0053). DELETE first makes conflicts impossible in normal
  // single-locked operation; the upsert is cross-run belt-and-braces.
  const SENTINEL = '00000000-0000-0000-0000-000000000000'
  const recomputeRollupChunk = async (chunk: string[]): Promise<{ rollup: number; session: number }> => {
    const dayList = sql.join(
      chunk.map((d) => sql`${d}::date`),
      sql`, `,
    )
    const minDay = chunk[0]!
    const maxDay = chunk[chunk.length - 1]!
    const tsRange = (alias: string): ReturnType<typeof sql> => sql`
      ${sql.raw(alias)}.ts_event >= (${minDay}::timestamp AT TIME ZONE 'UTC')
        AND ${sql.raw(alias)}.ts_event < ((${maxDay}::date + 1)::timestamp AT TIME ZONE 'UTC')
        AND (${sql.raw(alias)}.ts_event AT TIME ZONE 'UTC')::date IN (SELECT d FROM unnest(ARRAY[${dayList}]) AS d)`
    const dayPredicate = sql`period_start IN (SELECT (d::timestamp AT TIME ZONE 'UTC') FROM unnest(ARRAY[${dayList}]) AS d)`
    let rollup = 0
    let session = 0
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM spend_rollup_daily WHERE ${dayPredicate}`)
      const insR = await tx.execute<{ n: string }>(sql`
        WITH cells AS (
          SELECT (ar.ts_event AT TIME ZONE 'UTC')::date AS day,
                 ar.project_id, ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id,
                 ar.tool, ar.model, ar.token_type, ar.activity, ar.query_source,
                 SUM(ar.tokens) AS total_tokens,
                 SUM(ar.cost_usd) AS total_cost_usd,
                 COALESCE(SUM(ar.cost_usd) FILTER (WHERE ar.cost_basis = 'telemetry-only'), 0) AS indicative_cost_usd,
                 COUNT(*) AS record_count
          FROM attribution_record ar
          WHERE ${tsRange('ar')}
          GROUP BY day, ar.project_id, ar.teammate_id, ar.region_id, ar.org_unit_id,
                   ar.cost_owning_unit_id, ar.tool, ar.model, ar.token_type, ar.activity, ar.query_source
        ), inserted AS (
          INSERT INTO spend_rollup_daily
            (period_start, project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
             tool, model, token_type, activity, query_source,
             total_tokens, total_cost_usd, indicative_cost_usd, record_count, refresh_at)
          SELECT (day::timestamp AT TIME ZONE 'UTC'), project_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id,
                 tool, model, token_type, activity, query_source,
                 total_tokens, total_cost_usd, indicative_cost_usd, record_count, now()
          FROM cells
          ON CONFLICT (period_start, COALESCE(project_id, ${SENTINEL}::uuid), teammate_id, region_id, org_unit_id,
                       COALESCE(cost_owning_unit_id, ${SENTINEL}::uuid), tool, model, token_type,
                       COALESCE(activity, ''), COALESCE(query_source, ''))
          DO UPDATE SET total_tokens = EXCLUDED.total_tokens, total_cost_usd = EXCLUDED.total_cost_usd,
                        indicative_cost_usd = EXCLUDED.indicative_cost_usd, record_count = EXCLUDED.record_count,
                        refresh_at = now()
          RETURNING 1
        )
        SELECT COUNT(*)::text AS n FROM inserted
      `)
      rollup = Number([...insR][0]?.n ?? 0)

      await tx.execute(sql`DELETE FROM spend_session_daily WHERE ${dayPredicate}`)
      const insS = await tx.execute<{ n: string }>(sql`
        WITH cells AS (
          SELECT (ar.ts_event AT TIME ZONE 'UTC')::date AS day, ar.teammate_id, ar.project_id,
                 COUNT(DISTINCT COALESCE(ar.claude_session_id, ar.instance_id::text)) AS distinct_session_count
          FROM attribution_record ar
          WHERE ${tsRange('ar')}
          GROUP BY day, ar.teammate_id, ar.project_id
        ), inserted AS (
          INSERT INTO spend_session_daily (period_start, teammate_id, project_id, distinct_session_count, refresh_at)
          SELECT (day::timestamp AT TIME ZONE 'UTC'), teammate_id, project_id, distinct_session_count, now()
          FROM cells
          ON CONFLICT (period_start, teammate_id, COALESCE(project_id, ${SENTINEL}::uuid))
          DO UPDATE SET distinct_session_count = EXCLUDED.distinct_session_count, refresh_at = now()
          RETURNING 1
        )
        SELECT COUNT(*)::text AS n FROM inserted
      `)
      session = Number([...insS][0]?.n ?? 0)
    })
    return { rollup, session }
  }

  const chunks: string[][] = []
  for (let i = 0; i < days.length; i += CHUNK_DAYS) {
    chunks.push(days.slice(i, i + CHUNK_DAYS))
  }
  let teammateCells = 0
  let projectCells = 0
  let rollupCells = 0
  let sessionCells = 0
  for (const chunk of chunks) {
    teammateCells += await recomputeChunk('teammate', chunk)
    projectCells += await recomputeChunk('project', chunk)
    const r = await recomputeRollupChunk(chunk)
    rollupCells += r.rollup
    sessionCells += r.session
  }

  // Reaching here means every chunk committed without throwing — so a
  // backfill is now COMPLETE. Persisted to worker_run.result by run-health;
  // future runs read it (priorComplete) to stay out of backfill.
  return {
    mode: isBackfill ? 'backfill' : 'incremental',
    daysRecomputed: days.length,
    teammateCells,
    projectCells,
    rollupCells,
    sessionCells,
    backfillComplete: true,
  }
}
