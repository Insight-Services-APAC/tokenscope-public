// @vitest-environment node
/*
 * project-check firewall: ONLY an explicit HTTP-200 billable:false warns
 * ('not-billable'); every other path stays silent ('unverifiable' / 'no-tag').
 * This is the fail-open / no-false-positive guarantee.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkRepoProjectBillable } from '../../../plugin/scripts/project-check.mjs'

const INSTANCE = '203d6725-f9f9-46d5-987b-571adfbb0857'
const HASH = 'a'.repeat(64)
// An OTEL attrs string with a frozen emitting project.code_hash (so the committed
// .tokenscope is irrelevant and we don't depend on cwd).
const ATTRS = `tokenscope.instance_id=${INSTANCE},project.code_hash=${HASH},tool=claude-code`
const BEARER = `https://tokenscope.example.com/api/v1/instances/${INSTANCE}/bearer`

let stateDir: string
let emptyCwd: string

function baseEnv() {
  return { OTEL_RESOURCE_ATTRIBUTES: ATTRS, TOKENSCOPE_BEARER_ENDPOINT: BEARER }
}
const run = (over: Record<string, unknown> = {}) =>
  checkRepoProjectBillable({ env: baseEnv(), cwd: emptyCwd, stateDir, timeoutMs: 50, ...over })

function mockFetch(impl: () => unknown) {
  vi.stubGlobal('fetch', vi.fn(impl as never))
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'pc-state-'))
  emptyCwd = mkdtempSync(join(tmpdir(), 'pc-cwd-')) // no .tokenscope here
  writeFileSync(join(stateDir, 'oauth-access.json'), JSON.stringify({ access_token: 'tok' }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(emptyCwd, { recursive: true, force: true })
})

describe('checkRepoProjectBillable — the one warning case', () => {
  it('HTTP-200 billable:false → not-billable (THE warning)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ billable: false, your_projects: [{ code: 'X' }] }) }))
    const r = await run()
    expect(r.status).toBe('not-billable')
    expect(r.yourProjects).toEqual([{ code: 'X' }])
  })

  it('HTTP-200 billable:true → ok', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ billable: true, project: { code: 'OK' } }) }))
    expect((await run()).status).toBe('ok')
  })
})

describe('checkRepoProjectBillable — fail-open firewall (all silent)', () => {
  it('no token cached → unverifiable (silent)', async () => {
    rmSync(join(stateDir, 'oauth-access.json'), { force: true })
    mockFetch(() => {
      throw new Error('should not be called')
    })
    expect((await run()).status).toBe('unverifiable')
  })

  it('no bearer endpoint / no instance → unverifiable', async () => {
    expect((await checkRepoProjectBillable({ env: { OTEL_RESOURCE_ATTRIBUTES: ATTRS }, cwd: emptyCwd, stateDir })).status).toBe('unverifiable')
  })

  it('HTTP 401 → unverifiable (silent, not a warning)', async () => {
    mockFetch(() => ({ ok: false, status: 401 }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('HTTP 500 → unverifiable', async () => {
    mockFetch(() => ({ ok: false, status: 500 }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('fetch throws (timeout/offline) → unverifiable', async () => {
    mockFetch(() => {
      throw new Error('aborted')
    })
    expect((await run()).status).toBe('unverifiable')
  })

  it('bad JSON → unverifiable', async () => {
    mockFetch(() => ({ ok: true, json: async () => { throw new Error('bad') } }))
    expect((await run()).status).toBe('unverifiable')
  })

  it('no .tokenscope AND no emitting tag → no-tag (silent)', async () => {
    mockFetch(() => {
      throw new Error('should not be called')
    })
    const r = await checkRepoProjectBillable({
      env: { OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${INSTANCE},tool=claude-code`, TOKENSCOPE_BEARER_ENDPOINT: BEARER },
      cwd: emptyCwd,
      stateDir,
    })
    expect(r.status).toBe('no-tag')
  })

  it('builds the /project-resolve URL from the cached /bearer endpoint', async () => {
    const spy = vi.fn(() => ({ ok: true, json: async () => ({ billable: true }) }))
    vi.stubGlobal('fetch', spy as never)
    await run()
    expect(spy).toHaveBeenCalledOnce()
    const calledUrl = String((spy.mock.calls[0] as unknown[])[0])
    expect(calledUrl).toContain(`/instances/${INSTANCE}/project-resolve?code_hash=${HASH}`)
    expect(calledUrl).not.toContain('/bearer')
  })
})
