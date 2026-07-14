// @vitest-environment node
/*
 * mintAzureMonitorBearer — mode switch + token caching/refresh. The real MI
 * mint runs only on Azure compute (IMDS); here we inject getToken to lock
 * the caching/refresh logic and the mock fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mintAzureMonitorBearer,
  _resetAzureMonitorBearerCache,
  assertAzureMonitorIngestScope,
  type GetTokenFn,
} from '../../../server/auth/obo'

const ENV = process.env.NUXT_AZURE_MONITOR_AUTH

beforeEach(() => _resetAzureMonitorBearerCache())
afterEach(() => {
  if (ENV === undefined) delete process.env.NUXT_AZURE_MONITOR_AUTH
  else process.env.NUXT_AZURE_MONITOR_AUTH = ENV
})

describe('mintAzureMonitorBearer — mock mode (default)', () => {
  it('returns a deterministic mock bearer when not in mi mode', async () => {
    delete process.env.NUXT_AZURE_MONITOR_AUTH
    const a = await mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's' })
    const b = await mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's' })
    expect(a.bearer).toMatch(/^mock-monitor-bearer-/)
    expect(a.bearer).toBe(b.bearer)
  })
})

describe('mintAzureMonitorBearer — mi mode', () => {
  it('mints via getToken, caches within TTL, re-mints after refresh skew', async () => {
    process.env.NUXT_AZURE_MONITOR_AUTH = 'mi'
    let calls = 0
    const t0 = 1_000_000_000_000
    const getToken: GetTokenFn = async (scope) => {
      expect(scope).toBe('https://monitor.azure.com/.default')
      calls += 1
      return { token: `azure-token-${calls}`, expiresOnTimestamp: t0 + 60 * 60 * 1000 } // +1h
    }

    const first = await mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's', getToken, now: t0 })
    expect(first.bearer).toBe('azure-token-1')
    expect(calls).toBe(1)

    // Within TTL (10 min later) → cache hit, no new mint.
    const second = await mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's', getToken, now: t0 + 10 * 60 * 1000 })
    expect(second.bearer).toBe('azure-token-1')
    expect(calls).toBe(1)

    // Past expiry−skew (within the last 5 min before expiry) → re-mint.
    const third = await mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's', getToken, now: t0 + 58 * 60 * 1000 })
    expect(third.bearer).toBe('azure-token-2')
    expect(calls).toBe(2)
  })

  it('surfaces a null MI token as an error', async () => {
    process.env.NUXT_AZURE_MONITOR_AUTH = 'mi'
    const getToken: GetTokenFn = async () => {
      throw new Error('ManagedIdentityCredential.getToken returned null')
    }
    await expect(mintAzureMonitorBearer({ principalOid: 'p', sessionId: 's', getToken })).rejects.toThrow(/null/)
  })
})

describe('mintAzureMonitorBearer — static seam allowlist gating', () => {
  // static mode hands a REAL operator-minted Azure token to clients, so it must be
  // impossible on any DEPLOYED env. Bare-local/CI (no NUXT_DEPLOY_ENV, NODE_ENV!==
  // 'production') must keep working with zero flags.
  const savedNode = process.env.NODE_ENV
  beforeEach(() => {
    process.env.NUXT_AZURE_MONITOR_AUTH = 'static'
    process.env.NUXT_AZURE_MONITOR_STATIC_BEARER = 'static-test-token'
    process.env.NODE_ENV = 'test'
    delete process.env.NUXT_DEPLOY_ENV
    delete process.env.NUXT_ALLOW_STATIC_BEARER
    delete process.env.NUXT_OIDC_AUTH_DEV_MODE
  })
  afterEach(() => {
    delete process.env.NUXT_AZURE_MONITOR_STATIC_BEARER
    delete process.env.NUXT_DEPLOY_ENV
    delete process.env.NUXT_ALLOW_STATIC_BEARER
    if (savedNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedNode
  })
  const call = () => mintAzureMonitorBearer({ principalOid: 'oid', sessionId: 's' })

  it('ALLOWED on bare local/test (no NUXT_DEPLOY_ENV, NODE_ENV=test) with zero flags', async () => {
    expect((await call()).bearer).toBe('static-test-token')
  })

  it('REFUSED on deployed dev/staging/production', async () => {
    for (const e of ['dev', 'staging', 'production']) {
      process.env.NUXT_DEPLOY_ENV = e
      await expect(call()).rejects.toThrow(/refused off a demo-capable env/)
    }
  })

  it('REFUSED with dropped NUXT_DEPLOY_ENV on a deployed container (NODE_ENV=production → unknown)', async () => {
    process.env.NODE_ENV = 'production'
    await expect(call()).rejects.toThrow(/refused/)
  })

  it('ALLOWED on a deployed env ONLY with explicit NUXT_ALLOW_STATIC_BEARER=1', async () => {
    process.env.NUXT_DEPLOY_ENV = 'dev'
    process.env.NUXT_ALLOW_STATIC_BEARER = '1'
    expect((await call()).bearer).toBe('static-test-token')
  })

  it('ALLOWED on sandbox (demo-capable)', async () => {
    process.env.NUXT_DEPLOY_ENV = 'sandbox'
    expect((await call()).bearer).toBe('static-test-token')
  })
})

describe('assertAzureMonitorIngestScope — the read/write wall guard', () => {
  it('accepts the commercial Azure Monitor ingest audience', () => {
    expect(() => assertAzureMonitorIngestScope('https://monitor.azure.com/.default')).not.toThrow()
  })

  it('accepts sovereign-cloud ingest audiences (us / cn)', () => {
    expect(() => assertAzureMonitorIngestScope('https://monitor.azure.us/.default')).not.toThrow()
    expect(() => assertAzureMonitorIngestScope('https://monitor.azure.cn/.default')).not.toThrow()
  })

  it('REJECTS the Log Analytics QUERY audience (the dangerous misconfig)', () => {
    // This is the one that would hand clients a read-capable token.
    expect(() => assertAzureMonitorIngestScope('https://api.loganalytics.io/.default')).toThrow(
      /read-capable token/,
    )
  })

  it('rejects ARM and other broad audiences', () => {
    expect(() => assertAzureMonitorIngestScope('https://management.azure.com/.default')).toThrow()
    expect(() => assertAzureMonitorIngestScope('https://graph.microsoft.com/.default')).toThrow()
  })

  it('rejects a lookalike host, http, a missing /.default, and a non-URL', () => {
    expect(() => assertAzureMonitorIngestScope('https://monitor.azure.com.evil.test/.default')).toThrow()
    expect(() => assertAzureMonitorIngestScope('http://monitor.azure.com/.default')).toThrow()
    expect(() => assertAzureMonitorIngestScope('https://monitor.azure.com/user_impersonation')).toThrow()
    expect(() => assertAzureMonitorIngestScope('not a url')).toThrow(/not a valid URL/)
  })
})
