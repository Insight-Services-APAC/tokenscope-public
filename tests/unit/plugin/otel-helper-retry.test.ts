/*
 * otel-headers-helper.sh — the retry-once-on-401 self-heal (ADR-0007 follow-up).
 *
 * A CACHED OAuth access token that /bearer rejects (401/403) was likely
 * superseded (concurrent CW / out-of-band refresh / deploy) — the helper must
 * drop the cache, force ONE fresh refresh, and retry, rather than drop the emit
 * cycle and trip the proactive warning. A genuinely revoked credential fails the
 * refresh, or 401s the retry too (fatal).
 *
 * We drive the helper with a stub `curl` on PATH (no live network) that
 * distinguishes the OAuth-token POST from the /bearer GET and alternates the
 * /bearer status via a counter file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const HELPER = resolve(__dirname, '../../../plugin/scripts/otel-headers-helper.sh')

let tmp: string
let stubDir: string
let stateDir: string

const STUB = `#!/bin/sh
# stub curl: emulates -w '\\n%{http_code}' by printing <body>\\n<status>.
a="$*"
[ -n "\${STUB_ARGV:-}" ] && printf '%s\\n' "$a" >> "$STUB_ARGV"
case "$a" in
  *"/oauth/token"*)
    cat >/dev/null 2>&1 || true   # drain the --data-binary @- stdin
    if [ "\${STUB_TOKEN_FAIL:-0}" = "1" ]; then printf '{"error":"invalid_grant"}\\n400'
    else printf '{"access_token":"stub-access","expires_in":3600}\\n200'; fi ;;
  *"/bearer"*)
    n=0; [ -f "$STUB_COUNTER" ] && n="$(cat "$STUB_COUNTER")"; n=$((n+1)); printf '%s' "$n" > "$STUB_COUNTER"
    case "\${STUB_BEARER_MODE:-heal}" in
      ok)   printf '{"Authorization":"Bearer stub-bearer"}\\n200' ;;
      fail) printf '{"statusMessage":"revoked"}\\n401' ;;
      *)    if [ "$n" -eq 1 ]; then printf '{"statusMessage":"superseded"}\\n401'; else printf '{"Authorization":"Bearer stub-bearer"}\\n200'; fi ;;
    esac ;;
  *) printf '\\n000' ;;
esac
exit 0
`

function runHelper(env: Record<string, string>) {
  return spawnSync('sh', [HELPER], {
    encoding: 'utf8',
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      HOME: tmp,
      TOKENSCOPE_STATE_DIR: stateDir,
      TOKENSCOPE_BEARER_ENDPOINT: 'http://stub.local/api/v1/instances/x/bearer',
      TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'rt',
      TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'http://stub.local/api/v1/oauth/token',
      TOKENSCOPE_OAUTH_CLIENT_ID: 'cid',
      STUB_COUNTER: join(tmp, 'counter'),
      ...env,
    },
  })
}

function bearerCalls() {
  const f = join(tmp, 'counter')
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
}
function seedBogusCache() {
  writeFileSync(join(stateDir, 'oauth-access.json'), JSON.stringify({ access_token: 'BOGUS', expires_at: 9999999999 }))
}
const sentinelExists = () => existsSync(join(stateDir, 'emit-failure.json'))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-helper-'))
  stubDir = join(tmp, 'bin')
  stateDir = join(tmp, 'state')
  mkdirSync(stubDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const curl = join(stubDir, 'curl')
  writeFileSync(curl, STUB)
  chmodSync(curl, 0o755)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('otel-headers-helper retry-once-on-401', () => {
  it('self-heals a superseded cached token: 401 → force refresh → retry → 200', () => {
    seedBogusCache()
    const r = runHelper({ STUB_BEARER_MODE: 'heal' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer') // the retry minted a real bearer
    expect(bearerCalls()).toBe(2) // cached attempt + one retry
    expect(sentinelExists()).toBe(false) // no cry-wolf
  })

  it('a genuinely revoked credential still fails after the retry (exit 1 + sentinel)', () => {
    seedBogusCache()
    const r = runHelper({ STUB_BEARER_MODE: 'fail' })
    expect(r.status).toBe(1)
    expect(bearerCalls()).toBe(2) // tried cache, retried once, then gave up
    expect(sentinelExists()).toBe(true)
    expect(JSON.parse(readFileSync(join(stateDir, 'emit-failure.json'), 'utf8')).http_status).toBe(401)
  })

  it('a failed refresh exits before ever calling /bearer (no retry loop on a dead refresh)', () => {
    // No cache → forces an initial refresh, which the stub fails.
    const r = runHelper({ STUB_TOKEN_FAIL: '1' })
    expect(r.status).toBe(1)
    expect(bearerCalls()).toBe(0) // never reached /bearer
    expect(sentinelExists()).toBe(true)
  })

  it('never passes the refresh token on curl argv (secret-off-argv invariant — rides via stdin)', () => {
    const argvLog = join(tmp, 'argv.log')
    // No cache → forces a refresh POST; mode ok → /bearer 200.
    const r = runHelper({ STUB_BEARER_MODE: 'ok', STUB_ARGV: argvLog, TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'SECRET-REFRESH-VALUE' })
    expect(r.status).toBe(0)
    const logged = readFileSync(argvLog, 'utf8')
    expect(logged).toContain('/oauth/token') // the refresh POST did happen…
    expect(logged).not.toContain('SECRET-REFRESH-VALUE') // …but the token is NOT on argv (it rides via --data-binary @- stdin)
  })

  it('a valid cached token is used directly — exactly ONE /bearer call, no retry (200)', () => {
    writeFileSync(join(stateDir, 'oauth-access.json'), JSON.stringify({ access_token: 'GOOD', expires_at: 9999999999 }))
    const r = runHelper({ STUB_BEARER_MODE: 'ok' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stub-bearer')
    expect(bearerCalls()).toBe(1) // no retry needed
    expect(sentinelExists()).toBe(false)
  })
})
