/*
 * Ops-alerting shared vocabulary — condition keys, severities, observation
 * REASONS, the EXTERNAL payload allowlist and the admin-routed inbox categories
 * the aging scan reads.
 *
 * Design: docs/design/ops-alerting.md (A1/A2) and
 * docs/design/alert-diagnosability.md (D1/D2 — the reason vocabulary). The
 * constraints this module carries:
 *   - The payload allowlist is an owner ruling (ar-H9): the ntfy topic is a
 *     public channel, so a notification may carry NOTHING beyond severity,
 *     condition key, environment tag, UTC timestamp and an aggregate count.
 *     buildNtfyPayload is the ONLY constructor — it copies field by field and
 *     can never emit a key outside OPS_ALERT_PAYLOAD_ALLOWLIST.
 *   - OpsAlertReason is CLOSED and INTERNAL. Closed so an operator-facing
 *     string can never carry a hostname or a driver message; internal because
 *     it is deliberately absent from OPS_ALERT_PAYLOAD_ALLOWLIST (D2 —
 *     ar-H9 stands: the reason reaches worker_run.result and the admin inbox
 *     body, never the public topic).
 */
import { PROBE_ERROR_REASONS, type ProbeErrorReason } from '../observability/probe-error-reason'

/** The fixed condition keys (A2.1–A2.4 + the A7 deploy-time channel test). */
export const OPS_ALERT_CONDITION = {
  /** A2.1 — the reader probe: a bounded read of the joiner's real table failed (ar-H1). */
  telemetryRead: 'telemetry-read',
  /** A2.2 — joiner writing nothing while the fleet still emits (time-integrated). */
  attributionStall: 'attribution-stall',
  /** A2.3 — ≥ OPS_ALERT_FLEET_THRESHOLD workers independently failing (ar-M11). */
  workerFleet: 'worker-fleet',
  /** A2.1 — runNetworkCheck: an expectPrivate host failed DNS/TCP. */
  probeNetwork: 'probe-network',
  /** A7 — the deploy-time live channel validation ping (ar-M21). Never raised by the worker. */
  channelTest: 'channel-test',
} as const

/** A2.3 — one failing worker raises its own per-worker condition key. */
export function workerConditionKey(workerName: string): `worker:${string}` {
  return `worker:${workerName}`
}

export type OpsAlertConditionKey =
  | (typeof OPS_ALERT_CONDITION)[keyof typeof OPS_ALERT_CONDITION]
  | `worker:${string}`

const FIXED_CONDITION_KEYS: ReadonlySet<string> = new Set(Object.values(OPS_ALERT_CONDITION))

/*
 * Membership guard for PERSISTED condition keys. A kv key re-enters the state
 * machine and — on reminder/recovery — the public ntfy payload, so it must be
 * validated against the condition vocabulary first (ar-H9: only vocabulary
 * strings may reach the channel): the fixed keys, or `worker:<name>` where
 * <name> is in the caller-supplied worker-name set (the live registry).
 */
export function isOpsAlertConditionKey(
  key: string,
  workerNames: ReadonlySet<string>,
): key is OpsAlertConditionKey {
  if (FIXED_CONDITION_KEYS.has(key)) return true
  return key.startsWith('worker:') && workerNames.has(key.slice('worker:'.length))
}

/*
 * Severities. BOTH 'critical' and 'warning' take two-run damping (A3 as
 * amended by alert-diagnosability D3 — first-observation criticals produced
 * only false pages). 'info' exists for the A7 channel-test ping and the
 * RECOVERED notice — it never enters the state machine as a condition severity.
 */
export const OPS_ALERT_SEVERITIES = ['critical', 'warning', 'info'] as const
export type OpsAlertSeverity = (typeof OPS_ALERT_SEVERITIES)[number]

/*
 * WHY an observation raised the severity it did. A blown probe budget and a
 * provider fault are different faults with different fixes and MUST NOT share a
 * reason (docs/design/alert-diagnosability.md D1).
 *
 * The reasons this worker RAISES itself. The classified probe reasons are
 * unioned in below from PROBE_ERROR_REASONS rather than restated — a second
 * copy would drift the moment redact-probe-error.ts classifies a new code.
 */
const OPS_ALERT_OWN_REASONS = [
  /** boundedCall lost the race: the probe never answered inside its budget. */
  'probe-timeout',
  /** boundedCall caught: the probe threw instead of returning a verdict. */
  'probe-threw',
  /**
   * The probe ANSWERED unhealthy with a non-classified status (`HTTP 404`,
   * `query status=Failure`). Distinct from a timeout AND from a classified
   * driver fault; the status string itself is free text and never travels.
   */
  'probe-unhealthy',
  /** probe-network: expectPrivate hosts failing DNS/TCP (+count = how many). */
  'hosts-failing',
  /** attribution-stall: the joiner's consecutive zero-write runs (+count). */
  'zero-write-streak',
  /** worker-fleet: ≥ threshold workers independently failing (+count). */
  'workers-failing',
  /** worker:<name>: one worker's consecutive-failure streak (+count). */
  'worker-failing',
  /** inbox-aging: unacknowledged admin-routed alerts past the age bar (+count). */
  'items-aged',
  /** channel-test: the A7 deploy-time live-channel ping, not an outage. */
  'manual-test',
] as const

/** The closed reason vocabulary: this worker's own reasons ∪ the classified ones. */
export const OPS_ALERT_REASONS = [...OPS_ALERT_OWN_REASONS, ...PROBE_ERROR_REASONS] as const
export type OpsAlertReason = (typeof OPS_ALERT_OWN_REASONS)[number] | ProbeErrorReason

const REASON_MEMBERS: ReadonlySet<string> = new Set(OPS_ALERT_REASONS)

/** Membership guard — a reason read back from a persisted record is data at rest. */
export function isOpsAlertReason(value: unknown): value is OpsAlertReason {
  return typeof value === 'string' && REASON_MEMBERS.has(value)
}

/*
 * The ONLY fields an external notification may carry (ar-H9, owner ruling).
 * Pinned by tests/unit/workers/ops-alert-payload.test.ts, which fails on any
 * key outside this list. No hostnames, IPs, error text, money, or
 * teammate/project/instance data — the condition key IS the message.
 *
 * `reason` and `correlationId` are DELIBERATELY absent (alert-diagnosability
 * D2): they exist to make an alert answerable from Admin, which is
 * authenticated; the ntfy topic is not. buildNtfyPayload never sees them.
 */
export const OPS_ALERT_PAYLOAD_ALLOWLIST = ['severity', 'condition', 'env', 'ts', 'count'] as const
export type OpsAlertPayloadField = (typeof OPS_ALERT_PAYLOAD_ALLOWLIST)[number]

export interface OpsAlertPayload {
  severity: OpsAlertSeverity
  condition: OpsAlertConditionKey
  /** Deployment environment tag ('dev', 'production', …) — never a hostname. */
  env: string
  /** UTC ISO-8601 instant of the evaluation. */
  ts: string
  /** Aggregate count where one exists (failing workers, aged items, failing hosts). */
  count?: number
}

/*
 * Build the external payload. Field-by-field on purpose — NEVER a spread of the
 * input (ar-H9): a caller smuggling extra properties (error text, a hostname)
 * must find them structurally impossible to emit, not merely discouraged.
 */
export function buildNtfyPayload(input: {
  severity: OpsAlertSeverity
  condition: OpsAlertConditionKey
  env: string
  ts: Date
  count?: number
}): OpsAlertPayload {
  const payload: OpsAlertPayload = {
    severity: input.severity,
    condition: input.condition,
    env: input.env,
    ts: input.ts.toISOString(),
  }
  if (typeof input.count === 'number' && Number.isFinite(input.count)) {
    payload.count = input.count
  }
  return payload
}

/** The inbox category the ops-alert worker writes its A5 parity items under. */
export const OPS_ALERT_INBOX_CATEGORY = 'ops-alert'

/*
 * A2.4 (inbox-aging) is GONE, and with it the admin-routed category list that
 * existed only to feed its scan.
 *
 * It counted admin-routed inbox items older than a threshold and paged while
 * that count was non-zero. Every part of that is a dashboard row rather than an
 * alert: the number only falls when a human opens the inbox, so on any
 * environment nobody triages it is permanently true and re-pages on the reminder
 * cadence forever. It also had no page of its own to answer "which items?",
 * which is the property every remaining condition now has to have
 * (tests/unit/workers/ops-alert-surface.test.ts).
 */
