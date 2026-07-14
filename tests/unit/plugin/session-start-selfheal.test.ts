/*
 * selfHealPluginPaths — the SessionStart hook's Job 0, which REWRITES the global
 * ~/.claude/settings.json (the file that holds the durable emit credential) to
 * repoint version-pinned plugin paths to the active version. These tests exercise
 * the dangerous I/O against a temp dir: it must never clobber an unparseable file,
 * must preserve the credential, must only repoint to targets that exist, and must
 * fail-open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selfHealPluginPaths } from '../../../plugin/hooks/session-start.mjs'

let dir = ''
let settingsPath = ''
let scriptsDir = '' // active version's scripts dir (cache-like layout so it's "ours" + versioned)

const STALE = {
  statusLine: { type: 'command', command: 'node "/x/plugins/cache/tokenscope/tokenscope/0.1.13/scripts/statusline.mjs"', padding: 0 },
  otelHeadersHelper: '/x/plugins/cache/tokenscope/tokenscope/0.1.13/scripts/otel-headers-helper.sh',
  env: { TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'super-secret', CLAUDE_CODE_ENABLE_TELEMETRY: '1' },
  permissions: { allow: ['Bash'] },
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-selfheal-'))
  settingsPath = join(dir, 'settings.json')
  scriptsDir = join(dir, 'plugins', 'cache', 'tokenscope', 'tokenscope', '0.1.99', 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  writeFileSync(join(scriptsDir, 'statusline.mjs'), '// active')
  writeFileSync(join(scriptsDir, 'otel-headers-helper.sh'), '# active')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('selfHealPluginPaths', () => {
  it('repoints stale paths to the active version and PRESERVES the credential + other keys', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.statusLine.command).toBe(`node ${JSON.stringify(join(scriptsDir, 'statusline.mjs'))}`)
    expect(out.statusLine.padding).toBe(0)
    expect(out.otelHeadersHelper).toBe(join(scriptsDir, 'otel-headers-helper.sh'))
    // The credential + unrelated keys survive untouched.
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret')
    expect(out.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(out.permissions).toEqual({ allow: ['Bash'] })
  })

  it('NEVER clobbers an unparseable settings.json (would wipe the credential)', () => {
    const garbage = '{ this is not valid json, has a secret: TOKEN '
    writeFileSync(settingsPath, garbage)
    selfHealPluginPaths({ settingsPath, scriptsDir })
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage) // byte-for-byte untouched
  })

  it('is idempotent: a second run makes no change and leaves no temp files', () => {
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir })
    const after1 = readFileSync(settingsPath, 'utf8')
    selfHealPluginPaths({ settingsPath, scriptsDir })
    expect(readFileSync(settingsPath, 'utf8')).toBe(after1)
    expect(readdirSync(dir).some((f) => f.includes('.tmp.'))).toBe(false)
  })

  it('does NOT repoint to a target that is missing on disk (no phantom path)', () => {
    rmSync(join(scriptsDir, 'otel-headers-helper.sh')) // active helper absent
    writeFileSync(settingsPath, JSON.stringify(STALE, null, 2))
    selfHealPluginPaths({ settingsPath, scriptsDir })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // statusline (present) healed; helper (missing target) left at its stale value.
    expect(out.statusLine.command).toContain('0.1.99')
    expect(out.otelHeadersHelper).toBe(STALE.otelHeadersHelper)
  })

  it('no-ops (fail-open) when settings.json does not exist', () => {
    expect(() => selfHealPluginPaths({ settingsPath, scriptsDir })).not.toThrow()
  })
})
