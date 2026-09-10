/*
 * Read-path-health worker — turns a SILENT OTel read-path outage into an inbox
 * alert.
 *
 * Why this exists (the 5.5-day incident): the azure-monitor-read gatherer (the
 * joiner that queries Log Analytics into attribution_record) stopped writing for
 * ~5.5 days with NO alarm. went-silent (server/workers/went-silent.ts) only
 * catches the WRITE/emit-credential side — a LIVE instance whose durable OAuth
 * credential is being rejected at /bearer (bearer-auth-failed). It is blind to
 * the opposite failure: the READER is dead while clients are still emitting fine.
 * The diagnostics freshness panel is also blind here — it measures DATA recency,
 * which is exactly what freezes when the reader dies, but it went green because a
 * partially-completing run still advanced it. This worker closes that gap.
 *
 * It reads the ALREADY-PERSISTED worker_run ledger (written by the run-worker
 * endpoint) — it does NOT re-run the gatherer. worker_run.result is the JoinResult
 * jsonb ({ sessionsProcessed, attributionRowsWritten, errors, ... }); the endpoint
 * also maps attributionRowsWritten -> worker_run.rows_affected (extractRowsAffected
 * in run-worker/[name].post.ts). We read rows_affected + the ingest-coverage
 * verdict (result->'sourceCoverage'->>'status') for the STALL streak and
 * result->>'errors' / result->>'sessionsProcessed' for the ALL-FAULT case.
 *
 * Fires (see decideReadPathAlert for the exact truth table + thresholds) when
 * ANY of these hold for worker_name = 'azure-monitor-read':
 *   - STALL:      a zero-write streak of >= N runs WHILE the DCR ingest pipeline
 *                 received rows the joiner did not land (DCR RowsReceived_Count,
 *                 an ingest-side metric INDEPENDENT of this reader's output — see
 *                 streakSourceCoverage / server/azure/dcr-metrics.ts). When the
 *                 coverage probe cannot measure, STALL falls back to the bearer
 *                 gate (fresh mints), which fails toward paging. This is the
 *                 exact "reader dead but clients still emitting" outage.
 *   - ALL-FAULT:  the latest run errored on EVERY session it processed.
 *   - NO-SUCCESS: no successful run in the recent window (the cron is dead /
 *                 every dispatch is failing outright).
 *
 * Idempotency (don't re-alert every 15-min tick) + auto-resolve on recovery,
 * modelled on went-silent (auto-resolve) + budget-alert (idempotency pre-check).
 * Admin-routed via dispatchInbox 'read-path-stale' (platform-admin).
 *
 * Recommended cadence: every ~15 min (registry). The actual cron is infra.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import type { SourceCoverageStatus } from '../azure/dcr-metrics'

const READER_WORKER = 'azure-monitor-read'

// ── Thresholds (named + commented so the trigger contract is auditable) ────────

// STALL: how many CONSECUTIVE most-recent runs must ALL have written 0 rows
// before we call it a stall. 3 keeps a single quiet tick (a genuine lull between
// emissions) from paging — three zero-write runs in a row while clients ARE
// emitting is the real "reader stuck" shape, not a lull. Read against the ~15-min
// cadence this is ~30-45 min of dead reads.
const STALL_MIN_ZERO_RUNS = 3

// STALL bearer FALLBACK gate. The primary STALL signal is the ingest-side
// coverage verdict (streakSourceCoverage). This bearer gate is consulted ONLY
// when coverage is 'unknown' (the probe could not measure: pre-deploy, a scoped
// streak, a 403 while Monitoring Reader is unassigned, a probe fault) — the same
// state 'main' paged on. MAX(instance_attestation.last_bearer_at) is the
// timestamp the /bearer emit-token mint endpoint stamps on every heartbeat (the
// WRITE / emit-auth side, INDEPENDENT of the read path's output). It is NOT
// usage — an editor left open mints all night and emits nothing (attribution-gap.ts
// says so), which is exactly why it is only the FALLBACK now and coverage is
// primary. Pre-mig-0030 instances have last_bearer_at IS NULL and don't
// contribute to the MAX.
const FLEET_EMITTING_FRESH_MS = 2 * 60 * 60 * 1000 // 2h

// NO-SUCCESS: alert if there has been no SUCCESSFUL azure-monitor-read run in
// this window. At a ~15-min cadence, 30 min = two missed/failed ticks — a dead
// cron or an outright-failing dispatch. Kept tight because a read-path that never
// succeeds is the most severe form of the outage. This is ALSO the leg that
// covers a THROWING reader: a run that throws records status='failure' with
// rows_affected=null (breaks the STALL zero-streak) and no result jsonb (ALL-FAULT
// can't read errors/sessionsProcessed) — so neither of those fire, and NO-SUCCESS
// is what catches it. Division of labour: STALL = silent zero-write SUCCESS;
// NO-SUCCESS = hard failure / throw; ALL-FAULT = per-session-fault storm.
const NO_SUCCESS_WINDOW_MS = 30 * 60 * 1000 // 30 min

// ALL-FAULT floor: require at least this many sessions processed before an
// all-errored run pages. A single ING-6-isolated flaky session (sessionsProcessed
// 1, errors 1) is transient noise, not a storm — pinning the floor at 2 stops one
// bad session from paging platform-admins urgent while still catching a real
// every-session-faulting run.
const ALL_FAULT_MIN_SESSIONS = 2

/*
 * A single azure-monitor-read run as read from the worker_run ledger, projected
 * to the fields the decision needs. Pure-function input — no DB types leak in.
 */
export interface ReaderRun {
  status: string // 'running' | 'success' | 'failure'
  startedAtMs: number
  // worker_run.rows_affected (== JoinResult.attributionRowsWritten). null on a
  // run that never recorded an outcome (legacy / bookkeeping miss) — treated as
  // "unknown", NOT as a zero-write for the stall streak (see decideReadPathAlert).
  rowsAffected: number | null
  // From worker_run.result (the JoinResult jsonb). null when absent.
  // sessionsProcessed is the size of the reader's SELECTION (JoinResult docs):
  // it includes every open instance with a fresh bearer, so an idle laptop is 1,
  // not 0. It feeds ALL-FAULT (errors vs sessions) and is NOT work evidence.
  sessionsProcessed: number | null
  errors: number | null
  /*
   * result->'sourceCoverage'->>'status' — the INGEST-SIDE coverage verdict for
   * this run's tick (server/azure/dcr-metrics.ts): did the DCR pipeline receive
   * rows the joiner did not land? THE work-evidence term for STALL, independent
   * of this reader's own output. null = not measured (a run recorded before the
   * probe shipped, a scoped/recovery run, or a thrown run with no result) —
   * unknown, and an unknown falls STALL back to the bearer gate (see
   * streakSourceCoverage / decideReadPathAlert).
   */
  sourceCoverage: SourceCoverageStatus | null
  /*
   * result->>'newEventsSeen' — DIAGNOSTIC only (folded from PR #316): usage
   * records the run saw past the instance watermark. It is the middle term of
   * the operator narrative "source received N · reader saw M new · wrote R"; it
   * is NOT read by any alert decision (that is sourceCoverage). null = absent.
   */
  newEventsSeen: number | null
}

/*
 * The consecutive most-recent zero-write streak: runs from the top whose
 * rows_affected is EXACTLY 0. A >0 run or a null (unknown outcome — a thrown
 * run, which we cannot claim as a zero-write) ends it. ONE definition, shared by
 * both stall decisions (docs/design/ops-alerting.md A2.2 makes the operator
 * page and the user banner evaluate one streak): the read-path-health STALL leg
 * previously sliced the top 3 while attribution-stall walked the full streak, so
 * identical history could clear one and hold the other, and evidence could age
 * out of the top-3 window mid-outage (external review of PR #316, findings 7/10).
 */
export function zeroWriteStreak<T extends { rowsAffected: number | null }>(runs: readonly T[]): T[] {
  let end = 0
  while (end < runs.length && runs[end]!.rowsAffected === 0) end += 1
  return runs.slice(0, end)
}

/*
 * The INGEST-SIDE coverage verdict over a zero-write streak — the ONE
 * work-evidence predicate both stall alerts share (imported by
 * attribution-stall.ts exactly as the loaders are). Did the DCR pipeline receive
 * rows the joiner did not land, anywhere in the streak?
 *   - 'rows-arrived' — some run's probe saw rows: a real backlog → page.
 *   - 'no-rows'      — no run saw rows but at least one measured empty: idle → quiet.
 *   - 'unknown'      — no run measured (all pre-probe / scoped / failed): the
 *                      decision falls back to the bearer gate (fails toward paging).
 * 'rows-arrived' wins over 'no-rows' wins over 'unknown': a single tick that saw
 * rows the joiner never landed is a backlog even if later probes read empty.
 * During an ACTIVE outage (clients still emitting) rows keep physically arriving,
 * so every tick RE-MEASURES 'rows-arrived' and the streak stays armed — unlike
 * PR #316's watermark count, which only the first run saw and which aged out.
 * The residual: once the source truly goes quiet (a burst the reader never
 * landed, then the editor closes and ingestion stops), later probes read
 * 'no-rows' and, after the run that saw rows scrolls out of the loaded window,
 * the stall clears — a backlog that OUTLIVES ingestion is the recovery lane's
 * (attribution-gap 72h / telemetry-recovery), not the 90-minute stall's.
 */
export function streakSourceCoverage(
  streak: ReadonlyArray<{ sourceCoverage: SourceCoverageStatus | null }>,
): SourceCoverageStatus {
  if (streak.some((r) => r.sourceCoverage === 'rows-arrived')) return 'rows-arrived'
  if (streak.some((r) => r.sourceCoverage === 'no-rows')) return 'no-rows'
  return 'unknown'
}

/** True iff the streak's coverage is 'rows-arrived' — the DCR received rows the
 *  joiner did not land. The single, positive work-evidence predicate; 'no-rows'
 *  (idle) and 'unknown' (unmeasured) are both false. */
export function hasWorkEvidenceCoverage(
  streak: ReadonlyArray<{ sourceCoverage: SourceCoverageStatus | null }>,
): boolean {
  return streakSourceCoverage(streak) === 'rows-arrived'
}

export type ReadPathAlertReason = 'stall' | 'all-fault' | 'no-success'

/*
 * WHY a STALL fired, for the inbox body + reasonSummary (alert-diagnosability
 * D1). 'source-backlog' — the DCR received rows the joiner did not land.
 * 'coverage-unknown-bearer-fresh' — the probe could not measure, so we fell back
 * to the bearer gate (today's behaviour): the estate LOOKS idle but the fleet is
 * minting, and A2.1 is already paging for the same probe outage.
 */
export type StallCoverageBasis = 'source-backlog' | 'coverage-unknown-bearer-fresh'

export interface ReadPathDecision {
  fire: boolean
  reason: ReadPathAlertReason | null
  /** Present when reason === 'stall': which coverage basis fired it. */
  coverageBasis?: StallCoverageBasis
}

export interface DecideInput {
  // Recent azure-monitor-read runs, MOST-RECENT FIRST (started_at DESC).
  runs: ReaderRun[]
  // MAX(instance_attestation.last_bearer_at) epoch-ms — the freshest emit-token
  // MINT across the fleet (the WRITE / emit-auth side, INDEPENDENT of the read
  // path's own output). null if no instance has ever minted. See
  // FLEET_EMITTING_FRESH_MS for why this must NOT be reader output (ts_event).
  lastFleetEmitMs: number | null
  // Decision clock (injected for determinism).
  nowMs: number
}

/*
 * PURE trigger-decision logic — no DB, unit-testable in isolation. Given the
 * recent run ledger + last-seen usage + a clock, decide whether to fire and why.
 * Reason precedence (most-diagnostic first): all-fault > stall > no-success.
 * That order is deliberate: ALL-FAULT names a concrete run that blew up on every
 * session (most actionable); STALL is the silent-zero-write shape; NO-SUCCESS is
 * the broad "nothing is completing" catch-all. Only ONE reason is reported.
 */
export function decideReadPathAlert(input: DecideInput): ReadPathDecision {
  const { runs, lastFleetEmitMs, nowMs } = input

  // ── ALL-FAULT: the LATEST run errored on every session it processed. ──
  // errors >= sessionsProcessed AND sessionsProcessed >= ALL_FAULT_MIN_SESSIONS
  // — a run that touched >= 2 sessions but faulted on all of them (per-session
  // isolation caught them, so the run "succeeded" while writing nothing useful).
  // The floor excludes a clean 0-session tick AND a single transient flaky
  // session (sessionsProcessed 1, errors 1) — that's noise, not a storm.
  const latest = runs[0]
  if (
    latest &&
    latest.sessionsProcessed !== null &&
    latest.errors !== null &&
    latest.sessionsProcessed >= ALL_FAULT_MIN_SESSIONS &&
    latest.errors >= latest.sessionsProcessed
  ) {
    return { fire: true, reason: 'all-fault' }
  }

  // ── STALL: a zero-write streak of >= STALL_MIN_ZERO_RUNS runs, gated on the ──
  // INGEST-SIDE coverage signal (streakSourceCoverage), NOT the reader's own
  // output. The streak is the full consecutive zero-write run (shared
  // zeroWriteStreak), not the top-3 slice — so evidence cannot age out of one
  // window mid-outage (external review findings 7/10).
  //   - coverage 'rows-arrived' → the pipeline received rows the joiner did not
  //     land: a real backlog. Page REGARDLESS of the bearer (a burst the reader
  //     never landed, then the editor closed, is still a stall).
  //   - coverage 'no-rows' → nothing arrived: the idle-but-open-editor estate.
  //     NEVER a stall — this is the false positive PR #316 tried and failed to
  //     close, and the reason read-path-stale paged Dev 7×/24h.
  //   - coverage 'unknown' → the probe could not measure (pre-deploy, a scoped
  //     streak, a 403 while the role is unassigned, a probe fault). Fall back to
  //     today's bearer gate: fresh mints → page. Fails toward paging, and A2.1
  //     is already paging for a probe/LA outage.
  const streak = zeroWriteStreak(runs)
  if (streak.length >= STALL_MIN_ZERO_RUNS) {
    const coverage = streakSourceCoverage(streak)
    if (coverage === 'rows-arrived') {
      return { fire: true, reason: 'stall', coverageBasis: 'source-backlog' }
    }
    if (coverage === 'unknown') {
      const fleetEmitting =
        lastFleetEmitMs !== null && nowMs - lastFleetEmitMs <= FLEET_EMITTING_FRESH_MS
      if (fleetEmitting) {
        return { fire: true, reason: 'stall', coverageBasis: 'coverage-unknown-bearer-fresh' }
      }
    }
    // coverage === 'no-rows' → idle estate; do not fire on the stall leg.
  }

  // ── NO-SUCCESS: no successful run within NO_SUCCESS_WINDOW_MS. ──
  // The cron is dead or every dispatch is failing. Guard: only meaningful once
  // there is at least one run on record (a brand-new deploy with an empty ledger
  // is "unknown", not "outage" — don't page on first boot before any run).
  if (runs.length > 0) {
    const hasRecentSuccess = runs.some(
      (r) => r.status === 'success' && nowMs - r.startedAtMs <= NO_SUCCESS_WINDOW_MS,
    )
    if (!hasRecentSuccess) {
      return { fire: true, reason: 'no-success' }
    }
  }

  return { fire: false, reason: null }
}

// Human-readable one-liner per reason for the inbox subject/body.
function reasonSummary(reason: ReadPathAlertReason, coverageBasis?: StallCoverageBasis): string {
  switch (reason) {
    case 'stall':
      return coverageBasis === 'coverage-unknown-bearer-fresh'
        ? `The OTel read path wrote 0 rows for ${STALL_MIN_ZERO_RUNS}+ runs while the fleet is still minting bearers, and the ingest-coverage probe could not measure — falling back to the bearer gate. Check the DCR metrics probe (Monitoring Reader on the DCR) and A2.1 telemetry-read.`
        : `The OTel read path wrote 0 rows for ${STALL_MIN_ZERO_RUNS}+ runs although the ingest pipeline received rows it has not attributed (DCR RowsReceived_Count) — the reader looks stuck.`
    case 'all-fault':
      return 'The latest OTel read-path run errored on every session it processed — no attribution is landing.'
    case 'no-success':
      return `No successful OTel read-path run in the last ${Math.round(NO_SUCCESS_WINDOW_MS / 60000)} min — the reader cron looks dead or is failing every dispatch.`
  }
}

export interface ReadPathHealthResult {
  reason: ReadPathAlertReason | null
  alertsDispatched: number
  skippedExisting: number
  autoResolved: number
}

/*
 * How many recent runs to load for the decision. STALL only needs the top
 * STALL_MIN_ZERO_RUNS; NO-SUCCESS needs enough to find a recent success — a small
 * fixed cap keeps this O(1) and is plenty (at ~15-min cadence, 20 rows ≈ 5h).
 */
const RUN_LOAD_LIMIT = 20

/*
 * Recent azure-monitor-read runs, most-recent first — SHARED with the ops-alert
 * worker's attribution-stall condition (docs/design/ops-alerting.md A2.2 reuses
 * this worker's signals by helper, not by copy). Extracted verbatim from
 * runReadPathHealth; the query semantics (scoped-run and running-row exclusion)
 * are part of this worker's contract and must not fork per consumer.
 *
 * Model on shouldDeepRescan's worker_run query + the diagnostics workers-RAG
 * SQL: read rows_affected and the result jsonb's errors/sessionsProcessed/
 * sourceCoverage/newEventsSeen. All are cast from the jsonb text — NULL-safe (a
 * missing key yields NULL, not 0). For sourceCoverage that NULL is load-bearing:
 * a run recorded before the probe shipped must read as UNKNOWN, never as "no
 * rows" (streakSourceCoverage → bearer fallback).
 */
export async function loadReaderRuns(
  db: PostgresJsDatabase<typeof schema>,
  limit: number = RUN_LOAD_LIMIT,
): Promise<ReaderRun[]> {
  const runRows = await db.execute<{
    status: string
    started_at_ms: string
    rows_affected: number | null
    sessions_processed: string | null
    errors: string | null
    source_coverage: string | null
    new_events_seen: string | null
  }>(sql`
    SELECT status,
           (EXTRACT(EPOCH FROM started_at) * 1000)::bigint::text AS started_at_ms,
           rows_affected,
           (result->>'sessionsProcessed') AS sessions_processed,
           (result->>'errors') AS errors,
           -- The ingest-coverage verdict (JoinResult.sourceCoverage.status).
           -- NULL when absent (pre-probe / scoped / thrown run) is load-bearing:
           -- it must read as UNKNOWN, never as "no rows" (streakSourceCoverage).
           (result->'sourceCoverage'->>'status') AS source_coverage,
           (result->>'newEventsSeen') AS new_events_seen
      FROM worker_run
     WHERE worker_name = ${READER_WORKER}
       -- SCOPED runs (an operator recovery batch over explicit instance ids) are
       -- NOT evidence about the scheduled read path. They are successful and
       -- row-writing by construction, so counting them would (a) break the
       -- zero-write STALL streak and (b) satisfy the recent-success check —
       -- silently AUTO-RESOLVING an open read-path-stale alert in the middle of
       -- an outage, which is the one thing this worker must never do. A recovery
       -- campaign runs many such batches back to back, exactly when the
       -- scheduled reader is most likely to be struggling.
       AND (result->>'scoped') IS DISTINCT FROM 'true'
       -- An IN-FLIGHT run carries no outcome yet: dispatchWorker inserts the row
       -- at START ('running', result NULL) and only writes the result column —
       -- including the scoped flag — at completion. So a running scoped batch slips
       -- past the filter above, and its NULL rows_affected breaks the zero-write STALL
       -- streak → the open alert auto-resolves mid-outage. No decision leg wants
       -- an unfinished run: NO-SUCCESS looks only for status='success', and the
       -- runs.length guard is satisfied by completed failures.
       AND status <> 'running'
     ORDER BY started_at DESC, id DESC
     LIMIT ${limit}
  `)

  return [...runRows].map((r) => ({
    status: r.status,
    startedAtMs: Number(r.started_at_ms),
    rowsAffected: r.rows_affected === null ? null : Number(r.rows_affected),
    sessionsProcessed: r.sessions_processed === null ? null : Number(r.sessions_processed),
    errors: r.errors === null ? null : Number(r.errors),
    sourceCoverage: normaliseCoverageStatus(r.source_coverage),
    newEventsSeen: r.new_events_seen === null ? null : Number(r.new_events_seen),
  }))
}

/*
 * The jsonb text `result->'sourceCoverage'->>'status'` is a free-form string at
 * rest — validate it against the closed status union before it reaches a
 * decision. An unrecognised value (a future status, corruption) reads as null =
 * UNKNOWN, which is the fail-safe direction (bearer fallback → paging).
 */
function normaliseCoverageStatus(value: string | null): SourceCoverageStatus | null {
  return value === 'rows-arrived' || value === 'no-rows' || value === 'unknown' ? value : null
}

/*
 * "Is the fleet still emitting?" — SHARED with the ops-alert worker's
 * attribution-stall condition, same extraction rationale as loadReaderRuns.
 */
export async function loadLastFleetEmitMs(
  db: PostgresJsDatabase<typeof schema>,
): Promise<number | null> {
  // Measured with the INDEPENDENT write/emit-auth signal (see
  // FLEET_EMITTING_FRESH_MS), NOT the read path's own output. Each
  // /bearer emit-token mint stamps instance_attestation.last_bearer_at, so this
  // MAX keeps advancing throughout a read-path outage while clients keep emitting,
  // and only ages out when the fleet genuinely goes quiet. This is what stops the
  // alert from falsely auto-resolving mid-outage (the HIGH the ts_event version
  // had). NULL last_bearer_at rows (pre-mig-0030) simply don't contribute to MAX.
  const emitRows = await db.execute<{ last_ms: string | null }>(sql`
    SELECT (EXTRACT(EPOCH FROM MAX(last_bearer_at)) * 1000)::bigint::text AS last_ms
      FROM instance_attestation
  `)
  const lastRaw = [...emitRows][0]?.last_ms ?? null
  return lastRaw === null ? null : Number(lastRaw)
}

/*
 * CONCURRENCY CONTRACT: this worker MUST run under the per-worker dispatch lock
 * (server/workers/dispatch-lock.ts), which the run-worker HTTP endpoint acquires
 * before every dispatch. The idempotency check below (SELECT an open alert →
 * dispatchInbox) is a NON-ATOMIC check-then-insert; it is safe ONLY because the
 * name-scoped lock serializes read-path-health runs, so two concurrent ticks
 * can't both pass the "no open alert" check and double-insert. This is the same
 * contract went-silent + budget-alert rely on. Do NOT run this worker unlocked —
 * in particular the scripts/run-worker.ts CLI path is UNLOCKED and is for
 * single-shot manual/dev use only, never concurrent.
 */
export async function runReadPathHealth(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<ReadPathHealthResult> {
  const now = opts?.now ?? new Date()

  const runs = await loadReaderRuns(db)
  const lastFleetEmitMs = await loadLastFleetEmitMs(db)

  const decision = decideReadPathAlert({ runs, lastFleetEmitMs, nowMs: now.getTime() })

  // ── Auto-resolve on recovery (modelled on went-silent step 1) ──────────────
  // Any OPEN read-path-stale alert is resolved the moment the decision says
  // healthy. A single global read path => a single logical alert; related_entity
  // is 'read-path'/READER_WORKER so dedup + resolve key on it.
  let autoResolved = 0
  if (!decision.fire) {
    const resolved = await db.execute<{ id: string }>(sql`
      UPDATE inbox_item ii
         SET ack_state = 'resolved', ack_at = ${now.toISOString()}::timestamptz
       WHERE ii.category = 'read-path-stale'
         AND ii.related_entity_kind = 'read-path'
         AND ii.ack_state IN ('unread', 'read', 'acknowledged')
      RETURNING ii.id::text AS id
    `)
    autoResolved = [...resolved].length
    return { reason: null, alertsDispatched: 0, skippedExisting: 0, autoResolved }
  }

  const reason = decision.reason!

  // ── Idempotency pre-check (modelled on budget-alert) ───────────────────────
  // Don't re-alert every tick: skip if an OPEN read-path-stale alert already
  // exists. One open alert per outage EPISODE — it stays until the read path
  // recovers (auto-resolve above) or an admin resolves it. Recipient-agnostic
  // (the dispatcher fans out to the stable cross-region admin set), so a single
  // open item covers the whole platform.
  const existing = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = 'read-path-stale'
       AND related_entity_kind = 'read-path'
       AND ack_state IN ('unread', 'read', 'acknowledged')
     LIMIT 1
  `)
  if (existing.length > 0) {
    return { reason, alertsDispatched: 0, skippedExisting: 1, autoResolved }
  }

  const dispatched = await dispatchInbox(db, {
    category: 'read-path-stale',
    severity: 'urgent',
    subject: 'TokenScope OTel read path has stalled — spend is not attributing',
    body: {
      reason,
      // Present for a stall: which coverage basis fired it (D1). Lets an
      // operator tell "the pipeline received rows we did not land" from "the
      // probe could not measure, so we paged on the bearer".
      ...(decision.coverageBasis ? { coverageBasis: decision.coverageBasis } : {}),
      worker: READER_WORKER,
      summary: reasonSummary(reason, decision.coverageBasis),
      detectedAt: now.toISOString(),
      hint: 'The azure-monitor-read gatherer is not landing attribution while clients emit. Check the run-worker dispatch (worker_run + diagnostics), then force a full re-read with a one-off ACA job execution: DEEP_RESCAN=true against azure-monitor-read.',
    },
    relatedEntityKind: 'read-path',
    // No relatedEntityId — the read path is a global singleton, not an entity
    // row. dispatchInbox drops a non-UUID id to null (it validates isUuid), so
    // omitting it is safe; routing is category-driven (resolveAdmins(null)).
  })

  return {
    reason,
    alertsDispatched: dispatched.length > 0 ? 1 : 0,
    skippedExisting: 0,
    autoResolved,
  }
}
