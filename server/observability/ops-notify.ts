/*
 * ops-notify — the ONE code path that POSTs an ops alert to the external ntfy
 * channel (docs/design/ops-alerting.md A1).
 *
 * Constraints carried here:
 *   - The topic URL IS the credential (public ntfy.sh, 64-char CSPRNG topic —
 *     accepted residual ar-H8). Logging records destination HOST, HTTP status
 *     and condition key only — NEVER the full URL, and never a response body
 *     (ar-M20). Caught errors are logged by NAME only: a fetch error message
 *     can embed the URL.
 *   - Empty NUXT_OPS_ALERT_NTFY_URL = alerting disabled (the sandbox/local
 *     default) — the caller short-circuits, and this function answers
 *     `disabled` rather than throwing.
 *   - The request body/headers are built ONLY from the allowlisted payload
 *     fields (ar-H9) — buildNtfyPayload is the sole payload constructor.
 *   - Single attempt, 5 s timeout, bare global fetch — deliberately NOT
 *     resilientFetch: retry policy belongs to the A3 state machine (a failed
 *     POST leaves the condition retryable next run, ar-M16), and an in-call
 *     retry could double-page.
 */
import { consola } from 'consola'
import type { OpsAlertPayload } from '../../shared/ops-alert/conditions'

/** What a send is FOR — shapes the Title only; the payload body is unchanged. */
export type OpsNotifyKind = 'alert' | 'reminder' | 'recovered'

export interface OpsNotifyResult {
  /** True only on an HTTP 2xx — the A3 send-before-persist gate (ar-M16). */
  delivered: boolean
  /** HTTP status, or null when the request never completed (timeout/network). */
  status: number | null
  /** True when no channel is configured (empty NUXT_OPS_ALERT_NTFY_URL). */
  disabled: boolean
}

/** The notify seam the ops-alert worker injects for tests. */
export type OpsNotifyFn = (payload: OpsAlertPayload, kind: OpsNotifyKind) => Promise<OpsNotifyResult>

/** The configured channel URL, trimmed; '' = disabled. */
export function opsAlertNtfyUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NUXT_OPS_ALERT_NTFY_URL ?? '').trim()
}

const NTFY_TIMEOUT_MS = 5_000

/** ntfy Title, e.g. `TokenScope DEV critical: telemetry-read`. */
export function ntfyTitle(payload: OpsAlertPayload, kind: OpsNotifyKind): string {
  const label = kind === 'recovered' ? 'recovered' : payload.severity
  return `TokenScope ${payload.env.toUpperCase()} ${label}: ${payload.condition}`
}

/** ntfy priority: urgent for critical alerts/reminders, default otherwise (A1). */
export function ntfyPriority(payload: OpsAlertPayload, kind: OpsNotifyKind): string {
  return kind !== 'recovered' && payload.severity === 'critical' ? 'urgent' : 'default'
}

export async function sendOpsNotification(
  payload: OpsAlertPayload,
  kind: OpsNotifyKind,
  opts: { url?: string; timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<OpsNotifyResult> {
  const url = (opts.url ?? opsAlertNtfyUrl()).trim()
  if (!url) return { delivered: false, status: null, disabled: true }

  let host: string
  try {
    host = new URL(url).host
  } catch {
    // A malformed URL cannot be logged verbatim (it may still contain the
    // topic); report the failure class only.
    consola.error(`[ops-notify] channel URL is malformed — condition=${payload.condition} not sent`)
    return { delivered: false, status: null, disabled: false }
  }

  // Body lines are built from named allowlisted fields — never a serialisation
  // of an arbitrary object (ar-H9 belt-and-braces on top of buildNtfyPayload).
  const body = [
    `condition: ${payload.condition}`,
    `severity: ${payload.severity}`,
    `env: ${payload.env}`,
    `ts: ${payload.ts}`,
    ...(payload.count !== undefined ? [`count: ${payload.count}`] : []),
  ].join('\n')

  const doFetch = opts.fetchFn ?? fetch
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        Title: ntfyTitle(payload, kind),
        Priority: ntfyPriority(payload, kind),
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? NTFY_TIMEOUT_MS),
    })
    // Drain the body without reading it into anything we might log (ar-M20).
    await res.arrayBuffer().catch(() => undefined)
    const delivered = res.ok
    if (!delivered) {
      consola.warn(`[ops-notify] ntfy POST failed host=${host} status=${res.status} condition=${payload.condition}`)
    }
    return { delivered, status: res.status, disabled: false }
  } catch (err) {
    // Error NAME only (TimeoutError / AbortError / TypeError) — the message can
    // carry the URL, which is the credential (ar-M20).
    const name = err instanceof Error ? err.name : 'Error'
    consola.warn(`[ops-notify] ntfy POST errored host=${host} error=${name} condition=${payload.condition}`)
    return { delivered: false, status: null, disabled: false }
  }
}
