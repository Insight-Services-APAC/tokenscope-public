/*
 * GET /api/v1/admin/diagnostics — read-only operational health snapshot.
 *
 * RBAC: admin / global-finops. Read-only — no mutations (no "restart
 * worker", no "drain queue") in Wave VI per scope.
 *
 * Each probe is wrapped in try/catch so one failure doesn't 500 the
 * whole endpoint. A probe's `reachable: false` is a useful signal —
 * surfacing the error message keeps the diagnostics page actionable.
 *
 * BullMQ / Redis are NOT wired in MVP-Final (no `redis` or `bullmq`
 * package in dependencies as of Wave V). The diagnostics endpoint
 * returns `unavailable: true` for those sections so the UI can render
 * a placeholder card without a dependency on a runtime that doesn't
 * exist yet.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { getTelemetryReader, type ReaderHealth } from '../../../../azure/reader'
// Canonical probe module — also run at boot by the entrypoint pre-flight.
// Lives in scripts/ (raw in the runtime image); nitro bundles it here at build.
import { probeServices, type ServiceProbe } from '../../../../../scripts/preflight'

interface MigrationRow extends Record<string, unknown> {
  name: string
  applied_at: string
}

interface LastSyncRow extends Record<string, unknown> {
  source: string
  ts: string | null
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin', 'global-finops')

  // ── Postgres ──────────────────────────────────────────────────────
  // Two independent probes inside ONE withRequestRls call (saves a
  // round-trip on the GUC set). SELECT 1 → reachability + latency;
  // _drizzle_migrations read → active-migration name. Each is in its
  // own try so a missing migration table (test-container bootstrap that
  // applies SQL without ever creating `_drizzle_migrations`) doesn't
  // mask the reachability signal. drizzle/migrate.ts:23-26 creates the
  // table at first boot in production, so the missing-table path is
  // exclusively a test concern.
  const pgStart = Date.now()
  let pgReachable = false
  let pgLatencyMs = 0
  let pgError: string | null = null
  let activeMigration: string | null = null
  try {
    await withRequestRls(event, async (tx) => {
      await tx.execute(sql`SELECT 1`)
      pgReachable = true
      try {
        const migRows = await tx.execute<MigrationRow>(sql`
          SELECT name, COALESCE(applied_at::text, '') AS applied_at
          FROM _drizzle_migrations
          ORDER BY applied_at DESC NULLS LAST
          LIMIT 1
        `)
        const row = [...migRows][0]
        if (row) activeMigration = row.name
      } catch (migErr) {
        // Table may not exist in test bootstrap; reachability is
        // already true from the SELECT 1 above. Report the migration
        // table state honestly rather than masking.
        const message = migErr instanceof Error ? migErr.message : String(migErr)
        if (/_drizzle_migrations/.test(message)) {
          activeMigration = 'unknown (migration marker table absent)'
        } else {
          // Genuine error reading the marker table — surface it.
          throw migErr
        }
      }
    })
    pgLatencyMs = Date.now() - pgStart
  } catch (err) {
    pgLatencyMs = Date.now() - pgStart
    pgError = err instanceof Error ? err.message : String(err)
  }

  // ── Redis (not wired in MVP-Final) ────────────────────────────────
  // The `redis` / `ioredis` packages aren't in the dependency tree as
  // of Wave V. Returning `unavailable: true` is honest; the UI renders
  // a placeholder.
  const redis = { unavailable: true as const, reason: 'redis not wired in MVP-Final' }

  // ── BullMQ queues (not wired in MVP-Final) ────────────────────────
  const queues = { unavailable: true as const, reason: 'bullmq not wired in MVP-Final' }

  // ── Last-sync per source ──────────────────────────────────────────
  // We have no sync_history table in MVP-Final. The closest signal is
  // teammate.last_sync_at + org_unit.last_sync_at. Aggregate by
  // source string — empty result when no sync rows exist (manual mode).
  let lastSync: { source: string; ts: string | null }[] = []
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<LastSyncRow>(sql`
        SELECT source, MAX(last_sync_at)::text AS ts
        FROM (
          SELECT source, last_sync_at FROM teammate WHERE last_sync_at IS NOT NULL
          UNION ALL
          SELECT source, last_sync_at FROM org_unit WHERE last_sync_at IS NOT NULL
        ) s
        GROUP BY source
        ORDER BY source
      `),
    )
    lastSync = [...rows].map((r) => ({ source: r.source, ts: r.ts }))
  } catch {
    // Non-fatal — leave lastSync as empty if the underlying tables
    // don't exist in this env (shouldn't happen in normal operation).
    lastSync = []
  }

  // ── Pipeline freshness (emit -> gather) ───────────────────────────
  // The signal that would have flagged the 12h silent-emission outage at a
  // glance. Two timestamps off the single-source ledger:
  //   lastUsageSeen   = MAX(ts_event)    — when the most recent USAGE happened
  //                     (emission freshness; stale => client stopped emitting
  //                     or the ingest path is dropping).
  //   lastLedgerWrite = MAX(ts_recorded) — when the joiner last WROTE a row
  //                     (gather freshness).
  // If usage is stale but the joiner keeps running (cron healthy), the break
  // is upstream in emit/ingest — exactly the failure mode that lost ~24h of
  // spend silently. Region admins see their own region; org-wide roles see all.
  const regionFilter =
    session.role === 'admin' ? sql`WHERE region_id = ${session.regionId}::uuid` : sql``
  let pipeline: {
    lastUsageSeen: string | null
    lastLedgerWrite: string | null
    usageAgeMinutes: number | null
    ledgerAgeMinutes: number | null
    status: 'ok' | 'warn' | 'stale' | 'unknown'
  } = { lastUsageSeen: null, lastLedgerWrite: null, usageAgeMinutes: null, ledgerAgeMinutes: null, status: 'unknown' }
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<{ last_usage: string | null; last_write: string | null }>(sql`
        SELECT MAX(ts_event)::text AS last_usage, MAX(ts_recorded)::text AS last_write
        FROM attribution_record ${regionFilter}
      `),
    )
    const r = [...rows][0]
    const now = Date.now()
    const ageMin = (ts: string | null): number | null =>
      ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000)) : null
    const usageAge = ageMin(r?.last_usage ?? null)
    const ledgerAge = ageMin(r?.last_write ?? null)
    // Heuristic RAG on usage freshness: emission can be naturally quiet, so the
    // thresholds are generous. ok < 1h, warn < 6h, stale >= 6h.
    const status: 'ok' | 'warn' | 'stale' | 'unknown' =
      usageAge == null ? 'unknown' : usageAge < 60 ? 'ok' : usageAge < 360 ? 'warn' : 'stale'
    pipeline = {
      lastUsageSeen: r?.last_usage ?? null,
      lastLedgerWrite: r?.last_write ?? null,
      usageAgeMinutes: usageAge,
      ledgerAgeMinutes: ledgerAge,
      status,
    }
  } catch {
    // Non-fatal — leave as unknown.
  }

  // ── Cost drift (rate-card vs Claude's own cost_usd, mig 0045) ──────
  // v_cost_drift compares our SUM(rate-card cost) against MAX(law cost) per
  // span for spans that captured metadata.law_cost_usd (post-0045 emission
  // only). A creeping mean drift = the rate card is stale — caught here
  // before reconciliation books the gap. 7-day window keeps the scan cheap
  // and recent-biased.
  let costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    worstSpan: { spanKey: string; model: string; rateCardCostUsd: string; lawCostUsd: string; driftUsd: string } | null
  } = { spansCompared: 0, meanAbsDriftPct: null, worstSpan: null }
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<{
        spans: string
        mean_abs_pct: string | null
        span_key: string | null
        model: string | null
        rate_card_cost_usd: string | null
        law_cost_usd: string | null
        drift_usd: string | null
      }>(sql`
        WITH windowed AS (
          SELECT * FROM v_cost_drift
          WHERE ts_event >= now() - interval '7 days' AND law_cost_usd > 0
        ),
        worst AS (
          SELECT * FROM windowed ORDER BY ABS(drift_usd) DESC LIMIT 1
        )
        SELECT
          (SELECT COUNT(*) FROM windowed)::text AS spans,
          (SELECT AVG(ABS(drift_usd) / law_cost_usd) * 100 FROM windowed)::text AS mean_abs_pct,
          w.span_key, w.model,
          w.rate_card_cost_usd::text AS rate_card_cost_usd,
          w.law_cost_usd::text AS law_cost_usd,
          w.drift_usd::text AS drift_usd
        FROM (SELECT 1) one
        LEFT JOIN worst w ON TRUE
      `),
    )
    const r = [...rows][0]
    const spans = Number(r?.spans ?? 0)
    costDrift = {
      spansCompared: spans,
      meanAbsDriftPct:
        r?.mean_abs_pct != null ? Number(Number(r.mean_abs_pct).toFixed(2)) : null,
      worstSpan:
        spans > 0 && r?.span_key != null
          ? {
              spanKey: r.span_key,
              model: r.model ?? 'unknown',
              rateCardCostUsd: r.rate_card_cost_usd ?? '0',
              lawCostUsd: r.law_cost_usd ?? '0',
              driftUsd: r.drift_usd ?? '0',
            }
          : null,
    }
  } catch {
    // Non-fatal — pre-0045 DBs have no view/rows; leave the zero shape.
  }

  // ── Worker execution health (outcome of each dispatch) ────────────
  // The signal the freshness panel CANNOT give: a worker cron that fails
  // every run. The freshness panel measures data recency (max ts_recorded)
  // and a partially-completing worker still advances it — so the joiner
  // cron once failed every run with a 504 while the panel showed green.
  // worker_run records each dispatch's outcome; here we read the latest run
  // per worker plus the count of TRAILING failures (newest-first run of
  // consecutive 'failure' rows) in ONE query — no N+1.
  //
  // Query shape:
  //   ranked        — runs numbered per worker, newest first.
  //   boundary      — per worker, the rank of the newest SUCCESS run. NULL ⇒
  //                   no run has ever succeeded. The streak terminates ONLY on
  //                   success: a trailing 'running' (a run that never
  //                   transitioned — killed/wedged) counts as non-success and
  //                   does NOT reset the failure streak beneath it. (Treating
  //                   any non-failure as the boundary masked a killed worker
  //                   sitting on a failure pile as consecutiveFailures=0.)
  //   consecutiveFailures = count of 'failure' runs ranked strictly NEWER than
  //                   that success boundary (the trailing failure streak).
  // The latest-per-worker projection (rn = 1) is joined to that streak count,
  // and the latest run's started_at is surfaced so the RAG can apply the
  // stale-running staleness rule below.
  let workers: {
    worker: string
    status: string
    finishedAt: string | null
    startedAt: string | null
    durationMs: number | null
    ageMinutes: number | null
    startedAgeMinutes: number | null
    consecutiveFailures: number
    rag: 'ok' | 'failing' | 'stale' | 'unknown'
  }[] = []
  // A 'running' row older than this is treated as wedged/killed (failing) — the
  // run never transitioned. Well past the 240s replica timeout so a genuinely
  // in-flight run is never falsely flagged.
  const STALE_RUNNING_MINUTES = 15
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<{
        worker_name: string
        status: string
        finished_at: string | null
        started_at: string
        duration_ms: number | null
        consecutive_failures: number
      }>(sql`
        WITH ranked AS (
          SELECT worker_name, status, finished_at, started_at, duration_ms,
                 ROW_NUMBER() OVER (PARTITION BY worker_name ORDER BY started_at DESC, id DESC) AS rn
          FROM worker_run
        ),
        boundary AS (
          SELECT worker_name, MIN(rn) AS first_success_rn
          FROM ranked
          WHERE status = 'success'
          GROUP BY worker_name
        ),
        streak AS (
          SELECT r.worker_name,
                 COUNT(*) FILTER (
                   WHERE r.status = 'failure'
                     AND r.rn < COALESCE(b.first_success_rn, 2147483647)
                 ) AS consecutive_failures
          FROM ranked r
          LEFT JOIN boundary b USING (worker_name)
          GROUP BY r.worker_name
        )
        SELECT r.worker_name,
               r.status,
               r.finished_at::text AS finished_at,
               r.started_at::text AS started_at,
               r.duration_ms,
               s.consecutive_failures::int AS consecutive_failures
        FROM ranked r
        JOIN streak s USING (worker_name)
        WHERE r.rn = 1
        ORDER BY r.worker_name
      `),
    )
    const now = Date.now()
    const ageMin = (ts: string | null): number | null =>
      ts ? Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000)) : null
    workers = [...rows].map((r) => {
      const consecutiveFailures = Number(r.consecutive_failures) || 0
      const startedAgeMinutes = ageMin(r.started_at ?? null)
      // RAG:
      //   - any trailing failure (under the newest success) ⇒ failing.
      //   - latest run 'success' ⇒ ok.
      //   - latest run 'running': a FRESH one (started < threshold) is genuinely
      //     in-progress ⇒ ok (in-progress); a STALE one (started ≥ threshold,
      //     never transitioned) is a killed/wedged worker ⇒ failing (red), NOT
      //     merely 'stale' (amber). This is the killed-mid-run signal.
      //   - otherwise unknown (no runs / unexpected status).
      let rag: 'ok' | 'failing' | 'stale' | 'unknown'
      if (consecutiveFailures >= 1) rag = 'failing'
      else if (r.status === 'success') rag = 'ok'
      else if (r.status === 'running') {
        rag =
          startedAgeMinutes != null && startedAgeMinutes >= STALE_RUNNING_MINUTES
            ? 'failing'
            : 'ok'
      } else rag = 'unknown'
      return {
        worker: r.worker_name,
        status: r.status,
        finishedAt: r.finished_at,
        startedAt: r.started_at ?? null,
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        ageMinutes: ageMin(r.finished_at ?? r.started_at),
        startedAgeMinutes,
        consecutiveFailures,
        rag,
      }
    })
  } catch {
    // Non-fatal — leave workers as an empty array (table may be absent in a
    // bootstrap env, or no worker has run yet).
    workers = []
  }

  // ── Infra reachability + telemetry read path (run concurrently) ────
  // services[]: TCP reachability of every provisioned private endpoint — the
  // SAME probe the entrypoint pre-flight runs at boot, surfaced so an operator
  // sees PG / Redis / KV connectivity at a glance, independent of whether app
  // code uses the service yet (Redis is provisioned for the future job-queue
  // tier). telemetryRead: a trivial KQL via the configured reader, validating
  // DNS → the (now private) query endpoint + workspace-API token acceptance
  // (LAW can't be meaningfully TCP-probed — its public frontend would mislead).
  // Both are bounded + non-throwing so a wedged dependency can't 500 or stall
  // this admin page beyond the probe timeout.
  type TelemetryReadResult = ReaderHealth | { ok: false; kind: 'unknown'; latencyMs: null; error: string }
  // Short timeouts (5s, incl. critical) for this INTERACTIVE page — the 30s
  // critical default is for boot (aligned with the migrate client), not a
  // human-facing request that must not hang on a wedged endpoint.
  const PAGE_PROBE_TIMEOUT_MS = 5000
  const [services, telemetryRead] = await Promise.all([
    probeServices(process.env, PAGE_PROBE_TIMEOUT_MS, PAGE_PROBE_TIMEOUT_MS).catch((): ServiceProbe[] => []),
    (async (): Promise<TelemetryReadResult> => {
      try {
        return await getTelemetryReader().healthCheck()
      } catch (err) {
        return { ok: false, kind: 'unknown', latencyMs: null, error: err instanceof Error ? err.message : String(err) }
      }
    })(),
  ])

  return {
    postgres: {
      reachable: pgReachable,
      latencyMs: pgLatencyMs,
      activeMigration,
      ...(pgError ? { error: pgError } : {}),
    },
    redis,
    queues,
    services,
    telemetryRead,
    pipeline,
    costDrift,
    workers,
    lastSync,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    containerInfo: {
      revision: process.env.CONTAINER_APP_REVISION ?? null,
    },
  }
})
