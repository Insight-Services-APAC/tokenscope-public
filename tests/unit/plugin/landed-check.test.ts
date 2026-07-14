// @vitest-environment node
/*
 * landed-check (Claude) — the "did my telemetry LAND?" probe
 * (plugin/scripts/landed-check.mjs). It calls GET /instances/{id}/health and
 * writes the last-landed.json cache the always-on statusline reads.
 *
 * Pins the contract the statusline's classifyLanding() now DEPENDS on: on a real
 * 200 the cache carries `ok:true` (so a reached-but-stale answer is judge-able,
 * not "unknown") plus `lastBearer` (the emit-activity proxy that separates a dead
 * export from an idle client), `revoked`, and `lastEmission`. Fail-open guards
 * return a typed { ok:false, reason } and NEVER touch the cache, so the statusline
 * degrades to the neutral "unknown" fallback rather than a false red.
 *
 * All state is in a temp dir; fetch is stubbed (no network).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { refreshLanded } = await import('../../../plugin/scripts/landed-check.mjs')

const INSTANCE = 'e0d06f65-1100-4d6f-b544-e377a7b391a6'
const env = {
  TOKENSCOPE_BEARER_ENDPOINT: `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`,
  OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`,
}

let dir: string

function writeAccess(token: string | null = 'tok') {
  writeFileSync(join(dir, 'oauth-access.json'), JSON.stringify(token ? { access_token: token } : {}))
}
function mockFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl as never))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cl-landed-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('refreshLanded (Claude) — fail-open guards leave the cache untouched', () => {
  it('missing bearer endpoint / instance id → not-configured, no cache written', async () => {
    writeAccess()
    const r = await refreshLanded({ env: {}, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'not-configured' })
    expect(existsSync(join(dir, 'last-landed.json'))).toBe(false)
  })

  it('no cached access token → no-token', async () => {
    writeAccess(null)
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'no-token' })
  })

  it('fetch throws → fetch-failed (no throw, no cache write)', async () => {
    writeAccess()
    mockFetch(() => {
      throw new Error('offline')
    })
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'fetch-failed' })
    expect(existsSync(join(dir, 'last-landed.json'))).toBe(false)
  })

  it('non-2xx → http-<status>', async () => {
    writeAccess()
    mockFetch(() => ({ ok: false, status: 403 }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r).toEqual({ ok: false, reason: 'http-403' })
  })
})

describe('refreshLanded (Claude) — success writes the cache the statusline reads', () => {
  it('200 → writes ok:true + lastEmission + lastBearer + revoked (the fields classifyLanding needs)', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        last_emission: '2026-06-30 21:38:58.933+00',
        last_bearer_at: '2026-07-01T00:30:28.697Z',
        silent: false,
        revoked: false,
      }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.ok).toBe(true)
    expect(r.lastEmission).toBe('2026-06-30 21:38:58.933+00')
    expect(r.lastBearer).toBe('2026-07-01T00:30:28.697Z')
    expect(r.revoked).toBe(false)

    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.json'), 'utf8'))
    expect(cache.ok).toBe(true) // load-bearing: distinguishes reached-but-stale from unreachable
    expect(cache.instanceId).toBe(INSTANCE)
    expect(cache.lastEmission).toBe('2026-06-30 21:38:58.933+00')
    expect(cache.lastBearer).toBe('2026-07-01T00:30:28.697Z') // the emit-activity proxy
    expect(cache.revoked).toBe(false)
    expect(cache.checkedAt).toBeTruthy() // the poll-throttle stamp
  })

  it('200 revoked instance → cache carries revoked:true', async () => {
    writeAccess()
    mockFetch(() => ({
      ok: true,
      json: async () => ({ last_emission: null, silent: true, revoked: true }),
    }))
    const r = await refreshLanded({ env, stateDir: dir })
    expect(r.revoked).toBe(true)
    const cache = JSON.parse(readFileSync(join(dir, 'last-landed.json'), 'utf8'))
    expect(cache.revoked).toBe(true)
    expect(cache.ok).toBe(true)
  })
})
