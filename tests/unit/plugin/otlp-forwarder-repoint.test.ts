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
const { applyOtlpProxyRepoint, otlpProxyStashMissing, OTLP_DCE_ENV_KEY } = await import('../../../plugin/scripts/env-builder.mjs')

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
    // The pin records the revert key in BOTH persistence domains: the stash (above,
    // for the forwarder) AND the env block itself (survives an ephemeral state dir).
    expect(env[OTLP_DCE_ENV_KEY]).toBe(DCE)
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

  // ── Durable revert key (the 2026-07-24 cold-start wedge) ──────────────────────
  // A pin lives in the PERSISTENT settings.json; the stash can live in an
  // EPHEMERAL state dir (container-local ~/.tokenscope under a bind-mounted
  // ~/.claude). Lose the stash to a container rebuild and the revert had nothing
  // to restore — the env copy (OTLP_DCE_ENV_KEY) closes exactly that gap.

  it('THE WEDGE: dormant + at proxy + NO stash, but durable env copy → restores the DCE from settings', () => {
    // The cold-start incident replay: pinned settings survived 3 weeks + a
    // container rebuild, the stash did not. The durable copy makes it recoverable.
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, [OTLP_DCE_ENV_KEY]: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // recovered — no re-provision needed
    expect(env[OTLP_DCE_ENV_KEY]).toBeUndefined() // the endpoint itself is the durable copy again
  })

  it('dormant restore PREFERS the durable copy over the stash and removes it', () => {
    const OTHER = 'https://dce-other.westus3-1.ingest.monitor.azure.com/streams/x'
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: OTHER }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, [OTLP_DCE_ENV_KEY]: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // env copy wins (shares the settings file's fate)
    expect(env[OTLP_DCE_ENV_KEY]).toBeUndefined()
  })

  it('dormant + at proxy + durable copy + revertWhenDormant=false → NOT reverted (sibling guard still wins)', () => {
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, [OTLP_DCE_ENV_KEY]: DCE }
    applyOtlpProxyRepoint(env, { revertWhenDormant: false })
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // a healthy forwarder is serving a sibling
    expect(env[OTLP_DCE_ENV_KEY]).toBe(DCE) // copy kept — the revert may still be needed later
  })

  it('dormant + DIRECT endpoint + leftover durable copy → copy removed (would go stale)', () => {
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE, [OTLP_DCE_ENV_KEY]: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE)
    expect(env[OTLP_DCE_ENV_KEY]).toBeUndefined()
  })

  it('ACTIVE (=1) + at proxy + durable copy + stash LOST → re-materializes the stash for the forwarder', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, [OTLP_DCE_ENV_KEY]: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // stays pinned — the shim is needed
    expect(env[OTLP_DCE_ENV_KEY]).toBe(DCE) // copy kept while pinned
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE) // stash restored
  })

  it('ACTIVE (=1) + at proxy + live stash + NO durable copy → backfills the copy (upgrades a legacy pin)', () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    mkdirSync(dir, { recursive: true })
    writeFileSync(stash, JSON.stringify({ dceLogsEndpoint: DCE }))
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY }
    applyOtlpProxyRepoint(env)
    expect(env[OTLP_DCE_ENV_KEY]).toBe(DCE) // durability gained BEFORE the state dir is next wiped
    expect(JSON.parse(readFileSync(stash, 'utf8')).dceLogsEndpoint).toBe(DCE) // stash untouched
  })

  it('PIN survives an UNWRITABLE state dir: env copy + repoint land, stash write is best-effort', () => {
    // Aborting the pin would leave a broken CLI emitting DIRECT chunked exports
    // (silently dropped) — strictly worse than a pin served from the env copy
    // alone (the forwarder gets it via its spawn env).
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    const notADir = join(dir, 'file-not-a-dir')
    writeFileSync(notADir, 'x')
    process.env.TOKENSCOPE_STATE_DIR = join(notADir, 'nested') // mkdir under a file → throws
    const env: Record<string, string> = { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: DCE }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // pinned regardless
    expect(env[OTLP_DCE_ENV_KEY]).toBe(DCE) // the durable copy alone carries the revert key
  })

  it('a LOOPBACK durable copy is ignored — never "restores" the endpoint to another loopback', () => {
    const env: Record<string, string> = {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY,
      [OTLP_DCE_ENV_KEY]: 'http://127.0.0.1:9999/v1/logs',
    }
    applyOtlpProxyRepoint(env)
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // unusable copy → nothing to restore
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

  it('is FALSE when the stash is gone but the DURABLE env copy is present (self-heals — no warn)', () => {
    expect(otlpProxyStashMissing({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY, [OTLP_DCE_ENV_KEY]: DCE })).toBe(false)
  })

  it('is TRUE when the durable copy is unusable (loopback) and the stash is gone', () => {
    expect(
      otlpProxyStashMissing({
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: PROXY,
        [OTLP_DCE_ENV_KEY]: 'http://127.0.0.1:9999/v1/logs',
      }),
    ).toBe(true)
  })
})
