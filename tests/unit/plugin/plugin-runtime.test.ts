/*
 * plugin-runtime — the shared runtime helpers extracted from status.mjs /
 * usage.mjs / session-start.mjs / read-credential.mjs (one place owns the
 * emit-path contract). Tests the mechanism: path resolution, settings-env
 * reading, the state dir + sentinel, and the real-emit-path invoker's
 * classification (without ever surfacing a bearer).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  it('prefers TOKENSCOPE_STATE_DIR', () => {
    expect(stateDir({ TOKENSCOPE_STATE_DIR: '/custom/state' })).toBe('/custom/state')
  })
  it('falls back to ~/.tokenscope', () => {
    const d = stateDir({})
    expect(d.endsWith('/.tokenscope')).toBe(true)
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
  it('reads emit-failure.json from the state dir', () => {
    mkdirSync(join(tmp, '.tokenscope'), { recursive: true })
    writeFileSync(join(tmp, '.tokenscope', 'emit-failure.json'), JSON.stringify({ http_status: 401, message: 'x' }))
    expect(readEmitSentinel({ TOKENSCOPE_STATE_DIR: join(tmp, '.tokenscope') })).toEqual({ http_status: 401, message: 'x' })
  })
  it('returns null when no sentinel', () => {
    expect(readEmitSentinel({ TOKENSCOPE_STATE_DIR: join(tmp, '.tokenscope') })).toBeNull()
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
