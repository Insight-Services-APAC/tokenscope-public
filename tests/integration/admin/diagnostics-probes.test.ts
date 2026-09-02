// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/probes — the network-bound half of the
 * diagnostics snapshot (docs/design/admin-nav-responsiveness.md D4).
 *
 * The handler reads no table, so this is a handler test without a database:
 * the role gate resolves through injectTestSession. What it pins:
 *   (a) the response carries exactly `services` + `telemetryRead`;
 *   (b) an UNCONFIGURED reader (getTelemetryReader throws) is an errored
 *       telemetryRead, never a throw — and the raw configuration error (which
 *       names an env var) does not leak past the classifier;
 *   (c) a probe that hangs past the 5 s budget resolves as timed out within
 *       ~5.5 s, in the same errored shape;
 *   (d) the reader is asked for a 5 s bound of its own (the argument exists so
 *       the SDK aborts the query server-side too);
 *   (e) a developer is refused.
 *
 * (c) is the test that goes red if the bound is lifted: its own timeout is 8 s,
 * so a 60 s race fails here instead of hanging the file for a minute.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { ReaderHealth, TelemetryReader } from '../../../server/azure/reader'
import type { ServiceProbe } from '../../../scripts/preflight'
import { snapshotEnv } from '../../helpers/env-snapshot'

// Per-test doubles. `null` = fall through to the real implementation, which for
// the reader means the factory's own "not configured" throw (test b).
const doubles = vi.hoisted(() => ({
  reader: null as null | (() => TelemetryReader),
  probeServices: null as null | (() => Promise<ServiceProbe[]>),
}))

vi.mock('../../../server/azure/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/azure/reader')>()
  return {
    ...actual,
    getTelemetryReader: (opts?: { lookbackDays?: number }) =>
      doubles.reader ? doubles.reader() : actual.getTelemetryReader(opts),
  }
})

vi.mock('../../../scripts/preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../scripts/preflight')>()
  return {
    ...actual,
    probeServices: (...args: Parameters<typeof actual.probeServices>) =>
      doubles.probeServices ? doubles.probeServices() : actual.probeServices(...args),
  }
})

const REGION = '9a1e0000-0000-4000-8000-000000000001'
const adminSession = (): Session => ({
  teammateId: '9a1e0000-0000-4000-8000-0000000000a1',
  email: 'probes-admin@x.test',
  displayName: 'Admin',
  role: 'admin',
  regionId: REGION,
  orgPath: 'probes.svc',
})
const devSession = (): Session => ({
  teammateId: '9a1e0000-0000-4000-8000-0000000000d1',
  email: 'probes-dev@x.test',
  displayName: 'Dev',
  role: 'developer',
  regionId: REGION,
  orgPath: 'probes.svc',
})

function makeEvent(session: Session) {
  const cookies = new Map<string, string>()
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const ev = {
    cookies,
    method: 'GET',
    path: '/api/v1/admin/diagnostics/probes',
    context: { params: {} },
    node: {
      req: {
        method: 'GET',
        url: '/api/v1/admin/diagnostics/probes',
        get headers() {
          return { ...headers, cookie: '', 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(name: string) { return this._headers[name.toLowerCase()] },
        setHeader(name: string, value: string | string[]) { this._headers[name.toLowerCase()] = value },
        removeHeader(name: string) { this._headers[name.toLowerCase()] = '' },
        appendHeader() {},
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(ev as unknown as Parameters<typeof injectTestSession>[0], session)
  return ev
}

interface ProbesResp {
  services: ServiceProbe[]
  telemetryRead: ReaderHealth | { ok: false; kind: 'unknown'; latencyMs: null; error: string; correlationId: string }
}

async function loadHandler() {
  return (await import('../../../server/api/v1/admin/diagnostics/probes.get'))
    .default as (event: unknown) => Promise<ProbesResp>
}

/** A reader whose healthCheck never settles — the wedged-endpoint case. */
const hangingReader = (): TelemetryReader =>
  ({
    healthCheck: () => new Promise<ReaderHealth>(() => {}),
  }) as unknown as TelemetryReader

const restoreEnv = snapshotEnv()

beforeAll(() => {
  process.env.NUXT_SESSION_SECRET = 'diagnostics-probes-padded-to-32-chars!!'
  // Unconfigured reader on both branches: the factory must throw, not build.
  delete process.env.NUXT_TELEMETRY_READER
  delete process.env.NUXT_AZURE_MONITOR_ENDPOINT
  delete process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID
  // A resolvable service so the timeout path has a row to mark. Credentials in
  // the URL exist to prove they never reach the response.
  process.env.DATABASE_URL = 'postgres://probe-user:hunter2-secret@db.internal:5432/tokenscope'
  delete process.env.REDIS_URL
  delete process.env.AZURE_KEYVAULT_URL
})

afterAll(restoreEnv)

afterEach(() => {
  doubles.reader = null
  doubles.probeServices = null
  vi.restoreAllMocks()
})

describe('GET /api/v1/admin/diagnostics/probes', () => {
  it('(e) REJECTS a developer — the gate of the snapshot it was cut from', async () => {
    const handler = await loadHandler()
    await expect(handler(makeEvent(devSession()))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('(a)+(b) answers with exactly services + telemetryRead; an unconfigured reader is an errored read, not a throw', async () => {
    // TCP probes answer instantly so this test measures the reader path only.
    doubles.probeServices = async () => []
    const handler = await loadHandler()
    const res = await handler(makeEvent(adminSession()))

    expect(Object.keys(res).sort()).toEqual(['services', 'telemetryRead'])
    expect(Array.isArray(res.services)).toBe(true)
    expect(res.telemetryRead).toMatchObject({ ok: false, kind: 'unknown', latencyMs: null })
    expect(typeof res.telemetryRead.error).toBe('string')
    expect(typeof (res.telemetryRead as { correlationId?: unknown }).correlationId).toBe('string')
    // The factory's throw names the env var it wants; that message is for the
    // server log (under the correlation id), never the response.
    expect(JSON.stringify(res)).not.toMatch(/NUXT_AZURE_MONITOR_ENDPOINT|not set/)
  })

  it('(c) a probe that hangs past the budget resolves as timed out within ~5.5 s, in the errored shape', async () => {
    doubles.reader = hangingReader
    doubles.probeServices = () => new Promise<ServiceProbe[]>(() => {})
    const handler = await loadHandler()

    const started = Date.now()
    const res = await handler(makeEvent(adminSession()))
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(4900)
    expect(elapsed).toBeLessThan(5500)

    // The reader's overrun is classified like any other unreachable probe.
    expect(res.telemetryRead).toMatchObject({ ok: false, kind: 'unknown', latencyMs: null, error: 'driver-unreachable' })
    expect(typeof (res.telemetryRead as { correlationId?: unknown }).correlationId).toBe('string')

    // The services list keeps its per-service shape: the resolved endpoint reads
    // unreachable/timeout, the unset ones stay skipped, and the connection
    // string's credentials are nowhere in it.
    const pg = res.services.find((s) => s.name === 'postgres')
    expect(pg).toMatchObject({ status: 'unreachable', errorClass: 'timeout', error: 'ETIMEDOUT', target: 'db.internal:5432', latencyMs: null })
    expect(res.services.find((s) => s.name === 'redis')).toMatchObject({ status: 'skipped', target: null })
    expect(JSON.stringify(res.services)).not.toMatch(/hunter2|probe-user/)
  }, 8000)

  it('(d) passes the reader its own 5 s bound and returns a healthy read verbatim', async () => {
    const healthCheck = vi.fn(async (): Promise<ReaderHealth> => ({ ok: true, kind: 'log-analytics', latencyMs: 42 }))
    doubles.reader = () => ({ healthCheck }) as unknown as TelemetryReader
    doubles.probeServices = async () => [
      { name: 'postgres', critical: true, status: 'ok', target: 'db.internal:5432', latencyMs: 3 },
    ]
    const handler = await loadHandler()
    const res = await handler(makeEvent(adminSession()))

    expect(healthCheck).toHaveBeenCalledWith({ timeoutMs: 5000 })
    expect(res.telemetryRead).toEqual({ ok: true, kind: 'log-analytics', latencyMs: 42 })
    expect(res.services).toEqual([
      { name: 'postgres', critical: true, status: 'ok', target: 'db.internal:5432', latencyMs: 3 },
    ])
  })
})
