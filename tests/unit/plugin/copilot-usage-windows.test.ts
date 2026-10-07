// @vitest-environment node
/*
 * Copilot on Windows, end to end (#408 S7): the usage extension's spool -> mint
 * -> POST path with the bearer minted by the REAL otel-headers-helper.ps1, run
 * through mintBearer's win32 branch (platform injected, `pwsh` standing in for
 * powershell.exe via the test-only function argument), against a local stub
 * TokenScope + OTLP server.
 *
 * The emitter runs in a CHILD node process: mintBearer spawns the helper
 * synchronously, which would block this process's event loop and with it the
 * stub server the helper has to reach.
 *
 * TOKENSCOPE_PWSH / TOKENSCOPE_SKIP_PWSH as in otel-helper-conformance.test.ts:
 * a missing pwsh FAILS, never skips silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolvePwsh, childEnv } from './helpers/shells.js'

const ROOT = resolve(__dirname, '../../..')
const PWSH = process.env.TOKENSCOPE_PWSH || 'pwsh'
const SKIP = process.env.TOKENSCOPE_SKIP_PWSH === '1'
const LANE = process.env.COPILOT_EMIT_LANE ?? 'copilot-plugin'
const SID = '81bf258d-aca2-45b1-b317-c964b6c98390'
const INSTANCE = '9a1e0000-0000-4000-8000-000000000001'
const RT = 'rt-copilot-SECRET'
const BEARER = 'Bearer azure-SECRET'

interface Req { method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }
const reqs: Req[] = []
let server: http.Server
let base = ''
let tmp: string

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ts-copilot-win-'))
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      reqs.push({ method: req.method ?? '', path, headers: req.headers, body: Buffer.concat(chunks) })
      if (path.endsWith('/oauth/token')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ access_token: 'access-SECRET', expires_in: 3600, token_type: 'Bearer' }))
      }
      if (path.endsWith('/bearer')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ Authorization: BEARER }))
      }
      if (path === '/v1/logs') {
        res.writeHead(204)
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(tmp, { recursive: true, force: true })
})

function runChild(script: string, env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('close', (status) => done({ status, stdout, stderr }))
  })
}

describe.skipIf(SKIP)('Copilot usage extension on win32: spool -> mint (.ps1 under PowerShell) -> POST', () => {
  it('delivers the spooled usage with the bearer the .ps1 minted', async () => {
    const pwshPath = resolvePwsh(PWSH)
    const probe = pwshPath ? spawnSync(pwshPath, ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8' }) : null
    if (!pwshPath || !probe || probe.error || probe.status !== 0) {
      throw new Error(`pwsh missing (${PWSH}); set TOKENSCOPE_SKIP_PWSH=1 to skip`)
    }

    const state = mkdtempSync(join(tmp, 'state '))
    writeFileSync(
      join(state, 'config.copilot-cli.json'),
      JSON.stringify({
        version: 2,
        tool: 'copilot-cli',
        instance_id: INSTANCE,
        bearer_endpoint: `${base}/api/v1/instances/${INSTANCE}/bearer`,
        oauth_token_endpoint: `${base}/api/v1/oauth/token`,
        oauth_client_id: 'cid',
        oauth_refresh_token: RT,
        logs_endpoint: `${base}/v1/logs`,
        otel_resource_attributes: `tokenscope.instance_id=${INSTANCE},tool=copilot-cli`,
      }),
      { mode: 0o600 },
    )
    const emitUrl = pathToFileURL(join(ROOT, LANE, 'scripts/copilot-emit.mjs')).href
    const usageUrl = pathToFileURL(join(ROOT, LANE, 'scripts/copilot-usage.mjs')).href
    const script = `
      import { mintBearer } from ${JSON.stringify(emitUrl)}
      import { createUsageEmitter } from ${JSON.stringify(usageUrl)}
      const em = createUsageEmitter({
        sessionId: ${JSON.stringify(SID)},
        env: {},
        debounceMs: 60000,
        mint: (force) => mintBearer(force, { platform: 'win32', powershell: ${JSON.stringify(pwshPath)} }),
        resolveProjectCodeHash: () => null,
        resolveGithubOrg: () => null,
      })
      em.onEvent({ type: 'assistant.usage', id: 'e1', timestamp: '2026-09-23T13:35:05.153Z', data: {
        model: 'gpt-5-mini', inputTokens: 11830, outputTokens: 1680, cacheReadTokens: 7936, cacheWriteTokens: 0,
        initiator: 'user', apiCallId: 'call-1', copilotUsage: { totalNanoAiu: 453190000 } } })
      const r = await em.close()
      process.stdout.write(JSON.stringify(r))
    `
    const r = await runChild(script, childEnv({ TOKENSCOPE_STATE_DIR: state, HOME: tmp, PATH: process.env.PATH ?? '' }))
    expect(r.stderr).not.toContain(RT)
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ sent: 1, kept: 0 })

    // The helper ran (refresh -> /bearer), then the batch went out with ITS bearer.
    expect(reqs.map((q) => q.path)).toEqual([
      '/api/v1/oauth/token',
      `/api/v1/instances/${INSTANCE}/bearer`,
      '/v1/logs',
    ])
    // ...and it was the PowerShell helper, not the .sh (whose curl would mint too).
    expect(String(reqs[0].headers['user-agent'])).toMatch(/PowerShell/)
    expect(String(reqs[1].headers['user-agent'])).toMatch(/PowerShell/)
    const post = reqs[2]
    expect(post.method).toBe('POST')
    expect(post.headers.authorization).toBe(BEARER)
    expect(post.headers['content-type']).toBe('application/x-protobuf')
    expect(post.body.includes(Buffer.from('gpt-5-mini'))).toBe(true)
    // The .ps1 wrote ITS caches (same files as the .sh), and the spool drained.
    expect(existsSync(join(state, 'azure-bearer.copilot-cli.json'))).toBe(true)
    expect(existsSync(join(state, 'emit-failure.copilot-cli.json'))).toBe(false)
    expect(readdirSync(join(state, 'copilot-usage-spool')).filter((n) => !n.startsWith('.hb-'))).toEqual([])
  })
})
