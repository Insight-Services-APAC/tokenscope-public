/*
 * selfHealGlobalOtlpEndpoint — the SessionStart re-point of the GLOBAL
 * ~/.claude/settings.json logs endpoint onto the local Content-Length forwarder
 * (CC #72671). This covers UNTAGGED repos (which read the global env directly).
 * Guards: it writes ONLY when the endpoint actually changes (never churns the
 * global every session), preserves the credential + other keys, and reverts under
 * the kill-switch.
 *
 * TOKENSCOPE_STATE_DIR is set per-test so the stash lands in a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selfHealGlobalOtlpEndpoint } from '../../../plugin/hooks/session-start.mjs'

const PROXY = 'http://127.0.0.1:14318/v1/logs'
const DCE = 'https://dce-abc.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-x/streams/Custom-Logs?api-version=2023-01-01'

let dir = ''
let settingsPath = ''
let stateDir = ''

function writeSettings(endpoint: string | null) {
  const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1', TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'super-secret' }
  if (endpoint) env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = endpoint
  writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] }, env }, null, 2) + '\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-otlp-global-'))
  settingsPath = join(dir, 'settings.json')
  stateDir = join(dir, 'state')
  mkdirSync(stateDir, { recursive: true })
  process.env.TOKENSCOPE_STATE_DIR = stateDir
  delete process.env.TOKENSCOPE_OTLP_PROXY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.TOKENSCOPE_STATE_DIR
  delete process.env.TOKENSCOPE_OTLP_PROXY
})

describe('selfHealGlobalOtlpEndpoint', () => {
  it('re-points a real DCE endpoint to the proxy, preserving the credential + other keys', () => {
    writeSettings(DCE)
    selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret') // credential survives
    expect(out.permissions).toEqual({ allow: ['Bash'] }) // top-level keys survive
    // The stash the forwarder reads was written with the real DCE.
    expect(JSON.parse(readFileSync(join(stateDir, 'otlp-forward.json'), 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('does NOT write when the endpoint is already the proxy (idempotent — no churn)', () => {
    writeSettings(PROXY)
    const mtimeBefore = statSync(settingsPath).mtimeMs
    // Second-resolution mtime on some filesystems — force a detectable gap by
    // asserting the CONTENT is byte-identical (the real "did we write?" signal).
    const rawBefore = readFileSync(settingsPath, 'utf8')
    selfHealGlobalOtlpEndpoint({ settingsPath })
    const rawAfter = readFileSync(settingsPath, 'utf8')
    expect(rawAfter).toBe(rawBefore) // untouched — no churn
    // mtime is also unchanged (best-effort corroboration).
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore)
  })

  it('is a no-op when the endpoint is absent (not enrolled)', () => {
    writeSettings(null)
    const rawBefore = readFileSync(settingsPath, 'utf8')
    selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(rawBefore)
  })

  it('NEVER clobbers an unparseable settings.json (would wipe the credential)', () => {
    const garbage = '{ not valid json, secret: TOKEN '
    writeFileSync(settingsPath, garbage)
    selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage) // byte-for-byte untouched
  })

  it('reverts the global endpoint to the direct DCE under the kill-switch', () => {
    // Prior state: global is at the proxy, stash holds the real DCE.
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    process.env.TOKENSCOPE_OTLP_PROXY = '0'
    selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // reverted to direct
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret')
  })
})
