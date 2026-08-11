// @vitest-environment node
/*
 * S10 (S8 follow-up) — LocalCollectorReader.healthCheck() and
 * LogAnalyticsReader.healthCheck() both RESOLVE (never throw) with a raw
 * `err.message` in their `error` field on a caught exception. S8 fixed the
 * THROWING path's caller (diagnostics/index.get.ts's own try/catch), but a
 * RESOLVED value never reaches that catch block — so the raw driver/network
 * error (which can carry a host, port, or workspace id) was passed straight
 * through to an admin diagnostics page unredacted. This pins that both
 * readers now route through classifyProbeError the same way S8's fix does
 * elsewhere, and that the raw message goes to the log (via consola.error, not
 * asserted here) rather than the caller — never both, never neither.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../server/utils/resilient-fetch', () => ({
  resilientFetch: vi.fn(async () => {
    // A realistic fetch/network failure — the kind that carries topology
    // (host, port) an unauthenticated-adjacent admin probe must not leak.
    // Real Node/undici connection-refused errors carry `.code`, which is what
    // classifyProbeError actually classifies on (not the message text).
    const err = new Error('connect ECONNREFUSED 10.20.30.40:4318') as Error & { code: string }
    err.code = 'ECONNREFUSED'
    throw err
  }),
}))

const queryWorkspace = vi.fn(async () => {
  throw new Error('Unauthorized: workspace 8f19c2ad-secret-guid rejected the request')
})
vi.mock('@azure/monitor-query', () => ({
  LogsQueryClient: class {
    queryWorkspace = queryWorkspace
  },
  LogsQueryResultStatus: { Success: 'Success' },
  Durations: { oneDay: 'P1D', sevenDays: 'P7D' },
}))
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
}))

/* eslint-disable import/first */
import { LocalCollectorReader, LogAnalyticsReader } from '../../../server/azure/reader'
/* eslint-enable import/first */

describe('LocalCollectorReader.healthCheck — redacts a caught exception (S8 follow-up)', () => {
  it('never returns the raw connection error, and tags a correlation id back to the server log', async () => {
    const reader = new LocalCollectorReader('http://127.0.0.1:1')
    const health = await reader.healthCheck()
    expect(health.ok).toBe(false)
    expect(health.error).toBeDefined()
    // The raw message (and anything host/port-shaped from it) must never
    // reach the caller — only a classified, safe reason code.
    expect(health.error).not.toMatch(/10\.20\.30\.40/)
    expect(health.error).not.toMatch(/ECONNREFUSED/)
    expect(health.error).toBe('connect-refused') // classifyProbeError's code for ECONNREFUSED
    expect(health.correlationId).toBeDefined()
    expect(typeof health.correlationId).toBe('string')
  })

  it('an HTTP-status failure (not a caught exception) is unaffected — no secret to redact, no correlation id needed', async () => {
    const { resilientFetch } = await import('../../../server/utils/resilient-fetch')
    vi.mocked(resilientFetch).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const reader = new LocalCollectorReader('http://127.0.0.1:1')
    const health = await reader.healthCheck()
    expect(health.error).toBe('HTTP 503')
    expect(health.correlationId).toBeUndefined()
  })
})

describe('LogAnalyticsReader.healthCheck — redacts a caught exception (S8 follow-up)', () => {
  it('never returns the raw Azure SDK error, and tags a correlation id back to the server log', async () => {
    const reader = new LogAnalyticsReader('ws-id', {})
    const health = await reader.healthCheck()
    expect(health.ok).toBe(false)
    expect(health.error).toBeDefined()
    expect(health.error).not.toMatch(/8f19c2ad-secret-guid/)
    expect(health.error).not.toMatch(/Unauthorized/)
    expect(health.correlationId).toBeDefined()
    expect(typeof health.correlationId).toBe('string')
  })

  it('a non-success query STATUS (not a caught exception) is unaffected — no secret to redact', async () => {
    queryWorkspace.mockResolvedValueOnce({ status: 'Failed' } as never)
    const reader = new LogAnalyticsReader('ws-id', {})
    const health = await reader.healthCheck()
    expect(health.error).toBe('query status=Failed')
    expect(health.correlationId).toBeUndefined()
  })
})
