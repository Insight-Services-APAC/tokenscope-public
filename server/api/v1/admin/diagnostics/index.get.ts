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
import {
  classifyDispatchDuration,
  dispatchBudgetReason as dispatchBudgetReasonFor,
  DISPATCH_TIMEOUT_MS,
  type DispatchBudgetState,
} from '#shared/workers/dispatch-budget'
import { classifyProbeError } from '../../../../utils/redact-probe-error'
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
  let pgError: string | null = null
  let pgErrorCorrelationId: string | null = null
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
  } catch (err) {
    const classified = classifyProbeError(err, 'diagnostics:postgres')
    pgError = classified.reason
    pgErrorCorrelationId = classified.correlationId
  }
  const pgLatencyMs = Date.now() - pgStart

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
    // Non-fatal — leave lastSync as empty (from the initializer) if the
    // underlying tables don't exist in this env (shouldn't happen normally).
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

  // ── Cost drift (our rate-card estimate vs the provider, migs 0045/0091) ──
  // v_cost_drift compares our rate-card ESTIMATE against the PROVIDER's own
  // figure, per span, across both cost vintages: pre-cutover rows where
  // cost_usd is the estimate, and provider-priced rows where cost_usd is the
  // provider's number and the estimate rides in metadata.rate_card_cost_usd
  // (mig 0091 owns that branching; this endpoint just reads the columns).
  // A creeping mean drift = the rate card is stale — caught here before
  // reconciliation books the gap. 7-day window keeps the scan cheap and
  // recent-biased, and prunes to one or two monthly partitions.
  //
  // NOTE the drift card and the costing-rung card below answer DIFFERENT
  // questions and must not be conflated: drift asks "how wrong is the rate
  // card", rungs ask "did we have to USE it". A fleet can be entirely
  // provider-priced (rungs green) while drift is 50% — that is the healthy
  // state, and it is exactly the number the rate card is still needed for
  // (slicing a span total across token types).
  let costDrift: {
    spansCompared: number
    meanAbsDriftPct: number | null
    /** Per-vintage split of spansCompared — 'mixed' spans count as provider. */
    providerPricedSpans: number
    rateCardPricedSpans: number
    worstSpan: {
      spanKey: string
      model: string
      rateCardCostUsd: string
      lawCostUsd: string
      driftUsd: string
      pricedBy: string
    } | null
  } = {
    spansCompared: 0,
    meanAbsDriftPct: null,
    providerPricedSpans: 0,
    rateCardPricedSpans: 0,
    worstSpan: null,
  }
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<{
        spans: string
        provider_spans: string
        rate_card_spans: string
        mean_abs_pct: string | null
        span_key: string | null
        model: string | null
        rate_card_cost_usd: string | null
        law_cost_usd: string | null
        drift_usd: string | null
        priced_by: string | null
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
          (SELECT COUNT(*) FROM windowed WHERE priced_by <> 'rate-card')::text AS provider_spans,
          (SELECT COUNT(*) FROM windowed WHERE priced_by = 'rate-card')::text AS rate_card_spans,
          (SELECT AVG(ABS(drift_usd) / law_cost_usd) * 100 FROM windowed)::text AS mean_abs_pct,
          w.span_key, w.model,
          w.rate_card_cost_usd::text AS rate_card_cost_usd,
          w.law_cost_usd::text AS law_cost_usd,
          w.drift_usd::text AS drift_usd,
          w.priced_by
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
      providerPricedSpans: Number(r?.provider_spans ?? 0),
      rateCardPricedSpans: Number(r?.rate_card_spans ?? 0),
      worstSpan:
        spans > 0 && r?.span_key != null
          ? {
              spanKey: r.span_key,
              model: r.model ?? 'unknown',
              rateCardCostUsd: r.rate_card_cost_usd ?? '0',
              lawCostUsd: r.law_cost_usd ?? '0',
              driftUsd: r.drift_usd ?? '0',
              pricedBy: r.priced_by ?? 'unknown',
            }
          : null,
    }
  } catch {
    // Non-fatal — pre-0045 DBs have no view/rows; leave the zero shape.
  }

  // ── Costing rungs (which rung priced real spend) ───────────────────
  // docs/design/provider-cost-precedence.md §"Making it visible": the ladder is
  //   1. the provider's reported cost   2. the rate card   3. skip the span
  // and "a healthy fleet is ENTIRELY provider. Any other rung costing a real
  // span is unexpected enough to ALERT on, not merely to count."
  //
  // Sourced from attribution_record.cost_basis, NOT from the joiner's per-run
  // costingRungs counters: those are transient (they live for the length of one
  // worker run and are gone), while cost_basis is the persisted, queryable truth
  // and survives a restart, a redeploy and a missed alert. A rung that fired
  // three days ago is still visible here; the counter is not.
  //
  // Grain is the SPAN, not the row: one api_request explodes into up to four
  // token-type rows, and counting rows would make a cache-heavy span look four
  // times as alarming as a plain one. Same span key the drift view groups on.
  //
  // Scoped to tool='claude-code'. Copilot is untouched by the provider-cost
  // change — it is priced from AI credits and never used a rate card (design
  // §"Where cost comes from") — so including it would park a permanent
  // non-provider bucket on the card and train operators to ignore red.
  //
  // Region admins see their own region (same explicit filter the pipeline block
  // uses: the RLS policy treats 'admin' as org-wide, so scoping is the app's job).
  const regionAnd =
    session.role === 'admin' ? sql`AND region_id = ${session.regionId}::uuid` : sql``
  const COSTING_WINDOW_DAYS = 7
  let costingRungs: {
    windowDays: number
    spans: number
    provider: number
    rateCard: number
    other: number
    /**
     * provider + rateCard — the spans the LADDER actually priced, and the
     * denominator of rateCardPct. See the comment where it is computed.
     */
    ladderSpans: number
    rateCardPct: number | null
    fallbackModels: { model: string; spans: number }[]
  } = {
    windowDays: COSTING_WINDOW_DAYS,
    spans: 0,
    provider: 0,
    rateCard: 0,
    other: 0,
    ladderSpans: 0,
    rateCardPct: null,
    fallbackModels: [],
  }
  try {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<{
        spans: string
        provider_spans: string
        rate_card_spans: string
        other_spans: string
        fallback_models: { model: string; spans: number }[] | null
      }>(sql`
        WITH span AS (
          SELECT
            MAX(model) AS model,
            -- A span is provider-priced if ANY of its rows says so; the rows of
            -- one api_request are priced together, and a half-and-half span
            -- (written across the cutover) is a provider span with stragglers,
            -- not a fallback.
            --
            -- DELIBERATELY NARROWER THAN v_cost_drift's predicate, which also
            -- treats a NULL rate_card_id as provider-priced (mig 0091). The two
            -- want opposite failure directions. The view's risk is a
            -- TAUTOLOGICAL ZERO — reading a provider figure as an estimate and
            -- reporting no drift — so it detects broadly. This counter's risk is
            -- a FALSE GREEN: claiming the provider priced a span it did not,
            -- which would silence the alert the design exists to raise. So it
            -- believes only the explicit marker. The cost of the narrower test
            -- is that a backfilled provider-priced span (cost_basis carries
            -- 'telemetry-only' for that provenance, not the rung) lands in the
            -- "other" bucket rather than "provider" — an undercount that can
            -- only make the card noisier, never quieter.
            bool_or(cost_basis = 'provider-reported') AS any_provider,
            -- 'estimated' is the rate-card rung. Anything else that is not
            -- provider-reported ('telemetry-only' backfill provenance) is
            -- neither rung and lands in the "other" bucket rather than being
            -- silently folded into the alerting one.
            bool_or(cost_basis = 'estimated') AS any_estimated
          FROM attribution_record
          WHERE tool = 'claude-code'
            AND ts_event >= now() - make_interval(days => ${COSTING_WINDOW_DAYS}::int)
            ${regionAnd}
          GROUP BY instance_id, COALESCE(claude_session_id, ''), ts_event, COALESCE(source_run_id, '')
        ),
        totals AS (
          SELECT
            COUNT(*)::text AS spans,
            COUNT(*) FILTER (WHERE any_provider)::text AS provider_spans,
            COUNT(*) FILTER (WHERE NOT any_provider AND any_estimated)::text AS rate_card_spans,
            COUNT(*) FILTER (WHERE NOT any_provider AND NOT any_estimated)::text AS other_spans
          FROM span
        ),
        fallback AS (
          SELECT model, COUNT(*)::int AS spans
          FROM span
          WHERE NOT any_provider AND any_estimated
          GROUP BY model
          ORDER BY COUNT(*) DESC, model
          LIMIT 5
        )
        SELECT
          t.spans, t.provider_spans, t.rate_card_spans, t.other_spans,
          COALESCE(
            (SELECT json_agg(json_build_object('model', f.model, 'spans', f.spans)) FROM fallback f),
            '[]'::json
          ) AS fallback_models
        FROM totals t
      `),
    )
    const r = [...rows][0]
    const spans = Number(r?.spans ?? 0)
    const rateCard = Number(r?.rate_card_spans ?? 0)
    const provider = Number(r?.provider_spans ?? 0)
    /*
     * DENOMINATOR = provider + rateCard, NOT every span in the window.
     *
     * The question this figure answers is "of the spans the precedence ladder
     * priced, what share did our own rate card have to price?" — so only the two
     * ladder buckets belong underneath it. The `other` bucket is neither rung:
     * it is backfill provenance (cost_basis 'telemetry-only'), and a backfill
     * campaign is exactly the kind of thing an operator kicks off during an
     * incident. Counting it in the denominator would let heavy backfill traffic
     * mechanically shrink this percentage while the number of real fallbacks was
     * unchanged or rising — softening the alert precisely when it is most needed.
     * `spans`, `provider`, `rateCard` and `other` are all still reported, so the
     * broader share is one subtraction away for anyone who wants it.
     */
    const ladderSpans = provider + rateCard
    costingRungs = {
      windowDays: COSTING_WINDOW_DAYS,
      spans,
      provider,
      rateCard,
      other: Number(r?.other_spans ?? 0),
      ladderSpans,
      rateCardPct: ladderSpans > 0 ? Number(((rateCard / ladderSpans) * 100).toFixed(2)) : null,
      fallbackModels: (r?.fallback_models ?? []).map((m) => ({
        model: m.model,
        spans: Number(m.spans),
      })),
    }
  } catch {
    // Non-fatal — leave the zero shape (an env with no attribution rows yet).
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
    /**
     * How the last run's duration sits against the dispatch budget. The ledger
     * and the platform disagree about a worker that OVERRUNS: the work finished
     * and wrote `success` here, while the cron trigger gave up waiting and the
     * platform recorded a FAILED execution and retried. Without this, that
     * worker reads `ok` on this card and red in Azure, and only someone holding
     * both views can tell. Null when the duration is unknown.
     */
    dispatchBudget: DispatchBudgetState | null
    /** Plain-language reason when dispatchBudget is 'near' or 'over'. */
    dispatchBudgetReason: string | null
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
      // Non-finite collapses to null, not NaN. Two reasons: the SSR payload is
      // serialised with devalue, which preserves NaN faithfully all the way to a
      // rendered "NaNms" (plain JSON would have turned it into null); and leaving it
      // would let durationMs claim a value while dispatchBudget below says null —
      // two fields on the same row disagreeing about whether the duration is known.
      const rawDuration = r.duration_ms == null ? null : Number(r.duration_ms)
      const durationMs = rawDuration != null && Number.isFinite(rawDuration) ? rawDuration : null
      const dispatchBudget = classifyDispatchDuration(durationMs)
      return {
        worker: r.worker_name,
        status: r.status,
        finishedAt: r.finished_at,
        startedAt: r.started_at ?? null,
        durationMs,
        ageMinutes: ageMin(r.finished_at ?? r.started_at),
        startedAgeMinutes,
        consecutiveFailures,
        rag,
        dispatchBudget,
        dispatchBudgetReason: dispatchBudgetReasonFor(dispatchBudget, durationMs),
      }
    })
  } catch {
    // Non-fatal — leave workers as an empty array (from the initializer): the
    // table may be absent in a bootstrap env, or no worker has run yet.
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
  type TelemetryReadResult =
    | ReaderHealth
    | { ok: false; kind: 'unknown'; latencyMs: null; error: string; correlationId: string }
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
        const { reason, correlationId } = classifyProbeError(err, 'diagnostics:telemetry-read')
        return { ok: false, kind: 'unknown', latencyMs: null, error: reason, correlationId }
      }
    })(),
  ])

  return {
    postgres: {
      reachable: pgReachable,
      latencyMs: pgLatencyMs,
      activeMigration,
      ...(pgError ? { error: pgError, errorCorrelationId: pgErrorCorrelationId } : {}),
    },
    redis,
    queues,
    services,
    telemetryRead,
    pipeline,
    costDrift,
    costingRungs,
    workers,
    // The budget each worker's duration is judged against, so the card can name
    // the threshold instead of hard-coding a number that would drift from the
    // bicep the moment either changed.
    dispatchBudgetMs: DISPATCH_TIMEOUT_MS,
    lastSync,
    nodeEnv: process.env.NODE_ENV ?? 'development',
    containerInfo: {
      revision: process.env.CONTAINER_APP_REVISION ?? null,
    },
  }
})
