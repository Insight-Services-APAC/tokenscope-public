// @vitest-environment node
/*
 * sendOpsNotification — the A1 channel POST (docs/design/ops-alerting.md):
 * priority mapping (urgent for critical, default otherwise), the Title shape,
 * disabled-on-empty-URL, and 2xx-only `delivered` (the ar-M16 gate). The
 * fetch is injected — no network.
 */
import { describe, it, expect } from 'vitest'
import { buildNtfyPayload } from '../../../shared/ops-alert/conditions'
import { ntfyPriority, ntfyTitle, sendOpsNotification } from '../../../server/observability/ops-notify'

const TS = new Date('2026-07-01T10:00:00Z')
const URL_OK = 'https://ntfy.sh/x0000000000000000000000000000000000000000000000000000000000000000'

function capture(status: number) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(null, { status })
  }) as typeof fetch
  return { calls, fetchFn }
}

const critical = buildNtfyPayload({ severity: 'critical', condition: 'telemetry-read', env: 'dev', ts: TS })
const warning = buildNtfyPayload({ severity: 'warning', condition: 'inbox-aging', env: 'dev', ts: TS, count: 7 })

describe('sendOpsNotification', () => {
  it('empty URL = disabled (the sandbox/local default) — nothing is sent', async () => {
    const { calls, fetchFn } = capture(200)
    const res = await sendOpsNotification(critical, 'alert', { url: '', fetchFn })
    expect(res).toEqual({ delivered: false, status: null, disabled: true })
    expect(calls.length).toBe(0)
  })

  it('critical → Priority urgent; Title names env + severity + condition', async () => {
    const { calls, fetchFn } = capture(200)
    const res = await sendOpsNotification(critical, 'alert', { url: URL_OK, fetchFn })
    expect(res.delivered).toBe(true)
    expect(res.status).toBe(200)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Priority).toBe('urgent')
    expect(headers.Title).toBe('TokenScope DEV critical: telemetry-read')
  })

  it('warning → default priority; body carries only allowlisted fields', async () => {
    const { calls, fetchFn } = capture(200)
    await sendOpsNotification(warning, 'alert', { url: URL_OK, fetchFn })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Priority).toBe('default')
    const body = String(calls[0]!.init.body)
    expect(body).toContain('condition: inbox-aging')
    expect(body).toContain('count: 7')
    // Every body line is one of the allowlisted fields — nothing else rides.
    for (const line of body.split('\n')) {
      expect(line).toMatch(/^(condition|severity|env|ts|count): /)
    }
  })

  it('recovered → Title says recovered, priority default even off a critical', async () => {
    expect(ntfyTitle(critical, 'recovered')).toBe('TokenScope DEV recovered: telemetry-read')
    expect(ntfyPriority(critical, 'recovered')).toBe('default')
  })

  it('a non-2xx is NOT delivered (ar-M16: the state machine retries next run)', async () => {
    const { fetchFn } = capture(503)
    const res = await sendOpsNotification(critical, 'alert', { url: URL_OK, fetchFn })
    expect(res).toEqual({ delivered: false, status: 503, disabled: false })
  })

  it('a thrown fetch resolves undelivered with a null status — never throws', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const res = await sendOpsNotification(critical, 'alert', { url: URL_OK, fetchFn })
    expect(res).toEqual({ delivered: false, status: null, disabled: false })
  })
})
