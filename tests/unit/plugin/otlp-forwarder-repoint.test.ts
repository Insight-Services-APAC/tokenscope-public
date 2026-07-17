/*
 * applyOtlpProxyRepoint — the shared re-point helper for the local OTLP
 * Content-Length forwarder (CC #72671). Since the fix landed in CLI 2.1.212 the
 * forwarder is version-aware AUTO: it re-points ONLY on a CLI in a known-broken
 * range (otlp-shim-policy OTLP_BROKEN_RANGES) or under a manual =1; on a fixed
 * CLI direct emission is the DEFAULT. Guards:
 *   - fixed/unknown CLI (dormant): a real DCE stays direct + no stash written
 *   - dormant + endpoint already at the proxy (stash present) → RESTORE the DCE
 *   - AUTO on a broken CLI (no flag): a real DCE → re-pointed + stash
 *   - re-activated (=1): a real DCE → re-pointed at the local proxy + stash
 *   - re-activated (=1) + already-localhost → no-op, stash NOT overwritten
 *
 * TOKENSCOPE_STATE_DIR is read fresh by stateDir() per call, so it can be set in
 * beforeEach; the module is imported once (its default proxy port 14318 is fine).
 * The version-detect env (CLAUDE_CODE_EXECPATH/AI_AGENT) is neutralized per test
 * so the host CLI's real version can't leak into AUTO — each test sets it.
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

const BROKEN_EXECPATH = '/home/x/.local/share/claude/versions/2.1.205' // in the #72671 range
const FIXED_EXECPATH = '/home/x/.local/share/claude/versions/2.1.212' // fixed

let dir = ''
let stash = ''
let savedExecPath: string | undefined
let savedAiAgent: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts-otlp-repoint-'))
  process.env.TOKENSCOPE_STATE_DIR = dir
  stash = join(dir, 'otlp-forward.json')
  delete process.env.TOKENSCOPE_OTLP_PROXY
  // Neutralize the host CLI's version signal so AUTO defaults to dormant unless a
  // test opts into a specific version.
  savedExecPath = process.env.CLAUDE_CODE_EXECPATH
  savedAiAgent = process.env.AI_AGENT
  delete process.env.CLAUDE_CODE_EXECPATH
  delete process.env.AI_AGENT
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.TOKENSCOPE_STATE_DIR
  delete process.env.TOKENSCOPE_OTLP_PROXY
  if (savedExecPath === undefined) delete process.env.CLAUDE_CODE_EXECPATH
  else process.env.CLAUDE_CODE_EXECPATH = savedExecPath
  if (savedAiAgent === undefined) delete process.env.AI_AGENT
  else process.env.AI_AGENT = savedAiAgent
})

describe('applyOtlpProxyRepoint', () => {
  it('DORMANT by default: a real DCE stays direct, no stash written', () => {
    // Retirement default (CC #72671 fixed in 2.1.212): no flag → do NOT re-point.
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    const out = applyOtlpProxyRepoint(env)
    expect(out).toBe(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // untouched — direct emission
    expect(existsSync(stash)).toBe(false)
  })

  it('DORMANT + endpoint left at the proxy (stash present) → RESTORES the direct DCE', () => {
    // Auto-revert: a user whose prior session repointed to the forwarder gets
    // moved back to direct emission on the next session, no re-redeem needed.
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // restored to direct
    expect(existsSync(stash)).toBe(true) // stash kept for a possible re-activation
  })

  it('DORMANT + at proxy but NO stash → leaves the proxy endpoint (nothing to restore to)', () => {
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
  })

  it('DORMANT + at proxy + stash, but revertWhenDormant=false → LEAVES the proxy (shared-host guard)', () => {
    // A live forwarder is serving a broken-CLI sibling; the caller suppresses the
    // revert so we do not drop the sibling's telemetry.
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env, { revertWhenDormant: false })
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // NOT reverted
  })

  it('AUTO on a broken CLI (2.1.205, no flag): re-points a real DCE at the proxy + stashes it', () => {
    // Version-aware self-heal: a user on an affected CLI is fixed with NO action.
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('AUTO on a fixed CLI (2.1.212, no flag): a real DCE stays direct, no stash', () => {
    process.env.CLAUDE_CODE_EXECPATH = FIXED_EXECPATH
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE)
    expect(existsSync(stash)).toBe(false)
  })

  it('FORCED OFF (=0) overrides a broken CLI: stays direct', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '0'
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE)
    expect(existsSync(stash)).toBe(false)
  })

  it('RE-ACTIVATED (=1): re-points a real DCE at the proxy and stashes the DCE URL', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    const out = applyOtlpProxyRepoint(env)
    expect(out).toBe(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(existsSync(stash)).toBe(true)
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('RE-ACTIVATED (=1) + already the local proxy → no-op, stash NOT overwritten', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('is a no-op when there is no logs endpoint (fresh/partial enrolment)', () => {
    const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1' }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBeUndefined()
    expect(existsSync(stash)).toBe(false)
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
