/*
 * plugin-runtime — the shared runtime helpers extracted from status.mjs /
 * usage.mjs / session-start.mjs / read-credential.mjs (one place owns the
 * emit-path contract). Tests the mechanism: path resolution, settings-env
 * reading, the state dir + sentinel, and the real-emit-path invoker's
 * classification (without ever surfacing a bearer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  resolveScriptsDir,
  resolveHelperPath,
  stateDir,
  readSettingsEnv,
  readEmitSentinel,
  runEmitHelper,
} from '../../../plugin/scripts/plugin-runtime.mjs'

let tmp: string
const savedEnv = { ...process.env }

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-runtime-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  process.env = { ...savedEnv }
})

describe('resolveScriptsDir / resolveHelperPath', () => {
  it('uses CLAUDE_PLUGIN_ROOT/scripts when set', () => {
    process.env.CLAUDE_PLUGIN_ROOT = '/opt/plugin'
    expect(resolveScriptsDir()).toBe('/opt/plugin/scripts')
    expect(resolveHelperPath()).toBe('/opt/plugin/scripts/otel-headers-helper.sh')
  })
})

describe('stateDir', () => {
  // S1 hardening: TOKENSCOPE_STATE_DIR is resolved from process.env ONLY — a
  // PASSED `env` object (readEmitSentinel's argument, or any settings-derived
  // object) is IGNORED for this key, because nothing legitimately writes
  // TOKENSCOPE_STATE_DIR to global OR repo settings.json (a settings-derived
  // object is attacker-reachable in a hostile repo; process.env is not routed
  // through that path the same way — see plugin-runtime.mjs's stateDir doc).
  it('IGNORES TOKENSCOPE_STATE_DIR on a passed env object — process.env only', () => {
    expect(stateDir({ TOKENSCOPE_STATE_DIR: '/custom/state' }).endsWith('/.tokenscope')).toBe(true)
  })
  it('falls back to ~/.tokenscope', () => {
    const d = stateDir({})
    expect(d.endsWith('/.tokenscope')).toBe(true)
  })
  it('ignores a leaked HOME — anchors on the passwd home (the recurring silent-drop fix)', () => {
    // The whole bug: a leaked HOME made the forwarder resolve a phantom
    // ~/.tokenscope. stateDir() must NOT follow HOME; it anchors on the passwd
    // home, so a leaked HOME env cannot move the state dir.
    const real = userInfo().homedir
    const leaked = stateDir({ HOME: '/tmp/ts-home-LEAKED' })
    expect(leaked).toBe(join(real, '.tokenscope'))
    expect(leaked).not.toContain('/tmp/ts-home-LEAKED')
  })
  it('honours a process-level TOKENSCOPE_STATE_DIR — and a passed env object can never override it', () => {
    // The override is a genuine PROCESS/deployment concern (a real shell
    // export or container config) — never a per-settings OTEL env block.
    // Restored after the assertion.
    const prev = process.env.TOKENSCOPE_STATE_DIR
    process.env.TOKENSCOPE_STATE_DIR = '/pinned/state'
    try {
      expect(stateDir({ SOME_OTHER: 'x' })).toBe('/pinned/state')
      // A passed env's OWN TOKENSCOPE_STATE_DIR does NOT win over the real
      // process-level pin — it is not consulted at all (S1 hardening: a
      // hostile-repo-tainted `env` object must not be able to redirect where
      // otel-headers-helper.sh would later write a live access token).
      expect(stateDir({ TOKENSCOPE_STATE_DIR: '/attacker-supplied' })).toBe('/pinned/state')
    } finally {
      if (prev === undefined) delete process.env.TOKENSCOPE_STATE_DIR
      else process.env.TOKENSCOPE_STATE_DIR = prev
    }
  })
})

describe('readSettingsEnv', () => {
  it('returns the env block from a settings file', () => {
    const p = join(tmp, 'settings.json')
    writeFileSync(p, JSON.stringify({ env: { A: '1' }, otelHeadersHelper: '/h.sh' }))
    expect(readSettingsEnv(p)).toEqual({ A: '1' })
  })
  it('returns {} for a missing / unparseable file', () => {
    expect(readSettingsEnv(join(tmp, 'nope.json'))).toEqual({})
    writeFileSync(join(tmp, 'bad.json'), 'not json')
    expect(readSettingsEnv(join(tmp, 'bad.json'))).toEqual({})
  })
})

describe('readEmitSentinel', () => {
  // readEmitSentinel(env) resolves its dir via stateDir(env) — which (S1
  // hardening) reads TOKENSCOPE_STATE_DIR from process.env only, never from
  // the passed `env` object. Pin the dir via process.env here, matching how
  // production callers actually get a real state dir (a genuine deployment
  // pin), not by handing a settings-derived object the key. The file's OWN
  // top-level afterEach already restores the full process.env after every
  // test, so no extra cleanup is needed here.
  beforeEach(() => {
    process.env.TOKENSCOPE_STATE_DIR = join(tmp, '.tokenscope')
  })

  it('reads emit-failure.json from the state dir', () => {
    mkdirSync(join(tmp, '.tokenscope'), { recursive: true })
    writeFileSync(join(tmp, '.tokenscope', 'emit-failure.json'), JSON.stringify({ http_status: 401, message: 'x' }))
    expect(readEmitSentinel({})).toEqual({ http_status: 401, message: 'x' })
  })
  it('returns null when no sentinel', () => {
    expect(readEmitSentinel({})).toBeNull()
  })
})

describe('runEmitHelper', () => {
  function stubHelper(body: string) {
    const dir = join(tmp, 'scripts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'otel-headers-helper.sh'), body)
    process.env.CLAUDE_PLUGIN_ROOT = tmp
  }

  it('ran=true, status 0, hasAuth when the helper prints an Authorization bearer', () => {
    stubHelper('echo \'{"Authorization":"Bearer SECRET"}\'\nexit 0\n')
    const r = runEmitHelper()
    expect(r.ran).toBe(true)
    expect(r.status).toBe(0)
    expect(r.hasAuth).toBe(true)
  })

  it('hasAuth=false on a non-zero exit (auth failure)', () => {
    stubHelper('echo "boom" >&2\nexit 1\n')
    const r = runEmitHelper()
    expect(r.ran).toBe(true)
    expect(r.status).toBe(1)
    expect(r.hasAuth).toBe(false)
  })

  it('hasAuth=false when stdout is exit-0 but not a bearer object', () => {
    stubHelper('echo "not json"\nexit 0\n')
    const r = runEmitHelper()
    expect(r.status).toBe(0)
    expect(r.hasAuth).toBe(false)
  })

  it('ran=false when the helper is missing', () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(tmp, 'empty')
    const r = runEmitHelper()
    expect(r.ran).toBe(false)
  })
})
