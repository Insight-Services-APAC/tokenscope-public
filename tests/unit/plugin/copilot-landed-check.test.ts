// @vitest-environment node
/*
 * copilot landed-check — unit tests for the Copilot device's "did my telemetry
 * LAND?" probe (copilot-plugin/scripts/landed-check.mjs).
 *
 * Pins the fail-open contract: any missing config / missing token / network /
 * non-2xx / bad-json returns a typed { ok:false, reason } and NEVER throws — so a
 * status read can degrade to "unconfirmed" rather than red. On a real 200 it writes
 * the last-landed.json cache.
 *
 * All state is in a temp dir; fetch is stubbed (no network).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { refreshLanded, healthUrlFromBearer } = await import('../../../copilot-plugin/scripts/landed-check.mjs')

const INSTANCE = '203d6725-f9f9-46d5-987b-571adfbb0857'
const BEARER = `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`

let dir: string

function writeConfig(over: Record<string, unknown> = {}) {
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ instance_id: INSTANCE, bearer_endpoint: BEARER, ...over }),
  )
}
function writeAccess(token: string | null = 'tok') {
  writeFileSync(join(dir, 'oauth-access.json'), JSON.stringify(token ? { access_token: token } : {}))
}
function mockFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl as never))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'co-landed-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('healthUrlFromBearer', () => {
  it('rewrites .../bearer → .../health', () => {
    expect(healthUrlFromBearer(BEARER)).toBe(
      `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/health`,
    )
  })
  it('rewrites .../bearer?query → .../health (drops the query)', () => {
    expect(healthUrlFromBearer(`${BEARER}?x=1`)).toBe(
      `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/health`,
    )
  })
  it('returns null for a non-/bearer endpoint (never GET somewhere unexpected)', () => {
    expect(healthUrlFromBearer('https://example.com/api/v1/instances/x/other')).toBeNull()
    expect(healthUrlFromBearer('')).toBeNull()
    expect(healthUrlFromBearer(null as never)).toBeNull()
  })
})

describe('refreshLanded — fail-open guards', () => {
  it('no config.json → not-configured (no throw)', async () => {
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'not-configured' })
  })

  it('config missing instance_id → not-configured', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ bearer_endpoint: BEARER }))
    writeAccess()
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'not-configured' })
  })

  it('bearer_endpoint not a /bearer URL → bad-endpoint', async () => {
    writeConfig({ bearer_endpoint: 'https://example.com/api/v1/instances/x/nope' })
    writeAccess()
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'bad-endpoint' })
  })

  it('no cached access token → no-token', async () => {
    writeConfig()
    writeAccess(null)
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'no-token' })
  })

  it('fetch throws (timeout/offline) → fetch-failed (no throw)', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => {
      throw new Error('network down')
    })
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'fetch-failed' })
  })

  it('non-2xx → http-<status>', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => ({ ok: false, status: 401 }))
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'http-401' })
  })

  it('200 with non-JSON body → bad-json', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => ({ ok: true, json: async () => { throw new Error('not json') } }))
    const r = await refreshLanded({ dir })
    expect(r).toEqual({ ok: false, reason: 'bad-json' })
  })
})

describe('refreshLanded — success path', () => {
  it('200 → ok with last_emission + writes last-landed.json cache', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({ last_emission: '2026-06-22T08:14:03Z', silent: false, revoked: false }),
    }))
    const r = await refreshLanded({ dir })
    expect(r.ok).toBe(true)
    expect(r.lastEmission).toBe('2026-06-22T08:14:03Z')
    expect(r.silent).toBe(false)
    expect(r.revoked).toBe(false)

    expect(existsSync(join(dir, 'last-landed.json'))).toBe(true)
    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.json'), 'utf8'))
    expect(cache.instanceId).toBe(INSTANCE)
    expect(cache.lastEmission).toBe('2026-06-22T08:14:03Z')
    expect(cache.checkedAt).toBeTruthy()
  })

  it('200 with null last_emission (never landed) → ok, lastEmission null', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => ({ ok: true, json: async () => ({ last_emission: null, silent: true }) }))
    const r = await refreshLanded({ dir })
    expect(r.ok).toBe(true)
    expect(r.lastEmission).toBeNull()
    expect(r.silent).toBe(true)
  })

  it('200 revoked instance → ok with revoked:true', async () => {
    writeConfig()
    writeAccess()
    mockFetch(() => ({ ok: true, json: async () => ({ last_emission: '2026-06-20T00:00:00Z', silent: true, revoked: true }) }))
    const r = await refreshLanded({ dir })
    expect(r.ok).toBe(true)
    expect(r.revoked).toBe(true)
  })
})
