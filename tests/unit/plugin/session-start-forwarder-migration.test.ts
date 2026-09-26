/**
 * One-release migration off the removed OTLP forwarder (Claude plugin 0.1.41):
 * a user-level logs endpoint still pinned to the loopback forwarder is restored
 * from the copy the forwarder kept, or warned about when none survives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateOffForwarderEndpoint } from '../../../plugin/hooks/session-start.mjs'

const PROXY = 'http://127.0.0.1:14318/v1/logs'
const DCE = 'https://dce-tokenscope-dev.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-x/streams/Custom-OTelLogs'
const DCE2 = 'https://dce-other.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-y/streams/Custom-OTelLogs'

describe('migrateOffForwarderEndpoint', () => {
  let root: string
  let settingsPath: string
  let dir: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ts-fwd-migrate-'))
    settingsPath = join(root, 'settings.json')
    dir = join(root, 'state')
    mkdirSync(dir)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  const write = (env: Record<string, string>) =>
    writeFileSync(settingsPath, JSON.stringify({ otelHeadersHelper: '/h.sh', env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', ...env } }))
  const read = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
  const stash = (v: string) => writeFileSync(join(dir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: v }))
  const run = () => migrateOffForwarderEndpoint({ settingsPath, dir })

  it('restores the real endpoint from the settings copy, drops both copies, keeps everything else, says relaunch', () => {
    write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE })
    stash(DCE2)
    expect(run()).toMatch(/Restart `claude`/)
    const s = read()
    expect(s.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // the settings copy wins over the stash
    expect(s.env).not.toHaveProperty('TOKENSCOPE_DCE_LOGS_ENDPOINT')
    expect(s.env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(s.otelHeadersHelper).toBe('/h.sh')
    expect(existsSync(join(dir, 'otlp-forward.json'))).toBe(false)
  })

  it('falls back to the state-dir stash when the settings copy is absent', () => {
    write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY })
    stash(DCE)
    expect(run()).toMatch(/Restart `claude`/)
    expect(read().env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE)
  })

  it('refuses a copy that is not https or is loopback, and warns with nothing changed', () => {
    for (const bad of ['http://dce.example/streams/x', 'https://127.0.0.1/v1/logs']) {
      write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, TOKENSCOPE_DCE_LOGS_ENDPOINT: bad })
      stash(bad)
      const before = readFileSync(settingsPath, 'utf8')
      expect(run()).toMatch(/Re-run \/tokenscope:setup/)
      expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    }
  })

  it('on an already-direct device, drops a stale saved copy and the forwarder leftovers', () => {
    write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE, TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE2 })
    for (const f of ['otlp-forward.json', 'otlp-forwarder.pid', 'otlp-forwarder.log']) writeFileSync(join(dir, f), 'x')
    expect(run()).toBeNull()
    expect(read().env).not.toHaveProperty('TOKENSCOPE_DCE_LOGS_ENDPOINT')
    expect(read().env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE)
    for (const f of ['otlp-forward.json', 'otlp-forwarder.pid', 'otlp-forwarder.log']) expect(existsSync(join(dir, f))).toBe(false)
  })

  it("a tagged repo whose own file still names the forwarder gets the relaunch note", () => {
    write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE })
    const repoSettingsPath = join(root, 'repo-settings.local.json')
    writeFileSync(repoSettingsPath, JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY } }))
    expect(migrateOffForwarderEndpoint({ settingsPath, dir, repoSettingsPath })).toMatch(/Restart `claude`/)
    writeFileSync(repoSettingsPath, JSON.stringify({ env: { OTEL_RESOURCE_ATTRIBUTES: 'x' } }))
    expect(migrateOffForwarderEndpoint({ settingsPath, dir, repoSettingsPath })).toBeNull()
  })

  it('with no copy at all it warns to re-run setup, and keeps the stash it could not use', () => {
    write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY })
    stash('http://not-https.example/x')
    expect(run()).toMatch(/Re-run \/tokenscope:setup/)
    expect(existsSync(join(dir, 'otlp-forward.json'))).toBe(true)
  })

  it("leaves alone a direct endpoint, a user's own local collector, and an unreadable or absent file", () => {
    for (const ep of [DCE, 'http://localhost:4318/v1/logs', 'http://127.0.0.1:4318/v1/logs', 'http://127.0.0.1:14318/v1/traces']) {
      write({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: ep })
      const before = readFileSync(settingsPath, 'utf8')
      expect(run()).toBeNull()
      expect(readFileSync(settingsPath, 'utf8')).toBe(before)
    }
    writeFileSync(settingsPath, '{ not json')
    expect(run()).toBeNull()
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ not json')
    expect(migrateOffForwarderEndpoint({ settingsPath: join(root, 'absent.json'), dir })).toBeNull()
  })
})
