/*
 * /tokenscope:status emission-probe interpreter (the dogfood 2026-06-06 fix).
 *
 * interpretEmissionProbe decides EMITTING/NOT from the REAL emit path's exit code
 * + the helper's failure sentinel — replacing the pre-0.1.4 probe that GET
 * /bearer'd with the legacy TOKENSCOPE_SESSION_TOKEN and so reported a FALSE
 * "NOT EMITTING / session expired" on any OAuth device once the 12h token lapsed.
 *
 * Post-cutover: an auth failure now steers to "re-provision emit via the
 * tokenscope-setup MCP prompt" (provision_emit), NOT the removed /tokenscope:enrol.
 */
import { describe, it, expect } from 'vitest'
import { interpretEmissionProbe, isMcpAuthed } from '../../../plugin/scripts/status.mjs'

describe('interpretEmissionProbe', () => {
  it('exit 0 + an Authorization header → EMITTING ✓', () => {
    const v = interpretEmissionProbe({ status: 0, stdoutHasAuth: true, sentinel: null })
    expect(v.emitting).toBe(true)
    expect(v.probe_status).toBe(200)
  })

  it('exit 0 but NO Authorization header → not emitting (unexpected, not a false-OK)', () => {
    const v = interpretEmissionProbe({ status: 0, stdoutHasAuth: false, sentinel: null })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBeNull()
  })

  it('non-zero exit + 401 sentinel → DROPPED, steer to re-provision', () => {
    const v = interpretEmissionProbe({
      status: 1,
      stdoutHasAuth: false,
      sentinel: { http_status: 401, message: 'Session expired' },
    })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(401)
    expect(v.message).toMatch(/DROPPED/)
    expect(v.message).toMatch(/re-provision/i)
    expect(v.message).toMatch(/Session expired/)
  })

  it('non-zero exit + 403 sentinel → treated as an auth failure', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: { http_status: 403, message: 'revoked' } })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(403)
    expect(v.message).toMatch(/re-provision/i)
  })

  it('non-zero exit + 404 sentinel (instance unknown) → re-provision', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: { http_status: 404, message: 'instance not found' } })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(404)
    expect(v.message).toMatch(/re-provision/i)
  })

  it('non-zero exit + network sentinel (http 0) → UNVERIFIABLE, not a hard "dropped"', () => {
    const v = interpretEmissionProbe({
      status: 1,
      stdoutHasAuth: false,
      sentinel: { http_status: 0, message: 'network error reaching bearer endpoint' },
    })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(0)
    expect(v.message).toMatch(/could not be verified|transient/i)
    expect(v.message).not.toMatch(/re-provision/i)
  })

  it('non-zero exit + NO sentinel → hard failure with no detail, steers to re-provision (not "transient")', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: null })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBeNull()
    expect(v.message).toMatch(/no detail recorded/i)
    expect(v.message).toMatch(/re-provision/i)
    expect(v.message).not.toMatch(/transient/i)
  })
})

describe('isMcpAuthed', () => {
  it('true when .mcpOAuth has the TokenScope plugin MCP server key (with suffix)', () => {
    expect(
      isMcpAuthed({ mcpOAuth: { 'plugin:tokenscope:tokenscope|https://ep.example/api/v1/mcp': { accessToken: 'x' } } }),
    ).toBe(true)
  })

  it('true on an exact key match (no suffix)', () => {
    expect(isMcpAuthed({ mcpOAuth: { 'plugin:tokenscope:tokenscope': {} } })).toBe(true)
  })

  it('false when .mcpOAuth has only OTHER servers', () => {
    expect(isMcpAuthed({ mcpOAuth: { 'plugin:other:thing|https://x': {} } })).toBe(false)
  })

  it('false on missing / non-object .mcpOAuth (fail-defensive)', () => {
    expect(isMcpAuthed({})).toBe(false)
    expect(isMcpAuthed({ mcpOAuth: null })).toBe(false)
    expect(isMcpAuthed(null)).toBe(false)
    expect(isMcpAuthed('nope')).toBe(false)
  })
})
