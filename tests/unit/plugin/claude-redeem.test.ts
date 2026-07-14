/**
 * claude-redeem — device-enrolment unit tests
 *
 * claude-redeem.mjs is the Claude-Code analogue of copilot-redeem.mjs. It redeems
 * the emit handoff and writes the device's OTel plumbing + durable OAuth emit
 * credential into ~/.claude/settings.json. These tests pin the invariants the
 * emit path depends on:
 *
 *   1. The env block carries the three keys otel-headers-helper.sh REQUIRES
 *      (TOKENSCOPE_OAUTH_REFRESH_TOKEN/_TOKEN_ENDPOINT/_CLIENT_ID) — all or none,
 *      so a partial response never writes a half-configured (silently ignored)
 *      credential.
 *   2. The bearer endpoint is mapped from the bundle's otel_headers_helper_url.
 *   3. No TOKENSCOPE_READ_* keys are written (redeem is emit-only; read came from
 *      the MCP OAuth grant).
 *   4. writeClaudeSettings MERGES additively on a same-environment re-run — a
 *      developer's pre-existing permissions + unrelated env keys survive — and
 *      refuses to clobber an unparseable existing file.
 *   5. Cross-environment transition robustness: when the redeem points at a
 *      DIFFERENT deployment (the bearer-endpoint host changed), the env block is
 *      REPLACED wholesale so stale credentials/endpoints from the OLD environment
 *      (legacy TOKENSCOPE_SESSION_TOKEN / TOKENSCOPE_READ_*, the old bearer +
 *      OTLP endpoints) cannot survive at rest — while top-level non-env keys
 *      (permissions, statusLine) are still preserved. The change is detected from
 *      the bearer host and is silent on a same-host re-run.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { buildClaudeDeviceEnv, assertClaudeRedeemResponse, writeClaudeSettings, parseArgs } = await import(
  '../../../plugin/scripts/claude-redeem.mjs'
)

// A complete, valid /setup/redeem response for the claude-code path.
const FAKE_REDEEM_RESPONSE = {
  instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
  tool: 'claude-code',
  oauth_refresh_token: 'rt_super_secret',
  oauth_token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  oauth_client_id: 'client-abc',
  telemetry: {
    claude: {
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
      otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/abc/bearer',
      OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=f825e796,tool=claude-code',
    },
  },
}

const FAKE_CLAUDE_BUNDLE = {
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://ts.example.com/v1/logs',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
  otel_headers_helper_url: 'https://ts.example.com/api/v1/instances/abc/bearer',
  OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=abc,tool=claude-code',
}
const FAKE_OAUTH = {
  refresh_token: 'rt_super_secret',
  token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
  client_id: 'client-abc',
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-claude-redeem-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('buildClaudeDeviceEnv', () => {
  it('maps the bundle + OAuth credential into the env keys the helper requires', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp')
    expect(env.OTEL_METRICS_EXPORTER).toBe('none')
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('https://ts.example.com/v1/logs')
    expect(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe('http/protobuf')
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=abc,tool=claude-code')
    // The bearer endpoint comes from the bundle's otel_headers_helper_url.
    expect(env.TOKENSCOPE_BEARER_ENDPOINT).toBe(FAKE_CLAUDE_BUNDLE.otel_headers_helper_url)
    // The durable emit credential — all three present.
    expect(env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_super_secret')
    expect(env.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(FAKE_OAUTH.token_endpoint)
    expect(env.TOKENSCOPE_OAUTH_CLIENT_ID).toBe('client-abc')
  })

  it('writes NO read-credential keys (redeem is emit-only)', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    expect(env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('TOKENSCOPE_READ_CLIENT_ID')
  })

  it('omits ALL OAuth keys when the credential block is incomplete (no half-config)', () => {
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { refresh_token: 'rt', client_id: 'c' }) // no token_endpoint
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_TOKEN_ENDPOINT')
    expect(env).not.toHaveProperty('TOKENSCOPE_OAUTH_CLIENT_ID')
  })

  it('returns {} for a missing bundle', () => {
    expect(buildClaudeDeviceEnv(null, FAKE_OAUTH)).toEqual({})
  })
})

describe('assertClaudeRedeemResponse', () => {
  it('returns {claude, oauth} for a complete valid response', () => {
    const { claude, oauth } = assertClaudeRedeemResponse(FAKE_REDEEM_RESPONSE)
    expect(claude.otel_headers_helper_url).toBe('https://ts.example.com/api/v1/instances/abc/bearer')
    expect(oauth).toEqual({
      refresh_token: 'rt_super_secret',
      token_endpoint: 'https://ts.example.com/api/v1/oauth/token',
      client_id: 'client-abc',
    })
  })

  it('rejects a Copilot bundle with a helpful message', () => {
    const copilot = { tool: 'copilot-cli', telemetry: { copilot: { instance_id: 'x' } } }
    expect(() => assertClaudeRedeemResponse(copilot)).toThrow(/Copilot bundle/)
  })

  it('rejects a response missing the claude bundle', () => {
    expect(() => assertClaudeRedeemResponse({ tool: 'claude-code', telemetry: {} })).toThrow(/usable Claude Code bundle/)
  })

  it('rejects a bundle missing OTEL_RESOURCE_ATTRIBUTES instance id (unattributable telemetry)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: { claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, OTEL_RESOURCE_ATTRIBUTES: 'tool=claude-code' } },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/tokenscope\.instance_id/)
  })

  it('rejects an EMPTY instance id value (tokenscope.instance_id=,...)', () => {
    const bad = {
      ...FAKE_REDEEM_RESPONSE,
      telemetry: {
        claude: { ...FAKE_REDEEM_RESPONSE.telemetry.claude, OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=,tool=claude-code' },
      },
    }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/tokenscope\.instance_id/)
  })

  it('rejects a response missing an OAuth credential field', () => {
    const bad = { ...FAKE_REDEEM_RESPONSE, oauth_token_endpoint: '' }
    expect(() => assertClaudeRedeemResponse(bad)).toThrow(/oauth_token_endpoint/)
  })
})

describe('writeClaudeSettings', () => {
  const HELPER = '/plugin/scripts/otel-headers-helper.sh'

  it('writes otelHeadersHelper + env into a fresh settings.json', () => {
    const path = join(dir, 'settings.json')
    const env = buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH)
    writeClaudeSettings(path, HELPER, env)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.otelHeadersHelper).toBe(HELPER)
    expect(written.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_super_secret')
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=abc,tool=claude-code')
  })

  it('preserves a developer’s pre-existing permissions and unrelated env keys', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(
      path,
      JSON.stringify({ permissions: { allow: ['Bash(node:*)'] }, env: { MY_VAR: 'keep' } }),
    )
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.permissions).toEqual({ allow: ['Bash(node:*)'] }) // top-level key preserved
    expect(written.env.MY_VAR).toBe('keep') // unrelated env key preserved (additive merge)
    expect(written.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1') // ours merged in
  })

  it('rotates the credential in place on re-run (overwrites the same keys)', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { ...FAKE_OAUTH, refresh_token: 'rt_rotated' }))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_rotated')
  })

  // ── cross-environment transition robustness ───────────────────────────────────
  // A "stale OLD environment" settings.json: a pre-cutover Sandbox enrolment that
  // still carries a legacy TOKENSCOPE_SESSION_TOKEN + TOKENSCOPE_READ_* and the old
  // deployment's bearer/OTLP endpoints — plus a developer's own top-level keys.
  const SANDBOX_BEARER = 'https://ep-tokenscope-sandbox-aue.example.com/api/v1/instances/old/bearer'
  const SANDBOX_OTLP = 'https://dce-tokenscope-otlp.example.com/v1/logs'
  const writeStaleSandboxSettings = (path: string) =>
    writeFileSync(
      path,
      JSON.stringify({
        permissions: { allow: ['Bash(node:*)'] },
        statusLine: { type: 'command', command: 'node /some/statusline.mjs', padding: 0 },
        otelHeadersHelper: '/old/otel-headers-helper.sh',
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          TOKENSCOPE_BEARER_ENDPOINT: SANDBOX_BEARER,
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: SANDBOX_OTLP,
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=sandboxinst,tool=claude-code',
          // Stale credentials from the OLD environment that must NOT survive.
          TOKENSCOPE_SESSION_TOKEN: 'legacy_session_tok',
          TOKENSCOPE_READ_REFRESH_TOKEN: 'legacy_read_rt',
          TOKENSCOPE_READ_CLIENT_ID: 'legacy_read_client',
          TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'sandbox_oauth_rt',
        },
      }),
    )

  // A Dev bundle — a DIFFERENT deployment (bearer host differs from FAKE_CLAUDE_BUNDLE
  // / the stale Sandbox host above).
  const DEV_BUNDLE = {
    ...FAKE_CLAUDE_BUNDLE,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://dce-tokenscope-dev.example.com/v1/logs',
    otel_headers_helper_url: 'https://tokenscope.example.com/api/v1/instances/devinst/bearer',
    OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=devinst,tool=claude-code',
  }

  it('REPLACES the env block on an environment change — stale session/read creds and old endpoints are GONE', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    // Env-change was detected (Sandbox host → Dev host).
    expect(change.changed).toBe(true)
    // Stale OLD-environment credentials are wiped.
    expect(written.env).not.toHaveProperty('TOKENSCOPE_SESSION_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_CLIENT_ID')
    // The OLD deployment's endpoints are replaced with the new environment's.
    expect(written.env.TOKENSCOPE_BEARER_ENDPOINT).toBe(DEV_BUNDLE.otel_headers_helper_url)
    expect(written.env.TOKENSCOPE_BEARER_ENDPOINT).not.toBe(SANDBOX_BEARER)
    expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DEV_BUNDLE.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)
    expect(written.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).not.toBe(SANDBOX_OTLP)
    // The fresh emit credential + instance attr are the NEW environment's.
    expect(written.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_super_secret')
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toBe('tokenscope.instance_id=devinst,tool=claude-code')
  })

  it('preserves NON-env top-level keys (permissions, statusLine) across an environment change', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH))
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.permissions).toEqual({ allow: ['Bash(node:*)'] })
    expect(written.statusLine).toEqual({ type: 'command', command: 'node /some/statusline.mjs', padding: 0 })
    // otelHeadersHelper is updated to the new helper path (a top-level key, restated).
    expect(written.otelHeadersHelper).toBe(HELPER)
  })

  it('detects an environment change when the bearer host changes (changed=true, with labels)', () => {
    const path = join(dir, 'settings.json')
    writeStaleSandboxSettings(path)
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(DEV_BUNDLE, FAKE_OAUTH))
    expect(change.changed).toBe(true)
    expect(change.oldLabel).toBe('Sandbox') // derived from the old bearer host
    expect(change.newLabel).toBe('Dev') // derived from the new bearer host
  })

  it('is SILENT (no env change) on a same-host re-run — additive merge keeps unrelated keys', () => {
    const path = join(dir, 'settings.json')
    // First enrol on FAKE_CLAUDE_BUNDLE (ts.example.com), then re-run on the SAME host.
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    // A developer hand-set an unrelated env key between runs — it must survive the
    // same-host (additive) re-run.
    const between = JSON.parse(readFileSync(path, 'utf8'))
    between.env.MY_VAR = 'keep'
    // A pre-OAuth/legacy enrolment also left a retired credential at rest.
    between.env.TOKENSCOPE_SESSION_TOKEN = 'legacy_session_tok'
    between.env.TOKENSCOPE_READ_REFRESH_TOKEN = 'legacy_read_rt'
    writeFileSync(path, JSON.stringify(between))
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, { ...FAKE_OAUTH, refresh_token: 'rt_rotated' }))
    expect(change.changed).toBe(false)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env.MY_VAR).toBe('keep') // additive merge preserved a real custom key
    expect(written.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_rotated')
    // F1: retired creds are stripped even on a SAME-env additive re-run — the
    // additive merge must NOT leave a legacy credential at rest.
    expect(written.env).not.toHaveProperty('TOKENSCOPE_SESSION_TOKEN')
    expect(written.env).not.toHaveProperty('TOKENSCOPE_READ_REFRESH_TOKEN')
  })

  it('treats a fresh device (no existing bearer host) as NOT an environment change', () => {
    const path = join(dir, 'settings.json')
    const change = writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    expect(change.changed).toBe(false)
  })

  it('refuses to clobber an existing but unparseable settings.json', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{ this is not json')
    expect(() => writeClaudeSettings(path, HELPER, { A: '1' })).toThrow(/not valid JSON/)
    // The bad file is left untouched, not overwritten.
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json')
  })

  it('leaves no .tmp file behind after an atomic write', () => {
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('writes the settings file with 0600 perms (POSIX only)', () => {
    if (platform() === 'win32') return // chmod is a no-op on Windows
    const path = join(dir, 'settings.json')
    writeClaudeSettings(path, HELPER, buildClaudeDeviceEnv(FAKE_CLAUDE_BUNDLE, FAKE_OAUTH))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('parseArgs', () => {
  it('accepts a bare positional handoff code', () => {
    expect(parseArgs(['abc123']).handoffCode).toBe('abc123')
  })

  it('accepts flags and does not treat a flag value as the positional code', () => {
    const a = parseArgs(['--handoff-code', 'h', '--api-base', 'https://x', '--instance-id', 'i', '--settings-path', '/s'])
    expect(a.handoffCode).toBe('h')
    expect(a.apiBase).toBe('https://x')
    expect(a.instanceId).toBe('i')
    expect(a.settingsPath).toBe('/s')
  })
})

// End-to-end: spawn the real helper (main()) against a mock /setup/redeem server.
// Covers the orchestration unit tests can't reach: URL resolution, the POST,
// instance_id binding, exit codes, and the on-disk write.
describe('main() against a mock redeem server', () => {
  // Vitest runs with cwd at the repo root; resolve the helper from there.
  const HELPER = join(process.cwd(), 'plugin/scripts/claude-redeem.mjs')
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let lastBody: { handoff_code?: string; instance_id?: string } = {}

  const claudeBundle = (attrs = 'tokenscope.instance_id=f825e796,tool=claude-code') => ({
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${baseUrl}/azmon-stub/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/protobuf',
    otel_headers_helper_url: `${baseUrl}/api/v1/instances/f825e796/bearer`,
    OTEL_RESOURCE_ATTRIBUTES: attrs,
  })

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        lastBody = JSON.parse(raw || '{}')
        const code = lastBody.handoff_code
        if (code === 'BADATTRS') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildResp(claudeBundle('tool=claude-code'))))
        } else if (code === 'GOOD') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(buildResp(claudeBundle())))
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ statusMessage: 'Invalid, expired, or already-used handoff code' }))
        }
      })
    })
    function buildResp(claude: object) {
      return {
        instance_id: 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c',
        tool: 'claude-code',
        oauth_refresh_token: 'rt_DURABLE_SECRET',
        oauth_token_endpoint: `${baseUrl}/api/v1/oauth/token`,
        oauth_client_id: 'client-xyz',
        telemetry: { claude },
      }
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  // Async spawn (NOT spawnSync): the mock server runs in this same worker's event
  // loop, so a synchronous spawn would deadlock — the child's POST could never be
  // served while spawnSync blocked the loop.
  const run = (code: string, settingsPath: string, extra: string[] = []) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(
        'node',
        [HELPER, '--handoff-code', code, '--api-base', baseUrl, '--settings-path', settingsPath, ...extra],
        { encoding: 'utf8' } as never,
      )
      let stdout = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.on('close', (status) => resolve({ status, stdout }))
    })

  it('happy path: redeems, writes settings.json, exits 0, binds instance_id', async () => {
    const path = join(dir, 'settings.json')
    const r = await run('GOOD', path, ['--instance-id', 'f825e796-ef29-4aa0-9a35-4aa2a5b8059c'])
    expect(r.status).toBe(0)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('rt_DURABLE_SECRET')
    expect(written.env.OTEL_RESOURCE_ATTRIBUTES).toContain('tokenscope.instance_id=f825e796')
    // --instance-id was forwarded to the server for the bound-instance check.
    expect(lastBody.instance_id).toBe('f825e796-ef29-4aa0-9a35-4aa2a5b8059c')
    // The durable secret must never appear on stdout.
    expect(r.stdout).not.toContain('rt_DURABLE_SECRET')
  })

  it('bad bundle (no instance id): exits 1 and writes NOTHING', async () => {
    const path = join(dir, 'settings.json')
    const r = await run('BADATTRS', path)
    expect(r.status).toBe(1)
    expect(existsSync(path)).toBe(false)
  })

  it('401 from server: exits 1 and writes NOTHING', async () => {
    const path = join(dir, 'settings.json')
    const r = await run('WRONGCODE', path)
    expect(r.status).toBe(1)
    expect(existsSync(path)).toBe(false)
  })
})
