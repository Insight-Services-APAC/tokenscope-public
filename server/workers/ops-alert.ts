/*
 * ops-alert — the evaluator worker behind the external operator page
 * (docs/design/ops-alerting.md A2/A3/A5).
 *
 * One principle: a red that means "the product is degraded" pushes to the
 * operator on an external channel; it never waits to be looked at. This worker
 * evaluates the A2 conditions each tick, drives the A3 notification state
 * machine (kv mount 'ops-alert'), and keeps A5 inbox + audit parity. Its OWN
 * liveness is covered by the A4 Azure-native dead-man (a metric alert on the
 * job's successful-execution count), which is why it never evaluates itself.
 *
 * Probe budget (ar-H6): every probe runs under a per-probe timeout (5 s
 * default; the telemetry read has its own, wider one — see
 * TELEMETRY_PROBE_TIMEOUT_MS) and the whole evaluation under a total deadline
 * (60 s default) — a hang degrades ONE tick's coverage, never the lock chain.
 *
 * Every observation carries a closed-enum REASON and, where one exists, the
 * probe's correlation id (docs/design/alert-diagnosability.md D1/D2). They
 * reach worker_run.result.conditions and the admin inbox body — never the
 * public ntfy payload (ar-H9).
 *
 * CONCURRENCY CONTRACT: runs under the per-worker dispatch lock
 * (server/workers/dispatch-lock.ts) like every scheduled worker. The kv
 * check-then-write and the inbox upsert are NON-ATOMIC and are safe only
 * because the name-scoped lock serializes ticks. Never run this unlocked.
 */
import { createHash } from 'node:crypto'
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import {
  OPS_ALERT_CONDITION,
  OPS_ALERT_INBOX_CATEGORY,
  buildNtfyPayload,
  isOpsAlertConditionKey,
  workerConditionKey,
  type OpsAlertConditionKey,
  type OpsAlertReason,
  type OpsAlertSeverity,
} from '../../shared/ops-alert/conditions'
import { isProbeErrorReason } from '../../shared/observability/probe-error-reason'
import { decideAttributionStall } from '../usage/attribution-stall'
import { DISPATCH_TIMEOUT_MS } from '../../shared/workers/dispatch-budget'
import { isWorkerScheduled } from '../../shared/workers/unscheduled'
import {
  opsAlertNtfyUrl,
  sendOpsNotification,
  type OpsNotifyFn,
} from '../observability/ops-notify'
import { currentServerDeployEnv } from '../../shared/env/deploy-env'
import { getTelemetryReader, type ReaderHealth } from '../azure/reader'
import { runNetworkCheck, type NetCheckReport } from '../azure/network-check'
import { loadReaderRuns, loadLastFleetEmitMs, type ReaderRun } from './read-path-health'
import { dispatchInbox } from '../notifications/dispatch'
import { recordAuditEvent } from '../db/audit'

type Db = PostgresJsDatabase<typeof schema>

const OPS_ALERT_WORKER = 'ops-alert'
const KV_MOUNT = 'ops-alert'

// ── Budgets + thresholds (defaults per the design; all injectable) ────────────

const DEFAULT_PROBE_TIMEOUT_MS = 5_000 // ar-H6 per-probe budget
/*
 * The telemetry read's OWN budget. MUST stay outside the cold-start tail of a
 * container-app job (new process per run: dynamic Azure SDK imports, credential
 * chain, IMDS token) — a budget inside it pages a healthy system. It cannot
 * share DEFAULT_PROBE_TIMEOUT_MS, which bounds the ntfy send and each per-host
 * TCP dial, where 5 s is correct. Not env-overridable: `intFromEnv` here is for
 * THRESHOLDS; ar-H6 BUDGETS are constants, injectable only via OpsAlertOpts.
 * Sizing evidence: docs/design/alert-diagnosability.md D4.
 */
const TELEMETRY_PROBE_TIMEOUT_MS = 20_000
const DEFAULT_TOTAL_DEADLINE_MS = 60_000 // ar-H6 total evaluation deadline
// The network sweep is MANY bounded probes, not one — it gets a wider slice of
// the deadline than a single 5 s probe, still inside the total budget.
const NETWORK_SWEEP_BUDGET_MS = 30_000
const NETWORK_SWEEP_CONCURRENCY = 4

const DEFAULT_STALL_MINUTES = 90 // A2.2 OPS_ALERT_STALL_MINUTES
const DEFAULT_FLEET_THRESHOLD = 4 // A2.3 OPS_ALERT_FLEET_THRESHOLD
const DEFAULT_REMIND_HOURS = 6 // A3 OPS_ALERT_REMIND_HOURS

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// A2.3: worker_run lookback capped at 8 days — covers the weekly cadence
// (ar-M14; ledger retention itself is a noted follow-up). Served by the 0137
// (started_at) index.
export const FLEET_LOOKBACK_MS = 8 * DAY_MS
// A 'running' row older than 2× the dispatch budget counts as a failure
// (ar-M12 — wedged runs are invisible otherwise). The budget is the shared
// constant worker-jobs.bicep + cron-trigger.mjs are lockstepped to.
export const WEDGED_RUNNING_MS = 2 * DISPATCH_TIMEOUT_MS
// Most-recent terminal runs consulted per worker for the failure streak. The
// predicate needs "≥2 consecutive failures" plus reset evidence — a dozen rows
// is ample and keeps the fleet scan O(workers).
const FLEET_RUNS_PER_WORKER = 12
// Reader-run rows for the stall streak: at the joiner's */5 cadence, 40 rows
// ≈ 200 min — comfortably spans the default 90-min stall window.
const STALL_RUN_LOAD = 40
// Per-tick notify budget: the run-worker dispatch gateway ceiling is ~120 s,
// and each POST can take the full 5 s timeout — 10 × 5 s + the 60 s evaluation
// deadline stays inside it. Deferred conditions remain undelivered and retry
// next tick (15-min cadence); sends are ordered criticals-first so a deferred
// send is never a critical displaced by a warning.
export const MAX_NOTIFY_PER_TICK = 10

function intFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

// ── Cron-interval parsing (A2.3, ar-M13) ──────────────────────────────────────

/*
 * The interval a registry `recommendedCron` fires at, in ms — the input to the
 * cadence-aware deadline. Handles exactly the shapes the registry uses (step
 * minutes/hours, minute lists, daily/weekly/monthly fixed times); anything
 * else returns null and the worker skips the deadline leg for that worker
 * (logged — an unparseable cron must degrade loudly, not misclassify).
 * For a minute LIST the interval is the WORST-CASE circular gap, so the
 * deadline stays conservative for unevenly spaced lists.
 */
export function cronIntervalMs(cron: string): number | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string]
  const coarserAllWild = domF === '*' && monF === '*' && dowF === '*'

  if (hourF === '*' && coarserAllWild) {
    if (minF === '*') return MINUTE_MS
    const step = /^\*\/(\d+)$/.exec(minF)
    // A zero step is not a cadence; null routes it to the loud skip-with-warn
    // path instead of a 0ms interval silently widening to the 1h floor.
    if (step) return Number(step[1]) > 0 ? Number(step[1]) * MINUTE_MS : null
    if (/^\d+(,\d+)*$/.test(minF)) {
      const mins = [...new Set(minF.split(',').map(Number))].sort((a, b) => a - b)
      if (mins.some((m) => m > 59)) return null
      if (mins.length === 1) return HOUR_MS
      let maxGap = 60 - mins[mins.length - 1]! + mins[0]!
      for (let i = 1; i < mins.length; i++) maxGap = Math.max(maxGap, mins[i]! - mins[i - 1]!)
      return maxGap * MINUTE_MS
    }
    return null
  }

  if (!/^\d+$/.test(minF)) return null
  if (coarserAllWild) {
    const step = /^\*\/(\d+)$/.exec(hourF)
    if (step) return Number(step[1]) > 0 ? Number(step[1]) * HOUR_MS : null
    if (/^\d+$/.test(hourF)) return DAY_MS // daily at HH:MM
    return null
  }
  if (!/^\d+$/.test(hourF) || monF !== '*') return null
  // weekly (fixed day-of-week)
  if (domF === '*' && /^\d+$/.test(dowF)) return 7 * DAY_MS
  // monthly (fixed day-of-month)
  if (/^\d+$/.test(domF) && dowF === '*') return 31 * DAY_MS
  return null
}

/** ar-M13: the cadence-aware deadline — 3 × the cron interval, min 1 h. */
export function workerDeadlineMs(recommendedCron: string): number | null {
  const interval = cronIntervalMs(recommendedCron)
  return interval === null ? null : Math.max(3 * interval, HOUR_MS)
}

// ── Fleet failure predicate (A2.3, ar-M11/M12/M13) ────────────────────────────

export interface FleetRun {
  status: string
  startedAtMs: number
}

/*
 * Per-worker failure predicate: FAILING iff the most recent terminal runs are
 * ≥2 consecutive failures AND the cadence-aware deadline has passed without a
 * success. `success` AND `skipped` reset the streak (ar-M12 — an admin
 * disable/re-enable must not resurrect old failures); a `running` row older
 * than 2× the dispatch budget counts as a failure (wedged), while a FRESH
 * running row is no evidence either way and is skipped over.
 *
 * A deadline wider than the 8-day lookback (weekly/monthly cadences) can never
 * be ESTABLISHED as missed from the data we scan, so such workers cannot trip
 * this predicate — the accepted ar-M14 residual of the bounded scan.
 */
export function isWorkerFailing(input: {
  runs: FleetRun[] // most-recent first, within FLEET_LOOKBACK_MS
  lastSuccessMs: number | null // within FLEET_LOOKBACK_MS
  deadlineMs: number | null
  nowMs: number
}): { failing: boolean; streak: number } {
  let streak = 0
  for (const r of input.runs) {
    if (r.status === 'failure') {
      streak += 1
      continue
    }
    if (r.status === 'running') {
      if (input.nowMs - r.startedAtMs > WEDGED_RUNNING_MS) {
        streak += 1
        continue
      }
      continue // in-flight, no outcome yet
    }
    break // 'success' | 'skipped' → streak resets (ar-M12)
  }
  const deadlineMissed =
    input.deadlineMs !== null &&
    input.deadlineMs <= FLEET_LOOKBACK_MS &&
    (input.lastSuccessMs === null || input.nowMs - input.lastSuccessMs > input.deadlineMs)
  return { failing: streak >= 2 && deadlineMissed, streak }
}

// ── The A3 state machine, as a pure decision step ─────────────────────────────

/** Per-condition state persisted in the 'ops-alert' kv mount. */
export interface ConditionState {
  severity: 'critical' | 'warning'
  /** Consecutive runs observed active AT THE CURRENT severity (warning damping). */
  activeRuns: number
  /** True once ANY notification for this episode got a 2xx. */
  delivered: boolean
  /** Persisted ONLY after a 2xx (ar-M16); reminders key off it. */
  lastSentAtMs: number | null
  /** Consecutive clear runs while delivered (recovery needs one full clear run). */
  clearRuns: number
}

/*
 * One evaluator verdict for one condition key.
 *
 * `reason` is REQUIRED, and that is the whole point of D1: `observations` is a
 * Map keyed to this type, so `observations.set(key, { severity: 'critical' })`
 * — the line that cost four hours — no longer compiles. A severity cannot be
 * recorded without saying why.
 */
export interface ConditionObservation {
  severity: 'critical' | 'warning'
  /** WHY, from the closed vocabulary — never free text, never a driver message. */
  reason: OpsAlertReason
  count?: number
  /**
   * Ties `reason` back to the full-fidelity server log line when the reason
   * came from a classified exception (redact-probe-error.ts). Absent for
   * reasons this worker derives itself (a streak, a count, a blown budget).
   */
  correlationId?: string
}

export type ConditionAction =
  | { type: 'none' }
  /** Persist the updated state; nothing to send this run. */
  | { type: 'persist'; state: ConditionState }
  /** Never-announced flap cleared — drop the key silently (ar-M15). */
  | { type: 'delete-silent' }
  /** Attempt a send; the orchestrator stamps delivered/lastSentAtMs on 2xx only. */
  | { type: 'send'; kind: 'alert' | 'reminder'; transition: string; state: ConditionState }
  /** Delivered condition clear for one full run — attempt the RECOVERED notice. */
  | { type: 'send-recovery'; transition: string }

/*
 * One state-machine step (A3), pure so every branch is unit-testable:
 *   - EVERY severity needs two consecutive active runs before it is announced
 *     (flap damping — alert-diagnosability D3 extended this from warning to
 *     critical; it supersedes ar-H5's first-detection paging).
 *   - Severity escalation warning→critical on a DELIVERED condition notifies
 *     immediately (ar-M15), bypassing both damping and the reminder cadence.
 *   - An undelivered condition keeps attempting each run (a failed POST left
 *     it retryable — ar-M16).
 *   - RECOVERED only for conditions actually DELIVERED, and only after one
 *     full clear run (ar-M15); a never-announced flap is dropped silently.
 *   - Reminder every remindMs while delivered + unresolved.
 */
export function decideConditionAction(
  prior: ConditionState | null,
  obs: ConditionObservation | null,
  nowMs: number,
  remindMs: number,
): ConditionAction {
  if (obs) {
    const next: ConditionState = {
      severity: obs.severity,
      // SEVERITY-SCOPED counter (A3): "two consecutive runs" means two runs AT
      // THIS severity — a severity change restarts the count, so a run
      // observed at one severity can never pre-satisfy another's damping.
      activeRuns: prior !== null && prior.severity === obs.severity ? prior.activeRuns + 1 : 1,
      delivered: prior?.delivered ?? false,
      lastSentAtMs: prior?.lastSentAtMs ?? null,
      clearRuns: 0,
    }
    const transition = `${prior?.severity ?? 'none'}→${obs.severity}`
    if (!next.delivered) {
      // D3: damping is SEVERITY-INDEPENDENT. Every critical observed over 24 h
      // self-recovered inside one tick, so first-observation paging produced
      // only false pages, and an alert that is usually wrong is worse than one
      // that is 15 minutes late. Accepted cost: a genuine critical pages one
      // cadence later. Recovery is untouched (still one full clear run), and
      // this branch is reached only while NOTHING has been announced — the
      // delivered-path escalation below still fires immediately.
      const damped = next.activeRuns < 2
      if (damped) return { type: 'persist', state: next }
      return { type: 'send', kind: 'alert', transition, state: next }
    }
    const escalated = prior !== null && prior.severity === 'warning' && obs.severity === 'critical'
    if (escalated) return { type: 'send', kind: 'alert', transition, state: next }
    if (next.lastSentAtMs !== null && nowMs - next.lastSentAtMs >= remindMs) {
      return { type: 'send', kind: 'reminder', transition: `${obs.severity}→${obs.severity}`, state: next }
    }
    return { type: 'persist', state: next }
  }

  if (!prior) return { type: 'none' }
  if (!prior.delivered) return { type: 'delete-silent' }
  if (prior.clearRuns < 1) {
    return { type: 'persist', state: { ...prior, activeRuns: 0, clearRuns: prior.clearRuns + 1 } }
  }
  return { type: 'send-recovery', transition: `${prior.severity}→recovered` }
}

// ── Probe bounding (ar-H6) ────────────────────────────────────────────────────

type BoundedOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean; errorName?: string }

/*
 * Race a probe against its budget. The losing promise is left pending on
 * purpose — abandoning a hung probe is exactly the ar-H6 contract (one tick's
 * coverage degrades; the run and the lock chain never do).
 */
async function boundedCall<T>(fn: () => Promise<T>, ms: number): Promise<BoundedOutcome<T>> {
  if (ms <= 0) return { ok: false, timedOut: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn().then((value) => ({ ok: true as const, value })),
      new Promise<BoundedOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, timedOut: true }), ms)
      }),
    ])
  } catch (err) {
    return { ok: false, timedOut: false, errorName: err instanceof Error ? err.name : 'Error' }
  } finally {
    clearTimeout(timer)
  }
}

// ── kv state (mount 'ops-alert') ──────────────────────────────────────────────

/*
 * Shape guard for persisted state (hand-rolled per the shared/* guard
 * convention). A kv row is data at rest, not code we wrote this deploy — a
 * corrupted or stale-schema row must be rejected, never cast (ar-H9's blast
 * radius: state drives what reaches the public ntfy topic).
 */
export function isConditionState(v: unknown): v is ConditionState {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    (o.severity === 'critical' || o.severity === 'warning') &&
    typeof o.activeRuns === 'number' && Number.isInteger(o.activeRuns) && o.activeRuns >= 0 &&
    typeof o.delivered === 'boolean' &&
    (o.lastSentAtMs === null || (typeof o.lastSentAtMs === 'number' && Number.isFinite(o.lastSentAtMs))) &&
    typeof o.clearRuns === 'number' && Number.isInteger(o.clearRuns) && o.clearRuns >= 0
  )
}

/*
 * Load persisted condition states, VALIDATING key and shape before either may
 * enter the state machine: a persisted key becomes a reminder/recovery payload
 * condition, so only vocabulary keys (isOpsAlertConditionKey) may pass — a
 * corrupted row is deleted and logged LOCALLY (the key may appear in app logs,
 * never on the channel).
 */
async function loadStates(
  db: Db,
  isValidKey: (key: string) => boolean,
): Promise<Map<string, ConditionState>> {
  const rows = await db.execute<{ key: string; value: string }>(sql`
    SELECT key, value FROM kv_store WHERE mount = ${KV_MOUNT}
  `)
  const out = new Map<string, ConditionState>()
  for (const r of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(r.value)
    } catch {
      parsed = undefined
    }
    if (!isValidKey(r.key) || !isConditionState(parsed)) {
      // Never log the key verbatim: a corrupted row's key could carry a URL —
      // including the topic URL, which is the credential (design A1/ar-M20).
      // Length + digest prefix is enough to find the row in kv_store.
      const digest = createHash('sha256').update(r.key).digest('hex').slice(0, 12)
      consola.error(
        `[${OPS_ALERT_WORKER}] dropping invalid persisted state row len=${r.key.length} sha256=${digest}`,
      )
      try {
        await deleteState(db, r.key)
      } catch {
        // Already excluded from evaluation; a failed cleanup must not blank
        // the tick — the row is retried next run.
      }
      continue
    }
    out.set(r.key, parsed)
  }
  return out
}

async function saveState(db: Db, key: string, state: ConditionState): Promise<void> {
  const value = JSON.stringify(state)
  await db.execute(sql`
    INSERT INTO kv_store (mount, key, value, expires_at, updated_at)
    VALUES (${KV_MOUNT}, ${key}, ${value}, NULL, now())
    ON CONFLICT (mount, key) DO UPDATE
      SET value = EXCLUDED.value, expires_at = NULL, updated_at = now()
  `)
}

async function deleteState(db: Db, key: string): Promise<void> {
  await db.execute(sql`DELETE FROM kv_store WHERE mount = ${KV_MOUNT} AND key = ${key}`)
}

// ── A5 inbox parity ───────────────────────────────────────────────────────────

/*
 * ONE inbox item per condition key (ar-M17): the key rides related_entity_kind
 * (text; related_entity_id is a uuid column and the key is not an entity row).
 * An OPEN item is updated in place — reminders and repeat evaluations never
 * duplicate it; only a new episode (no open item) inserts.
 */
async function upsertConditionInbox(
  db: Db,
  key: OpsAlertConditionKey,
  severity: 'critical' | 'warning',
  count: number | undefined,
  now: Date,
  kind: 'alert' | 'reminder',
  diagnosis: { reason?: OpsAlertReason; correlationId?: string },
): Promise<'created' | 'updated' | 'dropped'> {
  const inboxSeverity = severity === 'critical' ? 'urgent' : 'attention'
  /*
   * D2: the diagnosis rides the ADMIN item body (authenticated, not the public
   * topic). BOTH fields are written on EVERY patch, `correlation_id` as null
   * when there is none: `body || patch` is a SHALLOW merge, so an omitted key
   * leaves the previous episode's id in place and pairs it with the new reason
   * — pointing the operator at an unrelated log line.
   */
  const diagnosisFields = {
    reason: diagnosis.reason,
    correlation_id: diagnosis.correlationId ?? null,
  }
  const patch = JSON.stringify({
    condition: key,
    severity,
    ...(count !== undefined ? { count } : {}),
    ...diagnosisFields,
    last_evaluated_at: now.toISOString(),
    ...(kind === 'reminder' ? { last_reminded_at: now.toISOString() } : {}),
  })
  const updated = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET severity = ${inboxSeverity}, body = body || ${patch}::jsonb
     WHERE category = ${OPS_ALERT_INBOX_CATEGORY}
       AND related_entity_kind = ${key}
       AND ack_state IN ('unread', 'read', 'acknowledged')
    RETURNING id::text AS id
  `)
  if ([...updated].length > 0) return 'updated'

  const dispatched = await dispatchInbox(db, {
    category: 'ops-alert',
    severity: inboxSeverity,
    subject: `TokenScope ops alert: ${key} is ${severity}`,
    body: {
      condition: key,
      severity,
      ...(count !== undefined ? { count } : {}),
      ...diagnosisFields,
      detectedAt: now.toISOString(),
      hint: 'This condition also paged the external ops channel. Start at Admin → Diagnostics; the wiki triage ladder names the per-condition playbook.',
    },
    relatedEntityKind: key,
    now,
  })
  if (dispatched.length === 0) {
    // ar-M18: an estate without an active platform-admin/global-finops just
    // dropped its parity item. dispatchInbox already warns; this worker is the
    // OPERATOR channel, so it says it louder.
    consola.error(
      `[${OPS_ALERT_WORKER}] operations-recipient set is EMPTY — no active platform-admin/global-finops; inbox parity item for condition=${key} was dropped (ar-M18)`,
    )
    return 'dropped'
  }
  return 'created'
}

async function resolveConditionInbox(db: Db, key: string, now: Date): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved', ack_at = ${now.toISOString()}::timestamptz
     WHERE category = ${OPS_ALERT_INBOX_CATEGORY}
       AND related_entity_kind = ${key}
       AND ack_state IN ('unread', 'read', 'acknowledged')
    RETURNING id::text AS id
  `)
  return [...rows].length
}

// ── A5 audit parity (ar-L23) ──────────────────────────────────────────────────

type OpsAuditEvent =
  | 'ops-alert-delivered'
  | 'ops-alert-failed'
  | 'ops-alert-reminded'
  | 'ops-alert-recovered'
  /** A warning: state-machine-announced and written to the inbox, never pushed. */
  | 'ops-alert-suppressed'

async function auditOpsAlert(
  db: Db,
  eventType: OpsAuditEvent,
  condition: string,
  transition: string,
  httpStatus: number | null,
): Promise<void> {
  await recordAuditEvent(db, {
    eventType,
    actorSystem: OPS_ALERT_WORKER,
    subjectKind: 'ops-alert-condition',
    // Condition key, severity transition, destination class and HTTP status —
    // and nothing else: never the channel URL or a payload body (ar-L23/ar-M20).
    payload: { condition, transition, destinationClass: 'ntfy', httpStatus },
  })
}

// ── The worker ────────────────────────────────────────────────────────────────

export interface OpsAlertThresholds {
  stallMinutes: number
  fleetThreshold: number
  remindHours: number
}

export interface OpsAlertOpts {
  /** Evaluation clock (state machine + fixtures); probe budgets use real time. */
  now?: Date
  /** Notification seam — tests inject; default POSTs to the configured channel. */
  notify?: OpsNotifyFn
  /** Channel override; empty/absent falls back to NUXT_OPS_ALERT_NTFY_URL. */
  ntfyUrl?: string
  /** Environment tag for the payload; default the deployment's classified env. */
  envTag?: string
  probes?: {
    telemetryRead?: () => Promise<ReaderHealth>
    network?: () => Promise<NetCheckReport>
  }
  /** ar-H6 per-probe budget: the ntfy send and each per-host TCP dial. */
  probeTimeoutMs?: number
  /**
   * The telemetry read's own, wider budget (D4) — separate because the shared
   * 5 s bound sat inside that probe's natural tail and paged a healthy system.
   */
  telemetryProbeTimeoutMs?: number
  totalDeadlineMs?: number
  thresholds?: Partial<OpsAlertThresholds>
  /** Fleet under evaluation — tests inject synthetic workers; default the registry. */
  workers?: ReadonlyArray<{ name: string; recommendedCron: string }>
  /**
   * Injection for TESTS ONLY (indeterminate-lane coverage): replaces the stall
   * lane's ledger reads so a test can force the lane to throw/hang. Production
   * always uses read-path-health's loaders.
   */
  stallLoaders?: {
    readerRuns?: () => Promise<ReaderRun[]>
    lastFleetEmitMs?: () => Promise<number | null>
  }
}

export interface OpsAlertRunResult {
  disabled: boolean
  /**
   * Active conditions observed this run (post-evaluation, pre-state-machine).
   * This IS the internal record D2 sends the diagnosis to: the dispatcher
   * persists it verbatim as worker_run.result, so the run that raised an alert
   * carries what explains it. `reason` is required for the same reason it is
   * required on ConditionObservation — a severity with no reason must not be
   * expressible.
   */
  conditions: Record<
    string,
    { severity: OpsAlertSeverity; reason: OpsAlertReason; count?: number; correlationId?: string }
  >
  /** Evaluator lanes that could not produce a verdict this tick (budget/db). */
  indeterminate: string[]
  sent: number
  reminders: number
  recoveries: number
  sendFailures: number
  /** Warnings announced to the inbox but deliberately not pushed to ntfy. */
  suppressed: number
  /** Condition keys whose state-machine step threw (logged, loop continued). */
  keyErrors: number
  /** Sends withheld by the per-tick notify budget (retry next tick, undelivered). */
  notifyDeferred: number
  inboxCreated: number
  inboxUpdated: number
  inboxResolved: number
  statesPersisted: number
  statesDeleted: number
  durationMs: number
}

/** Which evaluator lane a condition key belongs to (indeterminate-skip routing). */
function laneOf(key: string): 'telemetry' | 'network' | 'stall' | 'fleet' | 'other' {
  if (key === OPS_ALERT_CONDITION.telemetryRead) return 'telemetry'
  if (key === OPS_ALERT_CONDITION.probeNetwork) return 'network'
  if (key === OPS_ALERT_CONDITION.attributionStall) return 'stall'
  if (key === OPS_ALERT_CONDITION.workerFleet || key.startsWith('worker:')) return 'fleet'
  return 'other'
}

/** Network verdicts that page (A2.1). 'not-wired' is excluded by construction. */
const FAILING_NET_VERDICTS: ReadonlySet<string> = new Set([
  'dns-public-zone-not-linked',
  'unreachable',
  'dns-fail',
])

/*
 * Why a BOUNDED probe failed, as a closed reason (D1). The three outcomes this
 * has to keep apart — collapsing them is the defect the whole change exists to
 * fix — are:
 *
 *   1. `{ok:false, timedOut:true}`  — the budget was blown. Our bound, our
 *      fix (D4). This is what the 05:09 incident actually was.
 *   2. `{ok:false, timedOut:false}` — the probe THREW rather than returning a
 *      verdict; boundedCall kept only the error NAME, deliberately.
 *   3. `{ok:true, value:{ok:false,…}}` — the probe ANSWERED, unhealthy. If it
 *      classified the fault (a caught driver/network exception) the reason is
 *      that classification and a correlationId ties it to the full-fidelity
 *      server log; otherwise `error` is a status string (`HTTP 404`,
 *      `query status=Failure`) which is NOT vocabulary and must not travel —
 *      it degrades to 'probe-unhealthy'.
 */
function probeFailureReason(
  outcome: { ok: false; timedOut: boolean } | { ok: true; value: { ok: boolean; error?: string; correlationId?: string } },
): { reason: OpsAlertReason; correlationId?: string } {
  if (!outcome.ok) return { reason: outcome.timedOut ? 'probe-timeout' : 'probe-threw' }
  const { error, correlationId } = outcome.value
  const reason: OpsAlertReason = isProbeErrorReason(error) ? error : 'probe-unhealthy'
  return { reason, ...(correlationId !== undefined ? { correlationId } : {}) }
}

export async function runOpsAlert(db: Db, opts: OpsAlertOpts = {}): Promise<OpsAlertRunResult> {
  const startedMono = Date.now()
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()

  const result: OpsAlertRunResult = {
    disabled: false,
    conditions: {},
    indeterminate: [],
    sent: 0,
    reminders: 0,
    recoveries: 0,
    sendFailures: 0,
    suppressed: 0,
    keyErrors: 0,
    notifyDeferred: 0,
    inboxCreated: 0,
    inboxUpdated: 0,
    inboxResolved: 0,
    statesPersisted: 0,
    statesDeleted: 0,
    durationMs: 0,
  }

  // A1: empty channel = alerting disabled (the sandbox/local default). The
  // whole evaluation short-circuits — no probes, no state, no inbox traffic.
  const ntfyUrl = (opts.ntfyUrl ?? opsAlertNtfyUrl()).trim()
  if (!ntfyUrl) {
    result.disabled = true
    result.durationMs = Date.now() - startedMono
    return result
  }

  const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const telemetryProbeTimeoutMs = opts.telemetryProbeTimeoutMs ?? TELEMETRY_PROBE_TIMEOUT_MS
  const totalDeadlineMs = opts.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS
  const remaining = () => totalDeadlineMs - (Date.now() - startedMono)
  const budget = (wanted: number) => Math.min(wanted, remaining())

  const thresholds: OpsAlertThresholds = {
    stallMinutes: opts.thresholds?.stallMinutes ?? intFromEnv('OPS_ALERT_STALL_MINUTES', DEFAULT_STALL_MINUTES),
    fleetThreshold: opts.thresholds?.fleetThreshold ?? intFromEnv('OPS_ALERT_FLEET_THRESHOLD', DEFAULT_FLEET_THRESHOLD),
    remindHours: opts.thresholds?.remindHours ?? intFromEnv('OPS_ALERT_REMIND_HOURS', DEFAULT_REMIND_HOURS),
  }
  const remindMs = thresholds.remindHours * HOUR_MS

  const envTag = opts.envTag ?? currentServerDeployEnv()
  const notify: OpsNotifyFn =
    opts.notify ?? ((payload, kind) => sendOpsNotification(payload, kind, { url: ntfyUrl, timeoutMs: probeTimeoutMs }))

  const observations = new Map<OpsAlertConditionKey, ConditionObservation>()

  // ── A2.1 probe layer — external-facing, in parallel to share the budget ─────
  // A probe that times out or throws is a FAILURE, not an unknown: ar-H1's whole
  // point is that the probe fails exactly when the joiner would, and a read
  // path that cannot answer inside the budget is the outage class itself.
  // The telemetry read gets its OWN budget on BOTH ends (D4): the outer
  // boundedCall race and the reader's own request bound must be the same
  // number, or the wider outer bound is dead weight behind a 5 s inner one.
  const telemetryProbe =
    opts.probes?.telemetryRead ?? (() => getTelemetryReader().healthCheck({ timeoutMs: telemetryProbeTimeoutMs }))
  const networkProbe =
    opts.probes?.network ??
    (() => runNetworkCheck(process.env, { concurrency: NETWORK_SWEEP_CONCURRENCY, tcpTimeoutMs: probeTimeoutMs }))

  const [telemetry, network] = await Promise.all([
    boundedCall(telemetryProbe, budget(telemetryProbeTimeoutMs)),
    boundedCall(networkProbe, budget(NETWORK_SWEEP_BUDGET_MS)),
  ])

  if (!telemetry.ok || !telemetry.value.ok) {
    // A blown budget and a Log Analytics fault are DIFFERENT faults with
    // different fixes — the reason is what tells them apart (D1).
    observations.set(OPS_ALERT_CONDITION.telemetryRead, {
      severity: 'critical',
      ...probeFailureReason(telemetry),
    })
  }
  if (!network.ok) {
    observations.set(OPS_ALERT_CONDITION.probeNetwork, {
      severity: 'critical',
      reason: network.timedOut ? 'probe-timeout' : 'probe-threw',
    })
  } else {
    const failing = network.value.records.filter(
      (r) => r.expectPrivate && FAILING_NET_VERDICTS.has(r.verdict),
    )
    if (failing.length > 0) {
      // The sweep answered: the hosts themselves are failing, not the probe.
      observations.set(OPS_ALERT_CONDITION.probeNetwork, {
        severity: 'critical',
        reason: 'hosts-failing',
        count: failing.length,
      })
    }
  }

  // ── DB-backed conditions — a timeout here is OUR database being slow, which
  // is not the condition under measurement: the lane goes INDETERMINATE and its
  // keys skip the state machine this tick (neither an alert nor a recovery may
  // ride a verdict that was never reached).
  // The ONE stall decision (A2.2/A6.3): read-path-health's loaders feeding
  // attribution-stall.ts's decideAttributionStall — the same function the user
  // banner evaluates, so the operator page and the banner cannot disagree.
  const loadRuns = opts.stallLoaders?.readerRuns ?? (() => loadReaderRuns(db, STALL_RUN_LOAD))
  const loadEmit = opts.stallLoaders?.lastFleetEmitMs ?? (() => loadLastFleetEmitMs(db))
  const stall = await boundedCall(async () => {
    const runs = await loadRuns()
    const lastFleetEmitMs = await loadEmit()
    return decideAttributionStall({ runs, lastFleetEmitMs, nowMs, stallMinutes: thresholds.stallMinutes })
  }, budget(probeTimeoutMs))
  if (stall.ok) {
    if (stall.value !== null) {
      observations.set(OPS_ALERT_CONDITION.attributionStall, {
        severity: 'critical',
        reason: 'zero-write-streak',
        count: stall.value.zeroRuns,
      })
    }
  } else {
    result.indeterminate.push('stall')
  }

  // opts.workers doubles as the key-vocabulary seam: the valid `worker:<name>`
  // set (FIX below at loadStates) comes from the same source as the fleet under
  // evaluation — listWorkerNames() in production, the injected fleet in tests.
  const registryMod = opts.workers ? null : await import('./registry')
  const allWorkers = opts.workers ?? registryMod!.WORKERS
  const validWorkerNames: ReadonlySet<string> = new Set(
    opts.workers ? opts.workers.map((w) => w.name) : registryMod!.listWorkerNames(),
  )
  const fleetWorkers = allWorkers.filter((w) => w.name !== OPS_ALERT_WORKER && isWorkerScheduled(w.name))
  const fleet = await boundedCall(
    () => evaluateFleet(db, fleetWorkers, nowMs),
    budget(probeTimeoutMs),
  )
  if (fleet.ok) {
    for (const f of fleet.value) {
      // Per-worker: count is THIS worker's consecutive-failure streak.
      observations.set(workerConditionKey(f.name), {
        severity: 'warning',
        reason: 'worker-failing',
        count: f.streak,
      })
    }
    if (fleet.value.length >= thresholds.fleetThreshold) {
      // Fleet-wide: count is how many workers are independently failing — a
      // different measurement, hence a different reason.
      observations.set(OPS_ALERT_CONDITION.workerFleet, {
        severity: 'critical',
        reason: 'workers-failing',
        count: fleet.value.length,
      })
    }
  } else {
    result.indeterminate.push('fleet')
  }


  // D2: the diagnosis travels with the run record. Field-by-field, not a
  // spread — the same discipline buildNtfyPayload applies for the opposite
  // reason (there, so nothing extra CAN escape; here, so the record cannot
  // silently acquire whatever a future observation field happens to hold).
  for (const [key, obs] of observations) {
    result.conditions[key] = {
      severity: obs.severity,
      reason: obs.reason,
      ...(obs.count !== undefined ? { count: obs.count } : {}),
      ...(obs.correlationId !== undefined ? { correlationId: obs.correlationId } : {}),
    }
  }

  // ── A3 state machine over union(observed, persisted) ────────────────────────
  const states = await loadStates(db, (key) => isOpsAlertConditionKey(key, validWorkerNames))
  const indeterminateLanes = new Set(result.indeterminate)
  const keys = new Set<string>([...observations.keys(), ...states.keys()])

  // Criticals first, then warnings, then unobserved (clear/recovery) keys —
  // the notify budget below must never defer a critical in favour of a warning.
  const severityRank = (key: string): number => {
    const sev = observations.get(key as OpsAlertConditionKey)?.severity
    return sev === 'critical' ? 0 : sev === 'warning' ? 1 : 2
  }
  const orderedKeys = [...keys].sort((a, b) => severityRank(a) - severityRank(b))

  let notifyAttempts = 0
  const notifyBudgetSpent = () => notifyAttempts >= MAX_NOTIFY_PER_TICK

  for (const key of orderedKeys) {
    // A lane with no verdict this tick leaves its keys untouched — a state must
    // neither age toward reminders/recovery nor clear on an evaluation that
    // never happened. (Only the DB-backed lanes can be indeterminate; the
    // external probes fail RED by design — see the probe layer above.)
    if (indeterminateLanes.has(laneOf(key))) continue
    // One key's DB hiccup must not blank the rest of the tick: log (condition
    // key only — never the channel) and continue to the next key.
    try {
      const prior = states.get(key) ?? null
      const obs = observations.get(key as OpsAlertConditionKey) ?? null
      const action = decideConditionAction(prior, obs, nowMs, remindMs)

      switch (action.type) {
        case 'none':
          break
        case 'persist':
          await saveState(db, key, action.state)
          result.statesPersisted += 1
          break
        case 'delete-silent': {
          // Never-announced flap (ar-M15): no recovery notice — but a failed-POST
          // episode may have left a parity inbox item, which must not outlive the
          // condition.
          await deleteState(db, key)
          result.statesDeleted += 1
          result.inboxResolved += await resolveConditionInbox(db, key, now)
          break
        }
        case 'send': {
          /*
           * The budget governs PUSHES, so only a pushing condition may consume
           * or be deferred by it. A warning that never reaches the channel
           * costs nothing — and while it did, a burst of per-worker warnings
           * could exhaust the tick's budget and defer a genuine critical, which
           * is the opposite of what a budget is for.
           */
          const pages = action.state.severity === 'critical'
          // Budget spent (MAX_NOTIFY_PER_TICK): defer the WHOLE action — no
          // state write, so the condition stays undelivered and retries next tick.
          if (pages && notifyBudgetSpent()) {
            result.notifyDeferred += 1
            break
          }
          if (pages) notifyAttempts += 1
          const state = action.state
          const payload = buildNtfyPayload({
            severity: state.severity,
            condition: key as OpsAlertConditionKey,
            env: envTag,
            ts: now,
            count: obs?.count,
          })
          // SEND, then persist: the ntfy attempt strictly precedes the kv write,
          // and lastSentAtMs is stamped ONLY on a 2xx (ar-M16) — a failed POST
          // leaves the condition retryable next run.
          /*
           * ONLY CRITICAL REACHES THE PHONE (owner ruling 2026-08-30).
           *
           * A warning is context you look up while investigating, not a reason
           * to wake someone: the per-worker `worker:<name>` conditions are the
           * detail behind the critical `worker-fleet` page, so pushing both
           * meant one systemic failure paged N+1 times and then reminded N+1
           * times every six hours. Warnings still take the full state-machine
           * path below — persisted, audited, and written to the admin inbox —
           * so nothing becomes invisible; it just stops vibrating.
           *
           * Escalation is unaffected: warning→critical produces a critical, and
           * criticals send.
           */
          const sendResult = pages ? await notify(payload, action.kind) : null
          if (!pages) {
            /*
             * Announced, but not to the phone. It is marked delivered and
             * stamped so the state machine treats it as announced: without
             * that it would decide 'send' on every tick forever, re-auditing
             * and re-upserting the inbox each time. The inbox item below is
             * where a warning actually lives.
             */
            state.delivered = true
            state.lastSentAtMs = nowMs
            result.suppressed += 1
          } else if (sendResult!.delivered) {
            state.delivered = true
            state.lastSentAtMs = nowMs
            if (action.kind === 'reminder') result.reminders += 1
            else result.sent += 1
          } else {
            result.sendFailures += 1
            // A failed ESCALATION must stay retryable too: keep the persisted
            // severity at the prior (announced) level so the next run re-detects
            // warning→critical instead of believing the escalation went out.
            if (prior && prior.delivered && prior.severity !== state.severity) {
              state.severity = prior.severity
            }
          }
          // saveState is the STATE-MACHINE-CRITICAL write and comes first: a
          // failed saveState re-pages next tick (the documented ar-M16 trade).
          // Audit and inbox are best-effort AFTER it — their failure must never
          // cost the delivered marker (that is what duplicate-pages); the inbox
          // self-heals at reminder time via the upsert.
          await saveState(db, key, state)
          result.statesPersisted += 1
          try {
            await auditOpsAlert(
              db,
              // Never 'delivered' for something that did not leave the
              // building: a suppressed warning gets its own event so the audit
              // trail cannot be read as a page that was sent.
              !pages
                ? 'ops-alert-suppressed'
                : sendResult!.delivered
                  ? action.kind === 'reminder'
                    ? 'ops-alert-reminded'
                    : 'ops-alert-delivered'
                  : 'ops-alert-failed',
              key,
              action.transition,
              sendResult?.status ?? null,
            )
          } catch {
            consola.error(`[${OPS_ALERT_WORKER}] audit write failed for condition=${key}`)
          }
          // A5: inbox parity is independent of delivery success.
          try {
            const upserted = await upsertConditionInbox(
              db,
              key as OpsAlertConditionKey,
              state.severity,
              obs?.count,
              now,
              action.kind,
              { reason: obs?.reason, correlationId: obs?.correlationId },
            )
            if (upserted === 'created') result.inboxCreated += 1
            else if (upserted === 'updated') result.inboxUpdated += 1
          } catch {
            consola.error(`[${OPS_ALERT_WORKER}] inbox upsert failed for condition=${key}`)
          }
          break
        }
        case 'send-recovery': {
          if (notifyBudgetSpent()) {
            result.notifyDeferred += 1
            break
          }
          notifyAttempts += 1
          const payload = buildNtfyPayload({
            severity: 'info',
            condition: key as OpsAlertConditionKey,
            env: envTag,
            ts: now,
          })
          const sendResult = await notify(payload, 'recovered')
          if (sendResult.delivered) {
            result.recoveries += 1
            try {
              await auditOpsAlert(db, 'ops-alert-recovered', key, action.transition, sendResult.status)
            } catch {
              consola.error(`[${OPS_ALERT_WORKER}] audit write failed for condition=${key}`)
            }
            // resolve BEFORE deleteState (CRITICAL PATH): if the resolve throws
            // the state row survives, so next tick re-sends recovery and retries
            // the resolve — a duplicate recovery notice, self-healing, versus a
            // permanently stranded open inbox row if the key were already gone.
            result.inboxResolved += await resolveConditionInbox(db, key, now)
            await deleteState(db, key)
            result.statesDeleted += 1
          } else {
            // Keep the key: the recovery notice retries next run (same ar-M16
            // shape as an alert — an unannounced recovery is not a recovery).
            result.sendFailures += 1
            try {
              await auditOpsAlert(db, 'ops-alert-failed', key, action.transition, sendResult.status)
            } catch {
              consola.error(`[${OPS_ALERT_WORKER}] audit write failed for condition=${key}`)
            }
          }
          break
        }
      }
    } catch {
      result.keyErrors += 1
      consola.error(`[${OPS_ALERT_WORKER}] state-machine step failed for condition=${key}`)
    }
  }

  if (result.notifyDeferred > 0) {
    consola.warn(
      `[${OPS_ALERT_WORKER}] notify budget spent (${MAX_NOTIFY_PER_TICK}/tick) — deferred=${result.notifyDeferred} sends retry next tick`,
    )
  }

  result.durationMs = Date.now() - startedMono
  return result
}

// ── Fleet + aging queries ─────────────────────────────────────────────────────

interface FailingWorker {
  name: string
  streak: number
}

async function evaluateFleet(
  db: Db,
  workers: ReadonlyArray<{ name: string; recommendedCron: string }>,
  nowMs: number,
): Promise<FailingWorker[]> {
  const lookbackStartIso = new Date(nowMs - FLEET_LOOKBACK_MS).toISOString()
  // Top-N recent rows per worker (streak + wedged-running evidence) and the
  // freshest success per worker (deadline leg) — both bounded by the 8-day
  // lookback (ar-M14) over the 0137 (started_at) index. Name filtering happens
  // in JS: the injected-workers seam and the registry share one query shape.
  const runRows = await db.execute<{ worker_name: string; status: string; started_at_ms: string }>(sql`
    SELECT worker_name, status, started_at_ms
      FROM (
        SELECT worker_name, status,
               (EXTRACT(EPOCH FROM started_at) * 1000)::bigint::text AS started_at_ms,
               ROW_NUMBER() OVER (PARTITION BY worker_name ORDER BY started_at DESC, id DESC) AS rn
          FROM worker_run
         WHERE started_at > ${lookbackStartIso}::timestamptz
      ) ranked
     WHERE rn <= ${FLEET_RUNS_PER_WORKER}
     ORDER BY worker_name, rn
  `)
  const successRows = await db.execute<{ worker_name: string; last_ms: string }>(sql`
    SELECT worker_name,
           (EXTRACT(EPOCH FROM MAX(started_at)) * 1000)::bigint::text AS last_ms
      FROM worker_run
     WHERE started_at > ${lookbackStartIso}::timestamptz
       AND status = 'success'
     GROUP BY worker_name
  `)

  const runsByWorker = new Map<string, FleetRun[]>()
  for (const r of runRows) {
    const list = runsByWorker.get(r.worker_name) ?? []
    list.push({ status: r.status, startedAtMs: Number(r.started_at_ms) })
    runsByWorker.set(r.worker_name, list)
  }
  const lastSuccessByWorker = new Map<string, number>()
  for (const r of successRows) lastSuccessByWorker.set(r.worker_name, Number(r.last_ms))

  const failing: FailingWorker[] = []
  for (const w of workers) {
    const deadlineMs = workerDeadlineMs(w.recommendedCron)
    if (deadlineMs === null) {
      consola.warn(`[${OPS_ALERT_WORKER}] cannot parse recommendedCron for worker=${w.name} — fleet predicate skipped for it`)
      continue
    }
    const verdict = isWorkerFailing({
      runs: runsByWorker.get(w.name) ?? [],
      lastSuccessMs: lastSuccessByWorker.get(w.name) ?? null,
      deadlineMs,
      nowMs,
    })
    if (verdict.failing) failing.push({ name: w.name, streak: verdict.streak })
  }
  return failing
}

/*
 * A2.4 — unacknowledged admin-routed alerts older than the age bar. The
 * PRECISE open-state predicate (ar-M17): 'unread' and 'read' are
 * unacknowledged; 'acknowledged' means an operator has seen it and is on it
 * (no page needed), 'dismissed'/'resolved' are closed. Counts ROWS — an alert
 * fanned out to N admins that all of them ignored counts N times, which is the
 * honest measure of "nobody is reading this inbox".
 */
