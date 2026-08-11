/*
 * tag-repo self-heal (ADR-0006) — the repo pin must NOT freeze upgrade-able
 * client state.
 *
 * Direct unit tests pin writeRepoTag's change-detection (idempotent no-op,
 * helper-path heal, instance heal, credential refresh). Child-process tests
 * exercise the SessionStart hook end-to-end against a fake global enrolment to
 * prove it (a) REWRITES on a helper-path/instance change even when the
 * project.code_hash is unchanged, (b) is a TRUE no-op (stable mtime) when the
 * repo already matches current-global, and (c) fails OPEN (swallows a throw,
 * exits 0) so a hook can never break the session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeRepoTag, computeCodeHash } from '../../../plugin/scripts/tag-repo.mjs'

// --- fixtures ------------------------------------------------------------

const CODE = 'TokenScope-MVP'
const CODE_HASH = computeCodeHash(CODE)

/** A global enrolment shaped like readDeviceEnrolment()'s output. */
function enrolment({ instance = 'inst-A', helper = '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh', env } = {}) {
  return {
    sessionId: instance,
    helperPath: helper,
    env: env ?? {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://dce/logs',
      OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=${instance},tool=claude-code`,
      TOKENSCOPE_BEARER_ENDPOINT: `https://api/api/v1/instances/${instance}/bearer`,
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-current',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://login/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
    },
  }
}

function readRepo(cwd: string) {
  return JSON.parse(readFileSync(join(cwd, '.claude', 'settings.local.json'), 'utf8'))
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ts-selfheal-'))
  // S1 fix 4c: writeRepoTag now anchors to the repo ROOT (resolveRepoRoot) and
  // refuses to write when it can't be resolved — give every fixture a `.git`
  // marker so `cwd` itself resolves as the root (the common case these tests
  // exercise). The cwd-below-root and worktree cases get their own tests below.
  mkdirSync(join(cwd, '.git'), { recursive: true })
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

// --- writeRepoTag: change-detection -------------------------------------

describe('writeRepoTag change-detection', () => {
  // The active-version helper resolution reads process.env.CLAUDE_PLUGIN_ROOT.
  // Neutralise it here so these tests deterministically exercise the
  // enrolment.helperPath fallback they assert (the active-version preference has
  // its own tests below).
  const savedPluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  beforeEach(() => {
    delete process.env.CLAUDE_PLUGIN_ROOT
  })
  afterEach(() => {
    if (savedPluginRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
    else process.env.CLAUDE_PLUGIN_ROOT = savedPluginRoot
  })

  it('writes on first call (changed=true, no prior pin to heal)', () => {
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    expect(r.healed).toBe(false)
    const s = readRepo(cwd)
    expect(s.env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `tokenscope.instance_id=inst-A,project.code_hash=${CODE_HASH},tool=claude-code`,
    )
    // Self-contained: the full device env is copied, not just the resource
    // attrs (ADR-0006 §2 — replacement, not key-merge, so a narrowed block
    // would drop these). This is the regression pin: asserting "exactly one
    // key" here would certify the fleet-wide emission stop the story warns
    // against, so the endpoint/exporter/bearer keys are asserted PRESENT.
    expect(s.env.TOKENSCOPE_BEARER_ENDPOINT).toBe('https://api/api/v1/instances/inst-A/bearer')
    expect(s.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://dce/logs')
    expect(s.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe('https://login/token')
    expect(s.env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('cid')
    // S1 fix 4: the durable OAuth REFRESH token specifically is stripped — the
    // one key that would otherwise let a hostile repo exfiltrate it just by
    // being cloned. otel-headers-helper.sh falls back to the device's own
    // state-dir credential store for this key.
    expect(s.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined()
    expect(s.otelHeadersHelper).toContain('0.1.3')
  })

  it('is a TRUE no-op when the repo already equals current-global + hash (changed=false, stable mtime)', () => {
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const before = statSync(join(cwd, '.claude', 'settings.local.json')).mtimeMs
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const after = statSync(join(cwd, '.claude', 'settings.local.json')).mtimeMs
    expect(r.changed).toBe(false)
    expect(after).toBe(before) // file untouched
  })

  it('REWRITES + heals when the global helper path changed (e.g. 0.1.1 -> 0.1.3), hash unchanged', () => {
    // Pin under the OLD helper path (the frozen-snapshot incident).
    writeRepoTag({
      cwd,
      enrolment: enrolment({ helper: '/plugins/tokenscope/0.1.1/scripts/otel-headers-helper.sh' }),
      codeHash: CODE_HASH,
    })
    // Plugin upgraded — global now points at 0.1.3. Same project code_hash.
    const r = writeRepoTag({ cwd, enrolment: enrolment({ helper: '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh' }), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    expect(r.healed).toBe(true)
    expect(readRepo(cwd).otelHeadersHelper).toContain('0.1.3')
  })

  it('REWRITES + heals when the global instance changed (re-enrol), hash unchanged', () => {
    writeRepoTag({ cwd, enrolment: enrolment({ instance: 'inst-OLD' }), codeHash: CODE_HASH })
    const r = writeRepoTag({ cwd, enrolment: enrolment({ instance: 'inst-NEW' }), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    expect(r.healed).toBe(true)
    expect(readRepo(cwd).env.OTEL_RESOURCE_ATTRIBUTES).toContain('tokenscope.instance_id=inst-NEW')
  })

  it('refreshes frozen credentials: a legacy session-token pin picks up the current OAuth env', () => {
    // Old frozen repo env: legacy 12h token, NO OAuth refresh creds.
    writeRepoTag({
      cwd,
      enrolment: enrolment({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-A,tool=claude-code',
          TOKENSCOPE_BEARER_ENDPOINT: 'https://api/api/v1/instances/inst-A/bearer',
          TOKENSCOPE_SESSION_TOKEN: 'legacy-12h-token',
        },
      }),
      codeHash: CODE_HASH,
    })
    expect(readRepo(cwd).env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined()
    // Re-enrol added durable OAuth creds to global → repo picks up the
    // endpoint/client-id (S1 fix 4: NOT the refresh token, which is now
    // stripped from every repo copy regardless of what global carries).
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    const s = readRepo(cwd)
    expect(s.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe('https://login/token')
    expect(s.env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('cid')
    expect(s.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined()
  })

  it('REPLACES the repo env wholesale: a key the current global stopped emitting is ABSENT after re-derive (MEDIUM-1)', () => {
    // Pin under a global whose env carries a legacy session token (key X).
    writeRepoTag({
      cwd,
      enrolment: enrolment({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-A,tool=claude-code',
          TOKENSCOPE_BEARER_ENDPOINT: 'https://api/api/v1/instances/inst-A/bearer',
          TOKENSCOPE_SESSION_TOKEN: 'legacy-12h-token', // key X
        },
      }),
      codeHash: CODE_HASH,
    })
    expect(readRepo(cwd).env.TOKENSCOPE_SESSION_TOKEN).toBe('legacy-12h-token')

    // Re-derive under a current global WITHOUT key X (OAuth-only). An additive
    // merge would leave the dead legacy token at rest; a wholesale REPLACE drops it.
    writeRepoTag({
      cwd,
      enrolment: enrolment({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-A,tool=claude-code',
          TOKENSCOPE_BEARER_ENDPOINT: 'https://api/api/v1/instances/inst-A/bearer',
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-current',
          TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://login/token',
          TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
        },
      }),
      codeHash: CODE_HASH,
    })
    const s = readRepo(cwd)
    expect(s.env.TOKENSCOPE_SESSION_TOKEN).toBeUndefined() // dead credential gone
    expect(s.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe('https://login/token')
    expect(s.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined() // S1 fix 4: stripped regardless
  })

  it('keeps the read credential OUT of the per-repo copy (ADR-0005 E1 — global-only identity token)', () => {
    const e = enrolment()
    e.env.TOKENSCOPE_READ_REFRESH_TOKEN = 'read-rt'
    e.env.TOKENSCOPE_READ_CLIENT_ID = 'read-cid'
    writeRepoTag({ cwd, enrolment: e, codeHash: CODE_HASH })
    const s = readRepo(cwd)
    // The higher-privilege read cred must NOT spread at rest into the repo file…
    expect(s.env.TOKENSCOPE_READ_REFRESH_TOKEN).toBeUndefined()
    expect(s.env.TOKENSCOPE_READ_CLIENT_ID).toBeUndefined()
    // …the rest of the emit credential IS copied (the repo still emits)…
    expect(s.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe('https://login/token')
    expect(s.env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('cid')
    // …EXCEPT the durable refresh token itself (S1 fix 4 — walks the SAME
    // sibling path this test already pins for the read credential).
    expect(s.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined()
  })

  it('S1 fix 4 — a PRE-EXISTING repo file carrying TOKENSCOPE_OAUTH_REFRESH_TOKEN is rewritten WITHOUT it, every other key surviving (self-healing for the key it removes)', () => {
    // Simulate a repo tagged BEFORE this fix landed: the refresh token sits at
    // rest in the repo file already.
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          otelHeadersHelper: '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh',
          env: {
            OTEL_RESOURCE_ATTRIBUTES: `tokenscope.instance_id=inst-A,project.code_hash=${CODE_HASH},tool=claude-code`,
            TOKENSCOPE_BEARER_ENDPOINT: 'https://api/api/v1/instances/inst-A/bearer',
            TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt-STALE-AT-REST',
            TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://login/token',
            TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
          },
        },
        null,
        2,
      ) + '\n',
    )
    // replaceEnv:true rewrites the whole block on the NEXT SessionStart in
    // every tagged repo on every enrolled device — this is that rewrite.
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    const s = readRepo(cwd)
    expect(s.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBeUndefined() // removed at rest
    expect(s.env.TOKENSCOPE_BEARER_ENDPOINT).toBe('https://api/api/v1/instances/inst-A/bearer')
    expect(s.env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe('https://login/token')
    expect(s.env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('cid')
  })

  it('.gitignore gains the repo-tag entry idempotently', () => {
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const gi1 = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(gi1).toMatch(/\.claude\/settings\.local\.json/)
    // A second call (a true no-op for the settings file) must not duplicate
    // the .gitignore entry.
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const gi2 = readFileSync(join(cwd, '.gitignore'), 'utf8')
    const occurrences = gi2.split('\n').filter((l) => l.trim() === '.claude/settings.local.json').length
    expect(occurrences).toBe(1)
  })

  it('.gitignore self-heal recognises an existing entry and does not duplicate it', () => {
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n.claude/settings.local.json\n')
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8')
    const occurrences = gi.split('\n').filter((l) => l.trim() === '.claude/settings.local.json').length
    expect(occurrences).toBe(1)
  })

  it('S1 fix 4c — a cwd BELOW the repo root writes to the ROOT .claude/, never the subdirectory\'s', () => {
    const nested = join(cwd, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    const r = writeRepoTag({ cwd: nested, enrolment: enrolment(), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    expect(r.settingsPath).toBe(join(cwd, '.claude', 'settings.local.json'))
    expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(join(nested, '.claude'))).toBe(false)
  })

  it('S1 fix 4c — a git WORKTREE (.git is a FILE, not a dir) still resolves and tags at the worktree root', () => {
    // A real worktree's `.git` is a plain file containing `gitdir: <path>`,
    // not a directory. resolveRepoRoot must not assume a directory.
    rmSync(join(cwd, '.git'), { recursive: true, force: true })
    writeFileSync(join(cwd, '.git'), 'gitdir: /some/other/repo/.git/worktrees/x\n')
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    expect(r.changed).toBe(true)
    expect(existsSync(join(cwd, '.claude', 'settings.local.json'))).toBe(true)
  })

  it('S1 fix 4c — no resolvable repo root (no .git anywhere) → refuses to write, never throws', () => {
    // A dir with no .git ancestor at all (mkdtempSync roots are not inside a
    // git work tree once the fixture .git marker is removed).
    rmSync(join(cwd, '.git'), { recursive: true, force: true })
    let r
    expect(() => {
      r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    }).not.toThrow()
    expect(r).toEqual({ settingsPath: null, changed: false, healed: false })
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
  })

  it('prefers the ACTIVE plugin helper (CLAUDE_PLUGIN_ROOT) over the version-pinned global one — upgrade auto-follow, no re-enrol', () => {
    const activeRoot = join(cwd, 'active-plugin')
    mkdirSync(join(activeRoot, 'scripts'), { recursive: true })
    writeFileSync(join(activeRoot, 'scripts', 'otel-headers-helper.sh'), '#!/bin/sh\n')
    process.env.CLAUDE_PLUGIN_ROOT = activeRoot
    // Global still pins an OLD version path; the active version must win.
    const r = writeRepoTag({
      cwd,
      enrolment: enrolment({ helper: '/plugins/tokenscope/0.1.1/scripts/otel-headers-helper.sh' }),
      codeHash: CODE_HASH,
    })
    expect(r.changed).toBe(true)
    expect(readRepo(cwd).otelHeadersHelper).toBe(join(activeRoot, 'scripts', 'otel-headers-helper.sh'))
  })

  it('active-version pin is a stable no-op on a same-version relaunch (no spurious heal / mtime churn)', () => {
    const activeRoot = join(cwd, 'active-plugin')
    mkdirSync(join(activeRoot, 'scripts'), { recursive: true })
    writeFileSync(join(activeRoot, 'scripts', 'otel-headers-helper.sh'), '#!/bin/sh\n')
    process.env.CLAUDE_PLUGIN_ROOT = activeRoot
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const before = statSync(join(cwd, '.claude', 'settings.local.json')).mtimeMs
    const r = writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const after = statSync(join(cwd, '.claude', 'settings.local.json')).mtimeMs
    expect(r.changed).toBe(false)
    expect(r.healed).toBe(false)
    expect(after).toBe(before)
  })

  it('falls back to the global-pinned helper when CLAUDE_PLUGIN_ROOT has no helper (partial/absent install)', () => {
    process.env.CLAUDE_PLUGIN_ROOT = join(cwd, 'no-plugin')
    writeRepoTag({
      cwd,
      enrolment: enrolment({ helper: '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh' }),
      codeHash: CODE_HASH,
    })
    expect(readRepo(cwd).otelHeadersHelper).toBe('/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh')
  })

  it('preserves the 0o600 mode and merges unrelated local settings keys', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2) + '\n',
    )
    writeRepoTag({ cwd, enrolment: enrolment(), codeHash: CODE_HASH })
    const s = readRepo(cwd)
    expect(s.permissions.allow).toEqual(['Bash(ls:*)']) // unrelated key kept
    const mode = statSync(join(cwd, '.claude', 'settings.local.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

// --- SessionStart hook end-to-end (child process) -----------------------

const HOOK = resolve(__dirname, '../../../plugin/hooks/session-start.mjs')

/** Write a fake global ~/.claude/settings.json under `home`. */
function writeGlobal(home: string, { instance = 'inst-A', helper = '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh' } = {}) {
  mkdirSync(join(home, '.claude'), { recursive: true })
  const e = enrolment({ instance, helper })
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ otelHeadersHelper: e.helperPath, env: e.env }, null, 2) + '\n',
  )
}

/**
 * Run the hook with HOME=home and cwd=repo. Returns its stdout.
 * CLAUDE_PLUGIN_ROOT points at a dir with NO helper so the emission-health probe
 * is a no-op in the self-heal tests (it runs the REAL emit path otherwise); the
 * dedicated health-warning tests below drive that path via the sentinel instead.
 */
function runHook(home: string, repo: string, pluginRoot: string = join(home, 'no-plugin')) {
  // Pin the plugin state dir explicitly to the sandbox home. stateDir() is now
  // anchored on the passwd home (HOME-leak-proof), so a HOME override alone no
  // longer redirects ~/.tokenscope — TOKENSCOPE_STATE_DIR is the supported seam.
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TOKENSCOPE_STATE_DIR: join(home, '.tokenscope'),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  }
  // These emission-health tests assert a SILENT hook. Strip the host CLI's
  // version signal so the shim policy sees a fixed/unknown CLI and does not add
  // its auto-enabled note (the host runs an affected 2.1.x during CI). Tests that
  // want the shim active set CLAUDE_CODE_EXECPATH explicitly.
  delete env.CLAUDE_CODE_EXECPATH
  delete env.AI_AGENT
  return execFileSync(process.execPath, [HOOK], {
    cwd: repo,
    env,
    encoding: 'utf8',
  })
}

/** Write a stub otel-headers-helper.sh under <dir>/scripts and return <dir>. */
function stubHelperRoot(dir: string, body: string): string {
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'otel-headers-helper.sh'), body)
  return dir
}

describe('session-start hook (end-to-end)', () => {
  let home: string
  let repo: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ts-home-'))
    repo = mkdtempSync(join(tmpdir(), 'ts-repo-'))
    mkdirSync(join(repo, '.git'), { recursive: true }) // S1 fix 4c: repo-root anchor
    writeFileSync(join(repo, '.tokenscope'), `project:\n  code: ${CODE}\n`)
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('REWRITES the repo pin when global helper path changed, project.code_hash unchanged', () => {
    // Initial pin under 0.1.1.
    writeGlobal(home, { helper: '/plugins/tokenscope/0.1.1/scripts/otel-headers-helper.sh' })
    runHook(home, repo)
    expect(readRepo(repo).otelHeadersHelper).toContain('0.1.1')

    // Plugin upgraded to 0.1.3 in global only. Hash is identical.
    writeGlobal(home, { helper: '/plugins/tokenscope/0.1.3/scripts/otel-headers-helper.sh' })
    runHook(home, repo)
    expect(readRepo(repo).otelHeadersHelper).toContain('0.1.3') // healed, not skipped
  })

  it('REWRITES when the global instance changed (re-enrol), project.code_hash unchanged', () => {
    writeGlobal(home, { instance: 'inst-OLD' })
    runHook(home, repo)
    expect(readRepo(repo).env.OTEL_RESOURCE_ATTRIBUTES).toContain('inst-OLD')

    writeGlobal(home, { instance: 'inst-NEW' })
    runHook(home, repo)
    expect(readRepo(repo).env.OTEL_RESOURCE_ATTRIBUTES).toContain('inst-NEW')
  })

  it('is a TRUE no-op (stable mtime) when the repo already equals current-global + hash', () => {
    writeGlobal(home)
    runHook(home, repo)
    const before = statSync(join(repo, '.claude', 'settings.local.json')).mtimeMs
    runHook(home, repo)
    const after = statSync(join(repo, '.claude', 'settings.local.json')).mtimeMs
    expect(after).toBe(before)
  })

  it('fails OPEN: a throw inside is swallowed and the hook exits 0', () => {
    // Make the repo's .claude path un-writable so writeRepoTag throws: create
    // .claude as a FILE (mkdirSync inside the hook then fails), proving the
    // top-level catch swallows it and process.exit(0) still runs.
    writeGlobal(home)
    writeFileSync(join(repo, '.claude'), 'not-a-dir')
    // execFileSync throws if exit code != 0; a clean return proves exit 0.
    expect(() => runHook(home, repo)).not.toThrow()
    // And it really did fail (no settings written under the file-path).
    expect(() => readRepo(repo)).toThrow()
    chmodSync(join(repo, '.claude'), 0o600) // make cleanup easy
  })

  it('emission-health: warns (systemMessage) on a LIVE helper failure (exit 1 → 401 sentinel)', () => {
    writeGlobal(home) // enrolled → the health check runs
    // Stub helper that genuinely fails: writes a 401 sentinel + exits 1.
    const stub = stubHelperRoot(
      join(home, 'fail-plugin'),
      `mkdir -p "$HOME/.tokenscope"
printf '{"ts":"t","http_status":401,"message":"revoked"}' > "$HOME/.tokenscope/emit-failure.json"
exit 1
`,
    )
    const out = runHook(home, repo, stub)
    const parsed = JSON.parse(out)
    expect(parsed.systemMessage).toMatch(/NOT emitting/i)
    expect(parsed.systemMessage).toMatch(/401/)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
  })

  it('emission-health: does NOT warn from a STALE sentinel — runs the live (self-healing) helper instead', () => {
    writeGlobal(home)
    // A pre-existing 401 sentinel (stale)…
    mkdirSync(join(home, '.tokenscope'), { recursive: true })
    writeFileSync(join(home, '.tokenscope', 'emit-failure.json'), JSON.stringify({ ts: 't', http_status: 401, message: 'stale' }))
    // …but a HEALTHY helper that does NOT clear the sentinel → the hook must stay
    // SILENT via the exit-0 status gate, NOT by reading (and ignoring) the sentinel.
    const stub = stubHelperRoot(
      join(home, 'ok-plugin'),
      `printf '{"Authorization":"Bearer x"}'
exit 0
`,
    )
    const out = runHook(home, repo, stub)
    expect(out.trim()).toBe('')
  })

  it('emission-health: exit-0 with NO bearer + a stale sentinel still stays SILENT (status gate, not the sentinel)', () => {
    writeGlobal(home)
    mkdirSync(join(home, '.tokenscope'), { recursive: true })
    writeFileSync(join(home, '.tokenscope', 'emit-failure.json'), JSON.stringify({ ts: 't', http_status: 401, message: 'stale' }))
    // Degenerate helper: exits 0 but prints no Authorization and does NOT clear the
    // sentinel. The hook treats exit-0 as healthy and never reads the stale sentinel
    // (adversarial R MEDIUM-1 — would warn under the old `status===0 && hasAuth` gate).
    const stub = stubHelperRoot(join(home, 'exit0-noauth-plugin'), `printf 'not-a-bearer'\nexit 0\n`)
    const out = runHook(home, repo, stub)
    expect(out.trim()).toBe('')
  })

  it('emission-health: stays SILENT (fail-open) when the probe helper is unavailable', () => {
    // CLAUDE_PLUGIN_ROOT points at a no-helper dir (runHook), so runEmitHelper
    // returns ran=false → no warning, no crash, exit 0. Proves the probe path
    // fails open when it cannot run.
    writeGlobal(home)
    const out = runHook(home, repo)
    expect(out.trim()).toBe('')
  })
})
