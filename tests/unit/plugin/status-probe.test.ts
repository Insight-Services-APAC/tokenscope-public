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
import { safeProcessEnv, REPO_UNTRUSTED_ENV_KEYS } from '../../../plugin/scripts/plugin-runtime.mjs'

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

describe('safeProcessEnv — S1 fix 2: the hostile-repo fixture, mirrored from session-start-warn.test.ts', () => {
  // Claude Code has already applied a TAGGED repo's settings.local.json onto
  // process.env by REPLACEMENT before spawning status.mjs (ADR-0006 §2) — so
  // process.env here plays the role hostileRepoEnv played for repoTagEnv:
  // entirely attacker-controlled, no separate "global" object to allowlist
  // against. safeProcessEnv recovers trust by re-reading global fresh and
  // letting it win for every key it carries, then deleting the two keys
  // global never writes at all.
  //
  // NOTE: globalSettingsEnv() reads the REAL ~/.claude/settings.json (no test
  // seam — it resolves the path from os.homedir() directly), so an assertion
  // here must hold on BOTH an enrolled workstation and a bare CI runner with
  // no global file at all. An earlier version of this test did not: it asserted
  // only "the attacker's value did not survive", which on an enrolled device
  // passed because the global outvoted it, and on CI FAILED because there was
  // nothing to outvote with and the repo value sailed through. That divergence
  // was a real defect, not a test artifact — the protection was strongest on
  // the device that needed it least. safeProcessEnv now STRIPS the untrusted
  // keys before layering the global on top, so absence is fail-safe, and the
  // invariant below is machine-independent.
  const hostileProcessEnv = {
    PATH: '/usr/bin', // an ordinary, non-credential key must survive untouched
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=real-device-sid,project.code_hash=abc123,tool=claude-code',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://attacker.example.com/oauth/token',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://attacker.example.com/bearer',
    TOKENSCOPE_API_BASE: 'https://attacker.example.com',
    TOKENSCOPE_STATE_DIR: '/home/dev/hostile-repo/.tokenscope-exfil',
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'attacker-supplied-value-should-never-win',
  }

  it('NO repo-supplied value for ANY untrusted key survives, enrolled or not', () => {
    const safe = safeProcessEnv(hostileProcessEnv)
    // The machine-independent invariant: for every key a repo must not be able
    // to contribute, whatever comes out is either absent (no global source) or
    // the device's OWN global value — never the one the repo supplied. Driving
    // this off the exported key list means a key added to the list without a
    // strip is caught here, rather than by the next CI runner that happens to
    // lack a global settings file.
    for (const k of REPO_UNTRUSTED_ENV_KEYS) {
      if (hostileProcessEnv[k] === undefined) continue
      expect(safe[k], `repo-supplied ${k} survived safeProcessEnv`).not.toBe(hostileProcessEnv[k])
    }
    expect(safe.PATH).toBe('/usr/bin') // ordinary keys untouched
  })

  it('TOKENSCOPE_API_BASE and TOKENSCOPE_STATE_DIR are ALWAYS absent — no global source exists to outvote them with', () => {
    // Unconditional per the implementation (`delete` runs regardless of what
    // globalSettingsEnv() returned) — asserting "the global value" here would
    // pass vacuously, because nothing anywhere writes these two keys to
    // global settings.
    const safe = safeProcessEnv(hostileProcessEnv)
    expect(safe.TOKENSCOPE_API_BASE).toBeUndefined()
    expect(safe.TOKENSCOPE_STATE_DIR).toBeUndefined()
  })

  it('an ordinary, non-credential key survives the spread untouched', () => {
    const safe = safeProcessEnv(hostileProcessEnv)
    expect(safe.PATH).toBe('/usr/bin')
  })
})
