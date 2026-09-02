// @vitest-environment node
/*
 * The A1 payload allowlist (ops-alerting ar-H9, owner ruling) + the condition
 * vocabulary. The channel is a PUBLIC ntfy.sh topic, so the payload-shape test
 * is the pin: buildNtfyPayload may emit ONLY severity / condition / env / ts /
 * count — an unknown key escaping it turns this file red.
 */
import { describe, it, expect } from 'vitest'
import {
  OPS_ALERT_CONDITION,
  OPS_ALERT_PAYLOAD_ALLOWLIST,
  OPS_ALERT_REASONS,
  OPS_ALERT_SEVERITIES,
  buildNtfyPayload,
  isOpsAlertReason,
  workerConditionKey,
} from '../../../shared/ops-alert/conditions'
import { PROBE_ERROR_REASONS } from '../../../shared/observability/probe-error-reason'

const TS = new Date('2026-07-01T10:00:00Z')

describe('buildNtfyPayload — the ar-H9 allowlist', () => {
  it('emits exactly the allowlisted keys and nothing else', () => {
    const payload = buildNtfyPayload({
      severity: 'critical',
      condition: 'telemetry-read',
      env: 'dev',
      ts: TS,
      count: 3,
    })
    expect(Object.keys(payload).sort()).toEqual([...OPS_ALERT_PAYLOAD_ALLOWLIST].sort())
    for (const key of Object.keys(payload)) {
      expect(OPS_ALERT_PAYLOAD_ALLOWLIST, `unknown payload key '${key}'`).toContain(key)
    }
  })

  it('cannot be smuggled extra fields through the input (never a spread)', () => {
    // A hostile/buggy caller hands extra properties — hostname, error text —
    // that must be structurally impossible to emit.
    const dirty = {
      severity: 'warning',
      condition: 'inbox-aging',
      env: 'dev',
      ts: TS,
      count: 2,
      hostname: 'pg-flex-dev.internal', // must NOT survive
      errorText: 'ECONNREFUSED 10.0.0.55', // must NOT survive
      teammate: 'someone@example.com', // must NOT survive
    } as unknown as Parameters<typeof buildNtfyPayload>[0]
    const payload = buildNtfyPayload(dirty)
    expect(Object.keys(payload).sort()).toEqual([...OPS_ALERT_PAYLOAD_ALLOWLIST].sort())
    expect(JSON.stringify(payload)).not.toContain('pg-flex-dev')
    expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(payload)).not.toContain('example.com')
  })

  it('carries NEITHER reason NOR correlationId, even when handed both (D2 — ar-H9 stands)', () => {
    // The diagnosability change adds a reason + probe correlation id to every
    // observation. They are for worker_run.result and the AUTHENTICATED admin
    // inbox; ntfy.sh is a public topic. This is the regression guard: a future
    // "just add the reason, it's only an enum" turns this red.
    const withDiagnosis = {
      severity: 'critical',
      condition: 'telemetry-read',
      env: 'dev',
      ts: TS,
      count: 1,
      reason: 'driver-unreachable',
      correlationId: '4f2c1b90-8a3d-4e51-9c77-b0e2a1d3f645',
    } as unknown as Parameters<typeof buildNtfyPayload>[0]
    const payload = buildNtfyPayload(withDiagnosis)
    expect(Object.keys(payload).sort()).toEqual([...OPS_ALERT_PAYLOAD_ALLOWLIST].sort())
    expect('reason' in payload).toBe(false)
    expect('correlationId' in payload).toBe(false)
    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain('driver-unreachable')
    expect(serialised).not.toContain('4f2c1b90')
    // …and neither field is even expressible on the payload type.
    expect(OPS_ALERT_PAYLOAD_ALLOWLIST as readonly string[]).not.toContain('reason')
    expect(OPS_ALERT_PAYLOAD_ALLOWLIST as readonly string[]).not.toContain('correlationId')
  })

  it('omits count when absent / non-finite, and serialises ts as UTC ISO-8601', () => {
    const payload = buildNtfyPayload({ severity: 'info', condition: 'channel-test', env: 'dev', ts: TS })
    expect('count' in payload).toBe(false)
    expect(payload.ts).toBe('2026-07-01T10:00:00.000Z')
    const nan = buildNtfyPayload({ severity: 'info', condition: 'channel-test', env: 'dev', ts: TS, count: Number.NaN })
    expect('count' in nan).toBe(false)
  })
})

describe('condition constants (design A1/A2)', () => {
  it('pins the fixed condition keys', () => {
    expect(Object.values(OPS_ALERT_CONDITION).sort()).toEqual(
      ['attribution-stall', 'channel-test', 'probe-network', 'telemetry-read', 'worker-fleet'].sort(),
    )
    expect(workerConditionKey('azure-monitor-read')).toBe('worker:azure-monitor-read')
  })

  it('pins the severity set', () => {
    expect([...OPS_ALERT_SEVERITIES]).toEqual(['critical', 'warning', 'info'])
  })
})

describe('OpsAlertReason — the CLOSED reason vocabulary (D1)', () => {
  it('covers every condition the worker can raise, plus the classified probe reasons', () => {
    expect([...OPS_ALERT_REASONS].sort()).toEqual(
      [
        // Raised by this worker.
        'probe-timeout',
        'probe-threw',
        'probe-unhealthy',
        'hosts-failing',
        'zero-write-streak',
        'workers-failing',
        'worker-failing',
        'items-aged',
        'manual-test',
        // Unioned in from redact-probe-error's classifier, never restated.
        ...PROBE_ERROR_REASONS,
      ].sort(),
    )
  })

  it('includes EVERY classifyProbeError reason — the union, not a snapshot of it', () => {
    // A new driver code classified in redact-probe-error.ts must be expressible
    // here without anyone remembering to copy it across.
    for (const r of PROBE_ERROR_REASONS) {
      expect(isOpsAlertReason(r), `classified reason '${r}' is not in the ops-alert union`).toBe(true)
    }
  })

  it('is CLOSED — free text and driver messages are not reasons', () => {
    expect(isOpsAlertReason('connect ECONNREFUSED 10.0.0.55:5432')).toBe(false)
    expect(isOpsAlertReason('query status=Failure')).toBe(false)
    expect(isOpsAlertReason('HTTP 404')).toBe(false)
    expect(isOpsAlertReason('')).toBe(false)
    expect(isOpsAlertReason(undefined)).toBe(false)
    expect(isOpsAlertReason(null)).toBe(false)
  })
})

