/*
 * Worker registry — single source of truth mapping worker name to its
 * runner function. Used by both the internal HTTP endpoint
 * (POST /api/v1/internal/run-worker/{name}) and the run-worker CLI
 * (scripts/run-worker.ts).
 *
 * To add a new worker:
 *   1. Implement and export `runFoo` in server/workers/foo.ts.
 *   2. Add `{ name: 'foo', run: runFoo }` to WORKERS below.
 *   3. Document the recommended cron cadence in the external scheduler
 *      config (docs/build/worker-scheduler.md).
 *
 * Why a static registry instead of dynamic discovery: predictability.
 * The set of runnable worker names is auditable in one place, and the
 * HTTP endpoint can reject unknown names without ever loading their
 * code.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { runAggregateRollup } from './aggregate-rollup'
import { runArchiveLedger } from './archive-ledger'
import { runAnalyticsPollReconciledOrgs } from './analytics-poller'
import { runPlacementSync } from './placement-sync'
import { runRegionReenrichment } from './region-reenrichment'
import { runPrivilegedIdentityCleanup } from './privileged-identity-cleanup'
import { runPendingPlacementGc } from './pending-placement-gc'
import { runReadJoiner, selectRecentJoinableSessionIds, shouldDeepRescan } from './azure-monitor-reader'
import { runBudgetAlert } from './budget-alert'
import { runConnectorHealth } from './connector-health'
import { runEndingSoon } from './ending-soon'
import { runHeartbeatCoverage } from './heartbeat-coverage'
import { runMitigationQuery } from './mitigation-query'
import { runReconciliation } from './reconciliation'
import { runCopilotPoolBill } from './copilot-pool-bill'
import { runReconciliationGap } from './reconciliation-gap'
import { runReconciliationSync } from './reconciliation-sync'
import { runReconciliationBackfill } from './reconciliation-backfill'
import { runIdentitySync } from './identity-sync'
import { runUsageReconciliation } from './usage-reconciliation'
import { runSessionGc } from './session-gc'
import { runSoftPurge } from './soft-purge'
import { runVelocityWatch } from './velocity-watch'
import { runWentSilent } from './went-silent'
import { runReadPathHealth } from './read-path-health'
import { getTelemetryReader } from '../azure/reader'
import { UI_TRIGGERABLE_WORKER_NAMES } from '../../shared/workers/ui-triggerable'

type Db = PostgresJsDatabase<typeof schema>

/** Per-dispatch context the run-worker endpoint passes to a worker. Optional so
 * existing `run: runFoo` entries (which ignore it) stay assignable. */
export interface WorkerRunContext {
  /** worker_run.id for this dispatch — workers that write the reconciliation ledger
   * stamp it onto reconciliation_record.run_id. Null if the run-start insert failed. */
  runId: string | null
  /**
   * Optional per-dispatch options parsed from the (signed) request body. Generic
   * and optional so workers that ignore it are unaffected. Today only
   * azure-monitor-read reads `opts.deepRescan` — it lets an operator FORCE a
   * full-window re-read (a one-off Container Apps job execution with
   * DEEP_RESCAN=true) to recover a read-path backlog, overriding the auto-decided
   * daily cadence (shouldDeepRescan). The body is inside the signed HMAC payload
   * (server/auth/internal-request.ts), so this is tamper-proof.
   */
  opts?: {
    deepRescan?: boolean
    // privileged-identity-cleanup: destructive apply gate (default report-only).
    // Only reachable via the signed HMAC worker body, never the UI trigger.
    apply?: boolean
  }
}

export interface WorkerEntry {
  name: string
  run: (db: Db, ctx?: WorkerRunContext) => Promise<unknown>
  /*
   * Recommended external cron cadence (informational; the scheduler is
   * external). Used to populate docs.
   */
  recommendedCron: string
  description: string
}

/*
 * Anthropic cost data is NOT final on the day it's reported: the Enterprise
 * Analytics API states values "may be revised for up to 30 days as late events
 * arrive." A start-of-CURRENT-month poll window therefore ORPHANED late
 * prior-month revisions the moment the month rolled over — e.g. on June 1+ a
 * revision to a May 28 charge was never re-pulled, so actual_spend (the
 * bill-anchored money surface, mig 0059) silently under/over-counted that day
 * forever. Re-pull a TRAILING window that crosses the month boundary instead.
 *
 * 30 days = the documented revision horizon. The Analytics API returns
 * idempotent daily rows, so re-polls upsert (progressively-correct actuals) —
 * widening the window only re-states days that may still move, never duplicates.
 *
 * SCALE NOTE: at many reconciled orgs this is days×calls per 15-min tick against
 * the 60-RPM org cap (enterprise path = 2 serialized calls/day). If that bites,
 * split into a short frequent window + a daily deep 30-day re-pull (delta-driven
 * — back off days where bill==recorded). See
 * docs/design/bill-anchored-reconciliation-and-existence.md §5 (L1). Pure +
 * exported for unit testing (run() uses `new Date()` directly otherwise).
 */
export const ANTHROPIC_REVISION_WINDOW_DAYS = 30

export function analyticsPollWindow(now: Date): { startingAt: string; endingAt: string } {
  const start = new Date(now)
  start.setUTCDate(start.getUTCDate() - ANTHROPIC_REVISION_WINDOW_DAYS)
  return {
    startingAt: start.toISOString().slice(0, 10),
    endingAt: now.toISOString().slice(0, 10),
  }
}

export const WORKERS: ReadonlyArray<WorkerEntry> = [
  {
    name: 'analytics-poll',
    run: (db) => {
      /*
       * Scheduler entrypoint: poll every RECONCILED Anthropic org (each with its
       * own admin key) over the trailing revision window (see
       * analyticsPollWindow). With zero reconciled orgs this is a clean no-op (it
       * does NOT require NUXT_ANTHROPIC_API_ENDPOINT) — so the scheduled job
       * succeeds until a reconciled org + key is onboarded.
       */
      return runAnalyticsPollReconciledOrgs(db, analyticsPollWindow(new Date()))
    },
    recommendedCron: '*/15 * * * *',
    description: 'Poll reconciled Anthropic orgs for new actual_spend rows',
  },
  {
    name: 'placement-sync',
    run: (db) => runPlacementSync(db),
    recommendedCron: '*/30 * * * *',
    description: 'Provision+place cost-bearing users from the owed-bill queue (bill-driven placement)',
  },
  {
    name: 'region-reenrichment',
    run: (db) => runRegionReenrichment(db),
    recommendedCron: '0 */6 * * *',
    description: 'Re-derive region for bill teammates on a holding node (mig 0068 heal/backfill; rehome-safe only)',
  },
  {
    name: 'privileged-identity-cleanup',
    // REPORT-only from the scheduler (no apply flag): counts + audits teammate
    // rows matching the directory-exclusion policy. Destructive apply is
    // cron/CLI/HMAC-only via a signed body {apply:true} + hard cap — never the
    // one-click UI (excluded from UI_TRIGGERABLE_WORKER_NAMES). See the worker.
    run: (db, ctx) => runPrivilegedIdentityCleanup(db, { apply: ctx?.opts?.apply === true }),
    recommendedCron: '30 4 * * *',
    description: 'Report/clean teammate rows matching the directory-exclusion policy (#121; report-only unless a signed {apply:true} body + cap)',
  },
  {
    name: 'pending-placement-gc',
    run: (db) => runPendingPlacementGc(db),
    recommendedCron: '0 4 * * *',
    description: 'GC replayed owed bills from pending_placement (mig 0066) past the 90-day retention window',
  },
  {
    name: 'azure-monitor-read',
    run: async (db, ctx) => {
      /*
       * Scheduler entrypoint: scan the last 24h of instance_attestation rows
       * still needing a (re)join — active sessions (re-scanned each tick for
       * new spend) + ended-but-unattributed ones. Bounded by runReadJoiner's
       * own 24h default; explicit sessionIds keep us safe on production-scale
       * tables (per R1 sweep F2).
       */
      const sessionIds = await selectRecentJoinableSessionIds(db)
      // ING-1: once per ~24h, ignore the per-instance watermark and re-read the
      // full reader window — recovers telemetry that arrived later than the
      // 5-minute lookback (OTLP batching, laptop suspends, ingestion latency).
      // Auto-decided from worker_run.result (so a crashed deep pass retries next
      // tick) UNLESS an operator FORCES it via the signed run-worker body
      // (ctx.opts.deepRescan) — the recovery lever for a read-path backlog after
      // a silent outage. The forced flag wins over the cadence.
      const deepRescan = ctx?.opts?.deepRescan ?? (await shouldDeepRescan(db))
      if (sessionIds.length === 0) {
        return {
          sessionsProcessed: 0,
          attributionRowsWritten: 0,
          spansSkippedNoRateCard: 0,
          spansSpilledUnauthorized: 0,
          spansSpilledEnded: 0,
          errors: 0,
          // A zero-session tick must NOT claim the daily deep pass happened.
          deepRescan: false,
          signalRowsWritten: 0,
          signalErrors: 0,
        }
      }
      const reader = getTelemetryReader()
      return runReadJoiner(db, reader, { sessionIds, deepRescan })
    },
    recommendedCron: '*/5 * * * *',
    description: 'Join recent OTel spans into attribution_record',
  },
  {
    name: 'mitigation-query',
    run: (db) => runMitigationQuery(db),
    recommendedCron: '*/30 * * * *',
    description: 'Re-evaluate active mitigations against current spend',
  },
  {
    name: 'reconciliation',
    run: (db) => runReconciliation(db),
    recommendedCron: '0 */1 * * *',
    description: 'Detect OTel-vs-Anthropic attribution gaps, emit untagged-backlog items',
  },
  {
    name: 'reconciliation-gap',
    run: (db) => runReconciliationGap(db),
    recommendedCron: '0 */6 * * *', // every 6h — the safety-net alert, not a per-minute control
    description:
      'Raise a first-class reconciliation-gap alert when OTel-attributed vs Anthropic-actuals diverges past the bar (ADR-0005 §4)',
  },
  {
    name: 'reconciliation-sync',
    run: (db, ctx) => runReconciliationSync(db, { runId: ctx?.runId ?? null }),
    recommendedCron: '0 */1 * * *', // hourly freshness; daily-grain truth, monthly invoice true-up
    description:
      'Pull vendor billing via adapters and reconcile into reconciliation_record (Phase 0 foundation: clean no-op until an adapter registers)',
  },
  {
    name: 'identity-sync',
    run: (db) => runIdentitySync(db),
    recommendedCron: '0 3 * * *', // daily — seed teammate_identity_map from provider directories
    description:
      'Seed teammate_identity_map from provider seats/SCIM directories (Phase 0 foundation: clean no-op until a resolver registers)',
  },
  {
    name: 'usage-reconciliation',
    run: (db) => runUsageReconciliation(db),
    recommendedCron: '0 */2 * * *', // every 2h — refresh per-day API-minus-OTel unaccounted usage
    description:
      'Reconcile provider API usage truth vs OTel-captured per (teammate, day); upsert the taggable "unaccounted usage" records (provider-billing-attribution-model.md §A)',
  },
  {
    name: 'reconciliation-backfill',
    run: (db, ctx) => runReconciliationBackfill(db, { runId: ctx?.runId ?? null }),
    recommendedCron: '*/15 * * * *', // drain the on-demand backfill queue (mig 0074); one request/tick
    description:
      'Drain the admin backfill queue: pull a historical window for one credential scope + run §A reconcile so older days surface as unaccounted usage (provider-billing-attribution-model.md §A)',
  },
  {
    name: 'copilot-pool-bill',
    run: (db) => runCopilotPoolBill(db),
    recommendedCron: '0 5 * * *', // daily — Copilot is month-grain + settles slowly; a daily re-read
    description:
      'Read the enterprise billing usage report → write the POOLED Copilot chargeback (copilot_pool_bill), homed org→CoU. A reader, not a calculator (provider-billing-attribution-model.md §B).',
  },
  {
    name: 'ending-soon',
    run: (db) => runEndingSoon(db),
    recommendedCron: '0 8 * * *', // daily 8am UTC — a proactive heads-up, not a control loop
    description:
      'Warn devs assigned to / contributing on a project entering its end_date window (D3); one inbox item per (dev, project)',
  },
  {
    name: 'session-gc',
    run: (db) => runSessionGc(db),
    recommendedCron: '0 2 * * *',
    description: 'Garbage-collect expired session attestations',
  },
  {
    name: 'soft-purge',
    run: (db) => runSoftPurge(db),
    recommendedCron: '0 3 * * *',
    description: 'Apply soft-deletion retention to expired rows',
  },
  {
    name: 'archive-ledger',
    // OFF unless LEDGER_ARCHIVE_ENABLED=true — exports cold attribution_record
    // partitions to warm storage (after rollup + export verify) then DETACH+DROP.
    run: (db) => runArchiveLedger(db),
    recommendedCron: '0 4 1 * *', // monthly, 1st at 04:00 UTC
    description: 'Archive cold attribution_record partitions to warm storage + retire (off by default)',
  },
  {
    name: 'aggregate-rollup',
    // Self-bootstrapping: an empty attribution_aggregate (first deploy)
    // triggers a 90-day backfill instead of the incremental 2-day window.
    run: (db) => runAggregateRollup(db),
    recommendedCron: '*/15 * * * *',
    description:
      'Materialise attribution_aggregate (teammate/project × day × tool × model × token_type) — the consumption-dashboard read path',
  },
  {
    name: 'velocity-watch',
    run: (db) => runVelocityWatch(db),
    recommendedCron: '0 9 * * 1', // Monday 9am UTC
    description: 'Detect per-teammate weekly velocity above 25% over 4-week trailing mean',
  },
  {
    name: 'connector-health',
    run: (db) => runConnectorHealth(db),
    recommendedCron: '*/30 * * * *',
    description: 'Emit sync-conflict items from pending sync_conflict rows',
  },
  {
    name: 'budget-alert',
    run: (db) => runBudgetAlert(db),
    recommendedCron: '*/15 * * * *',
    description: 'Scan attribution vs allocation, emit over-budget inbox items',
  },
  {
    name: 'went-silent',
    run: (db) => runWentSilent(db),
    recommendedCron: '0 */1 * * *', // hourly — surface a credential-rejection within the hour
    description:
      'Alert the owning teammate when a live instance\'s emit credential is being rejected at /bearer (bearer-auth-failed); auto-resolve on recovery',
  },
  {
    name: 'read-path-health',
    run: (db) => runReadPathHealth(db),
    // Recommended: every ~15 min. went-silent only catches WRITE/emit-credential
    // silence (bearer-auth-failed); THIS worker catches the READ-path outage
    // (the azure-monitor-read gatherer dead while clients still emit) that went
    // undetected for ~5.5 days. Reads the persisted worker_run ledger only — it
    // does NOT re-run the gatherer. Cron wiring is infra (lead to schedule).
    recommendedCron: '*/15 * * * *',
    description:
      'Alert admins when the OTel read path (azure-monitor-read) has silently stalled/failed while clients still emit; auto-resolve on recovery',
  },
  {
    name: 'heartbeat-coverage',
    run: (db) => runHeartbeatCoverage(db),
    recommendedCron: '*/30 * * * *', // every 30 min — the EARLY detection leg before reconciliation (~1h+)
    description:
      'Quarantine "unverified spend" — sessions whose claimed instance has no covering /bearer heartbeat (cross-instance-spoof signal). Informational only; never auto-revokes (MCP backbone §heartbeat-coverage)',
  },
]

const BY_NAME = new Map(WORKERS.map((w) => [w.name, w]))

export function getWorker(name: string): WorkerEntry | undefined {
  return BY_NAME.get(name)
}

export function listWorkerNames(): string[] {
  return WORKERS.map((w) => w.name)
}

/*
 * Workers an admin may trigger on-demand from the UI (admin/workers/[name]/run).
 * The HMAC cron endpoint can run EVERY registered worker; the UI button is a
 * deliberately NARROWER surface. The canonical list is the SINGLE SOURCE shared
 * with the client picker (shared/workers/ui-triggerable.ts) so the two never
 * drift; this Set is the O(1) gate the endpoint enforces. Every name MUST be a
 * real registered worker (guarded by a unit test).
 */
export const UI_TRIGGERABLE_WORKERS: ReadonlySet<string> = new Set(UI_TRIGGERABLE_WORKER_NAMES)
