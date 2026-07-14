/*
 * applyOtlpProxyRepoint — the shared re-point helper for the local OTLP
 * Content-Length forwarder (CC #72671 workaround). Guards:
 *   - a real DCE endpoint → re-pointed at the local proxy + stash file written
 *   - an already-localhost endpoint → no-op, and the stash is NOT overwritten
 *   - TOKENSCOPE_OTLP_PROXY=0 (kill-switch) → env unchanged, no stash written
 *
 * TOKENSCOPE_STATE_DIR is read fresh by stateDir() per call, so it can be set in
 * beforeEach; the module is imported once (its default proxy port 14318 is fine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { applyOtlpProxyRepoint, otlpProxyStashMissing } = await import('../../../plugin/scripts/env-builder.mjs')

const PROXY = 'http://127.0.0.1:14318/v1/logs'
const DCE = 'https://dce-abc.westus3-1.ingest.monitor.azure.com/dataCollectionRules/dcr-x/streams/Custom-Logs?api-version=2023-01-01'

let dir = ''
let stash = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-otlp-repoint-'))
  process.env.TOKENSCOPE_STATE_DIR = dir
  stash = join(dir, 'otlp-forward.json')
  delete process.env.TOKENSCOPE_OTLP_PROXY
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.TOKENSCOPE_STATE_DIR
  delete process.env.TOKENSCOPE_OTLP_PROXY
})

describe('applyOtlpProxyRepoint', () => {
  it('re-points a real DCE endpoint at the proxy and stashes the DCE URL', () => {
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    const out = applyOtlpProxyRepoint(env)
    expect(out).toBe(env) // mutates + returns the same object
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(existsSync(stash)).toBe(true)
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('is a no-op when the endpoint is already the local proxy (stash NOT overwritten)', () => {
    // A pre-existing stash from a prior real-DCE re-point must survive.
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // unchanged
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE) // NOT clobbered
  })

  it('is a no-op when there is no logs endpoint (fresh/partial enrolment)', () => {
    const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1' }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
    expect(existsSync(stash)).toBe(false)
  })

  it('leaves a real-DCE env unchanged and writes no stash when the kill-switch is set', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '0'
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // real DCE untouched
    expect(existsSync(stash)).toBe(false)
  })

  it('RESTORES the endpoint to the stashed DCE when the kill-switch is set and env is the proxy', () => {
    // Reverse direction: TOKENSCOPE_OTLP_PROXY=0 + env currently at the proxy +
    // a stash present → revert to the direct DCE (no re-redeem needed). The stash
    // file is KEPT so re-enabling later doesn't need one either.
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    process.env.TOKENSCOPE_OTLP_PROXY = '0'
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // restored to direct
    expect(existsSync(stash)).toBe(true) // stash kept
  })

  it('kill-switch + proxy endpoint but NO stash → leaves the proxy endpoint (nothing to restore to)', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '0'
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // no stash → cannot restore
  })
})

describe('otlpProxyStashMissing (fail-loud guard for the pinned-but-stash-lost wedge)', () => {
  it('is TRUE when the endpoint is the proxy but the stash is absent (the silent-wedge state)', () => {
    // Exactly the kill-switch-no-stash outcome above: pinned to a forwarder that
    // can never resolve a DCE → 502 forever. This is the state session-start warns on.
    expect(otlpProxyStashMissing({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY })).toBe(true)
  })

  it('is FALSE when the endpoint is the proxy AND the stash is present (healthy forwarding)', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    expect(otlpProxyStashMissing({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY })).toBe(false)
  })

  it('is FALSE when the endpoint is a direct DCE (not routed through the forwarder)', () => {
    expect(otlpProxyStashMissing({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE })).toBe(false)
  })

  it('is FALSE when there is no logs endpoint at all (not enrolled)', () => {
    expect(otlpProxyStashMissing({})).toBe(false)
    expect(otlpProxyStashMissing({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '' })).toBe(false)
  })
})
