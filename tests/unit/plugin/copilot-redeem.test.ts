/**
 * copilot-redeem — credential separation unit tests
 *
 * Pins the invariant that after writeTokenscopeConfig():
 *   1. ~/.tokenscope/config.json contains oauth_refresh_token (required by mintBearer).
 *   2. ~/.tokenscope/oauth-access.json does NOT contain oauth_refresh_token —
 *      otel-headers-helper.sh overwrites that file on every bearer refresh
 *      with {access_token, expires_at}, so storing the refresh_token there
 *      would destroy it on first mint (was bug B2).
 *   3. Cross-environment transition robustness: when the redeem points at a
 *      DIFFERENT deployment (the bearer-endpoint host changed — Sandbox→Dev,
 *      Dev→Prod), config.json is written CLEAN so stale credentials/endpoints
 *      from the OLD environment cannot survive at rest; on a SAME-environment
 *      re-run the credential/endpoint fields are refreshed in place while any
 *      legitimately user-set (non-managed) key is preserved.
 *
 * Also pins basic shell-RC block idempotency for completeness.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── helpers: dynamically import the CJS-like MJS helpers ────────────────────
// writeTokenscopeConfig is a module-private helper; we test via the public API
// by driving main() through its internal fn. Instead, reach in via a thin
// re-export shim or test the public surface: write files in a temp dir and
// verify their contents by invoking the relevant node APIs on the temp files.
//
// copilot-redeem.mjs has no named exports, but we can isolate the helpers
// by extracting them as pure functions. Since changing the module shape
// would require a spec change, instead we test the invariant at the
// integration boundary: invoke writeTokenscopeConfig by building a minimal
// mock bundle and checking the written files.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { writeTokenscopeConfig, removeBlock, upsertBlock, detectShellRcTargets, detectEnvChange, emitEnvLabel } =
  await import('../../../plugin/scripts/copilot-redeem.mjs')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-redeem-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const FAKE_BUNDLE = {
  instance_id: 'bbbaaaaa-0000-0000-0000-000000000001',
  TOKENSCOPE_BEARER_ENDPOINT: 'https://ts.example.com/bearer',
  TOKENSCOPE_LOGS_ENDPOINT: 'https://ts.example.com/logs',
  TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ts.example.com/oauth/token',
  COPILOT_OTEL_FILE_EXPORTER_PATH: '/tmp/copilot-otel.ndjson',
  OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=bbbaaaaa',
}

describe('writeTokenscopeConfig — credential separation', () => {
  it('config.json contains oauth_refresh_token (required by mintBearer)', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_super_secret', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(config.oauth_refresh_token).toBe('rt_super_secret')
    expect(config.oauth_client_id).toBe('client-abc')
    expect(config.instance_id).toBe(FAKE_BUNDLE.instance_id)
  })

  it('oauth-access.json does NOT contain oauth_refresh_token', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_super_secret', 'client-abc', dir)
    const oauthCache = JSON.parse(readFileSync(join(dir, 'oauth-access.json'), 'utf8'))
    // Must be the empty access-token cache shape only — no refresh_token!
    expect(oauthCache).not.toHaveProperty('oauth_refresh_token')
    expect(oauthCache).not.toHaveProperty('refresh_token')
    expect(oauthCache).toHaveProperty('access_token')
    expect(oauthCache).toHaveProperty('expires_at')
  })

  it('oauth-access.json access_token placeholder is empty (helper populates on first mint)', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt_super_secret', 'client-abc', dir)
    const oauthCache = JSON.parse(readFileSync(join(dir, 'oauth-access.json'), 'utf8'))
    // The placeholder must not accidentally carry a real token.
    expect(oauthCache.access_token).toBe('')
    expect(oauthCache.expires_at).toBe(0)
  })

  it('copilot_otel_file_path is PER-PROJECT and RELATIVE, not the server-sent value', () => {
    // Per-project re-architecture: telemetry lives WITH the project, so config stores a
    // RELATIVE path (`.tokenscope.local/copilot-otel.jsonl`) the forwarder resolves
    // against ITS cwd (= the project root) — NOT a HOME-absolute path (which would drag
    // the forwarder back to the old per-HOME model) and NOT the server-sent value (the
    // server bakes its own container $HOME, which never exists on the client).
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(config.copilot_otel_file_path).toBe(join('.tokenscope.local', 'copilot-otel.jsonl'))
    expect(config.copilot_otel_file_path).not.toBe(FAKE_BUNDLE.COPILOT_OTEL_FILE_EXPORTER_PATH)
    // Relative — never an absolute path (would re-pin to HOME).
    expect(config.copilot_otel_file_path.startsWith('/')).toBe(false)
  })

  it('both files are created even when the dir already exists', () => {
    // First write
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // Second write (same dir, new token)
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(config.oauth_refresh_token).toBe('rt2')
    expect(existsSync(join(dir, 'oauth-access.json'))).toBe(true)
  })

  it('re-redeem does NOT clobber an existing oauth-access.json (live helper cache — PLG-2)', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // Simulate otel-headers-helper.sh having populated the access-token cache.
    const live = { access_token: 'live-access-token', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.json'), JSON.stringify(live))
    // Re-redeem (credential rotation) must rotate config.json but keep the cache.
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    expect(JSON.parse(readFileSync(join(dir, 'oauth-access.json'), 'utf8'))).toEqual(live)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).oauth_refresh_token).toBe('rt2')
  })

  it('atomic write leaves no temp droppings in the target dir', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })
})

// ── cross-environment transition robustness ────────────────────────────────────
// Re-provisioning a device from one TokenScope deployment to another (Sandbox→Dev,
// Dev→Prod) must NOT leave the OLD deployment's bearer/logs endpoints or OAuth
// credential at rest in config.json. The change is detected from the bearer host.
describe('writeTokenscopeConfig — cross-environment transition', () => {
  // A SANDBOX bundle (the device's first/old enrolment).
  const SANDBOX_BUNDLE = {
    instance_id: 'sandbox-inst-0000',
    TOKENSCOPE_BEARER_ENDPOINT:
      'https://ep-tokenscope-sandbox-aue.example.com/api/v1/instances/old/bearer',
    TOKENSCOPE_LOGS_ENDPOINT: 'https://dce-tokenscope-otlp.example.com/v1/logs',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://ep-tokenscope-sandbox-aue.example.com/oauth/token',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=sandbox-inst-0000,tool=copilot-cli',
  }
  // A DEV bundle — a DIFFERENT deployment (bearer host differs from SANDBOX_BUNDLE).
  const DEV_BUNDLE = {
    instance_id: 'dev-inst-0000',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://tokenscope.example.com/api/v1/instances/dev/bearer',
    TOKENSCOPE_LOGS_ENDPOINT: 'https://dce-tokenscope-dev.example.com/v1/logs',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://tokenscope.example.com/oauth/token',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=dev-inst-0000,tool=copilot-cli',
  }

  it('writes a CLEAN config on an environment change — stale old-env endpoints/creds are GONE', () => {
    // First enrol on Sandbox (writes config.json with Sandbox endpoints + a Sandbox cred,
    // plus an unrelated key the old deployment happened to carry).
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    const stale = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    stale.stale_old_env_field = 'should-not-survive'
    writeFileSync(join(dir, 'config.json'), JSON.stringify(stale, null, 2) + '\n')

    // Re-provision onto Dev (a different deployment).
    const change = writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))

    expect(change.changed).toBe(true)
    // Endpoints + credential are the NEW (Dev) environment's.
    expect(cfg.bearer_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
    expect(cfg.logs_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_LOGS_ENDPOINT)
    expect(cfg.oauth_token_endpoint).toBe(DEV_BUNDLE.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT)
    expect(cfg.oauth_refresh_token).toBe('dev_rt')
    expect(cfg.oauth_client_id).toBe('dev-client')
    expect(cfg.instance_id).toBe(DEV_BUNDLE.instance_id)
    expect(cfg.otel_resource_attributes).toBe(DEV_BUNDLE.OTEL_RESOURCE_ATTRIBUTES)
    // NOTHING from the OLD environment survives — not its endpoints, not its cred,
    // not any extra field it carried.
    expect(cfg.bearer_endpoint).not.toBe(SANDBOX_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
    expect(cfg.logs_endpoint).not.toBe(SANDBOX_BUNDLE.TOKENSCOPE_LOGS_ENDPOINT)
    expect(cfg.oauth_refresh_token).not.toBe('sandbox_rt')
    expect(cfg).not.toHaveProperty('stale_old_env_field')
  })

  it('env change reports old→new labels derived from the bearer hosts (never a credential)', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    const change = writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    expect(change.changed).toBe(true)
    expect(change.oldLabel).toBe('Sandbox')
    expect(change.newLabel).toBe('Dev')
  })

  it('resets the oauth-access.json cache on an environment change (old access token is useless)', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    // Simulate the helper having minted+cached a Sandbox access token.
    const live = { access_token: 'sandbox-access-token', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.json'), JSON.stringify(live))
    writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    const cache = JSON.parse(readFileSync(join(dir, 'oauth-access.json'), 'utf8'))
    // The Sandbox-minted token can't authorise the Dev bearer endpoint — must be reset.
    expect(cache.access_token).toBe('')
    expect(cache.expires_at).toBe(0)
  })

  it('SAME environment: refreshes credential/endpoint fields, PRESERVES user-set keys', () => {
    // Enrol, then a user/tool adds an unrelated key to config.json.
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const cfg0 = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    cfg0.my_custom_setting = 'keep-me'
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg0, null, 2) + '\n')

    // Same-deployment re-run (same bearer host) with a rotated credential.
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    const cfg1 = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))

    expect(change.changed).toBe(false)
    // Credential refreshed in place.
    expect(cfg1.oauth_refresh_token).toBe('rt2')
    // User-set key preserved.
    expect(cfg1.my_custom_setting).toBe('keep-me')
  })

  it('SAME environment: does NOT reset a live oauth-access.json cache', () => {
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    const live = { access_token: 'live-access-token', expires_at: 9999999999 }
    writeFileSync(join(dir, 'oauth-access.json'), JSON.stringify(live))
    writeTokenscopeConfig(FAKE_BUNDLE, 'rt2', 'client-abc', dir)
    // Same-env re-run keeps a perfectly valid cached access token (PLG-2 behaviour).
    expect(JSON.parse(readFileSync(join(dir, 'oauth-access.json'), 'utf8'))).toEqual(live)
  })

  it('a fresh device (no existing config) is NOT an environment change', () => {
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    expect(change.changed).toBe(false)
  })

  it('ignores an unparseable existing config (treats as fresh, writes clean valid JSON)', () => {
    writeFileSync(join(dir, 'config.json'), '{ not valid json')
    const change = writeTokenscopeConfig(FAKE_BUNDLE, 'rt1', 'client-abc', dir)
    // No prior bearer host to compare → not an env change; the corrupt file is replaced.
    expect(change.changed).toBe(false)
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(cfg.oauth_refresh_token).toBe('rt1')
    expect(cfg.bearer_endpoint).toBe(FAKE_BUNDLE.TOKENSCOPE_BEARER_ENDPOINT)
  })

  it('leaves no temp droppings on an environment change', () => {
    writeTokenscopeConfig(SANDBOX_BUNDLE, 'sandbox_rt', 'sandbox-client', dir)
    writeTokenscopeConfig(DEV_BUNDLE, 'dev_rt', 'dev-client', dir)
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([])
  })
})

describe('detectEnvChange — bearer-host comparison', () => {
  const bundleFor = (bearer: string, logs = '') => ({
    TOKENSCOPE_BEARER_ENDPOINT: bearer,
    TOKENSCOPE_LOGS_ENDPOINT: logs,
  })

  it('changed=false on a fresh device (no existing bearer host)', () => {
    expect(detectEnvChange(null, bundleFor('https://tokenscope.example.com/bearer')).changed).toBe(false)
  })

  it('changed=false on a same-host re-run', () => {
    const existing = { bearer_endpoint: 'https://ts.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('https://ts.example.com/bearer')).changed).toBe(false)
  })

  it('changed=true only when both hosts are present AND differ', () => {
    const existing = { bearer_endpoint: 'https://ep-tokenscope-sandbox-aue.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('https://tokenscope.example.com/bearer')).changed).toBe(true)
  })

  it('changed=false when the new bundle has no parseable bearer host (cannot classify a move)', () => {
    const existing = { bearer_endpoint: 'https://ts.example.com/bearer' }
    expect(detectEnvChange(existing, bundleFor('')).changed).toBe(false)
  })
})

describe('emitEnvLabel — host classification (mirrors statusline)', () => {
  it('classifies the known product tokens from the bearer host', () => {
    expect(emitEnvLabel('https://tokenscope.example.com/bearer')).toBe('Dev')
    expect(emitEnvLabel('https://ep-tokenscope-sandbox-aue.example.com/bearer')).toBe('Sandbox')
    expect(emitEnvLabel('https://tokenscope-production.example.com/bearer')).toBe('Prod')
  })

  it('classifies localhost as Local', () => {
    expect(emitEnvLabel('http://localhost:3000/bearer')).toBe('Local')
  })

  it('returns the bare host for an unrecognised deployment', () => {
    expect(emitEnvLabel('https://ts.example.com/bearer')).toBe('ts.example.com')
  })

  it('returns null when nothing is configured', () => {
    expect(emitEnvLabel('', '')).toBe(null)
    expect(emitEnvLabel(undefined, undefined)).toBe(null)
  })
})

describe('removeBlock / upsertBlock idempotency', () => {
  const BLOCK_START = '# >>> TokenScope >>>'
  const BLOCK_END   = '# <<< TokenScope <<<'

  it('removeBlock strips the delimited block and leaves surrounding content intact', () => {
    const content = `# preamble\n${BLOCK_START}\nexport FOO=bar\n${BLOCK_END}\n# epilogue\n`
    const stripped = removeBlock(content)
    expect(stripped).not.toContain('FOO=bar')
    expect(stripped).toContain('# preamble')
    expect(stripped).toContain('# epilogue')
  })

  it('removeBlock is idempotent (double-remove safe)', () => {
    const content = `${BLOCK_START}\nexport X=1\n${BLOCK_END}\n`
    expect(removeBlock(removeBlock(content))).toBe(removeBlock(content))
  })

  it('upsertBlock replaces existing block (idempotent re-provision)', () => {
    const old = `existing content\n${BLOCK_START}\nexport OLD=yes\n${BLOCK_END}\n`
    const updated = upsertBlock(old, ['export NEW=yes'])
    expect(updated).not.toContain('OLD=yes')
    expect(updated).toContain('NEW=yes')
    // Only one block after upsert.
    expect((updated.match(new RegExp(BLOCK_START, 'g')) ?? []).length).toBe(1)
  })

  it('upsertBlock appends a new block when none exists', () => {
    const content = 'export PATH=$PATH:/usr/local/bin\n'
    const result = upsertBlock(content, ['export TOKENSCOPE=1'])
    expect(result).toContain(BLOCK_START)
    expect(result).toContain('TOKENSCOPE=1')
    expect(result).toContain(BLOCK_END)
  })
})

describe('detectShellRcTargets — login + non-login coverage (the .bashrc-only bug fix)', () => {
  // Regression: writing only ~/.bashrc left COPILOT_OTEL_FILE_EXPORTER_PATH unset on
  // LOGIN-shell launches (SSH, tmux, many terminals) — they read ~/.profile /
  // ~/.bash_profile, not ~/.bashrc — so Copilot emitted nothing.
  it('bash without ~/.bash_profile → ~/.bashrc AND ~/.profile', () => {
    expect(detectShellRcTargets(undefined, dir, '/bin/bash')).toEqual([
      join(dir, '.bashrc'),
      join(dir, '.profile'),
    ])
  })

  it('bash WITH ~/.bash_profile → also writes it (it shadows ~/.profile for login bash)', () => {
    writeFileSync(join(dir, '.bash_profile'), '# x\n')
    expect(detectShellRcTargets(undefined, dir, '/bin/bash')).toEqual([
      join(dir, '.bashrc'),
      join(dir, '.profile'),
      join(dir, '.bash_profile'),
    ])
  })

  it('bash WITH ~/.bash_login (no ~/.bash_profile) → also writes it', () => {
    writeFileSync(join(dir, '.bash_login'), '# x\n')
    expect(detectShellRcTargets(undefined, dir, '/bin/bash')).toEqual([
      join(dir, '.bashrc'),
      join(dir, '.profile'),
      join(dir, '.bash_login'),
    ])
  })

  it('zsh → ~/.zshrc, plus ~/.zprofile/~/.zshenv only when they already exist', () => {
    expect(detectShellRcTargets(undefined, dir, '/bin/zsh')).toEqual([join(dir, '.zshrc')])
    writeFileSync(join(dir, '.zshenv'), '# x\n')
    expect(detectShellRcTargets(undefined, dir, '/usr/bin/zsh')).toEqual([
      join(dir, '.zshrc'),
      join(dir, '.zshenv'),
    ])
  })

  it('explicit --shell-rc overrides detection (single target)', () => {
    expect(detectShellRcTargets('/custom/rc', dir, '/bin/bash')).toEqual(['/custom/rc'])
  })
})
