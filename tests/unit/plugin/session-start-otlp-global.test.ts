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

const BROKEN_EXECPATH = '/home/x/.local/share/claude/versions/2.1.205' // in the #72671 range

let dir = ''
let settingsPath = ''
let stateDir = ''
let savedExecPath: string | undefined
let savedAiAgent: string | undefined

function writeSettings(endpoint: string | null, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { CLAUDE_CODE_ENABLE_TELEMETRY: '1', TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'super-secret', ...extraEnv }
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
  // Neutralize the host CLI's version so AUTO defaults to dormant unless opted in.
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

describe('selfHealGlobalOtlpEndpoint', () => {
  it('DORMANT by default: leaves a real DCE endpoint direct (no re-point, no write)', async () => {
    // Retirement default (CC #72671 fixed in 2.1.212) — the global stays direct.
    writeSettings(DCE)
    const rawBefore = readFileSync(settingsPath, 'utf8')
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(rawBefore) // untouched
  })

  it('AUTO on a broken CLI (2.1.205, no flag): re-points a real DCE to the proxy', async () => {
    // A user on an affected CLI is self-healed onto the forwarder with no action.
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    writeSettings(DCE)
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(JSON.parse(readFileSync(join(stateDir, 'otlp-forward.json'), 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('RE-ACTIVATED (=1): re-points a real DCE to the proxy, preserving the credential + other keys', async () => {
    process.env.TOKENSCOPE_OTLP_PROXY = '1'
    writeSettings(DCE)
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret') // credential survives
    expect(out.permissions).toEqual({ allow: ['Bash'] }) // top-level keys survive
    // The stash the forwarder reads was written with the real DCE.
    expect(JSON.parse(readFileSync(join(stateDir, 'otlp-forward.json'), 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('does NOT write when the endpoint is already the proxy (idempotent — no churn)', async () => {
    writeSettings(PROXY)
    const mtimeBefore = statSync(settingsPath).mtimeMs
    // Second-resolution mtime on some filesystems — force a detectable gap by
    // asserting the CONTENT is byte-identical (the real "did we write?" signal).
    const rawBefore = readFileSync(settingsPath, 'utf8')
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: 'refused' })
    const rawAfter = readFileSync(settingsPath, 'utf8')
    expect(rawAfter).toBe(rawBefore) // untouched — no churn (no stash → nothing to revert to)
    // mtime is also unchanged (best-effort corroboration).
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore)
  })

  it('is a no-op when the endpoint is absent (not enrolled)', async () => {
    writeSettings(null)
    const rawBefore = readFileSync(settingsPath, 'utf8')
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(rawBefore)
  })

  it('NEVER clobbers an unparseable settings.json (would wipe the credential)', async () => {
    const garbage = '{ not valid json, secret: TOKEN '
    writeFileSync(settingsPath, garbage)
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(garbage) // byte-for-byte untouched
  })

  it('AUTO-REVERTS a still-proxied global back to the direct DCE when the forwarder is GONE', async () => {
    // Prior state: an existing user's global is at the proxy (from before the
    // retirement), stash holds the real DCE, forwarder refused (not running) →
    // safe to restore direct emission.
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: 'refused' })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // reverted to direct
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret')
  })

  it('reverts a still-proxied global when the forwarder is HUNG (bound but not serving → no strand)', async () => {
    // A wedged forwarder serves nobody; once the fleet is all fixed-CLI nothing
    // respawns it, so it must NOT keep the endpoint pinned to a dead proxy.
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: 'hung' })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // reverted to direct
  })

  it('shared-host guard: does NOT revert while the forwarder is STILL SERVING (a sibling needs it)', async () => {
    // Same prior state, but the forwarder is healthy AND resolves OUR stateDir — a
    // broken-CLI sibling on this shared home is depending on it. Reverting would
    // silently drop the sibling's telemetry, so the proxy endpoint is LEFT in place.
    writeSettings(PROXY)
    const rawBefore = readFileSync(settingsPath, 'utf8')
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: { ok: true, dir: stateDir } })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // left on the proxy
    expect(readFileSync(settingsPath, 'utf8')).toBe(rawBefore) // no churn either
  })

  it('reverts when a forwarder answers our dir but reports ready:false (stash wiped → cannot forward)', async () => {
    // dir matches but the forwarder can't resolve its DCE stash — it would drop.
    // decideForwarderAction rejects ready:false, so selfHeal must revert to direct.
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: { ok: true, dir: stateDir, ready: false } })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // reverted — not truly serving
  })

  it('reverts when a forwarder answers but resolved a DIFFERENT stateDir (stale/leaked-HOME instance)', async () => {
    // A forwarder answering /healthz with a mismatched dir is a stale/leaked-HOME
    // relay pointed at the wrong DCE — the recurring silent-drop. On a fixed-CLI
    // fleet spawnOtlpForwarder never runs to kill it, so this guard MUST NOT trust
    // it: treat it as unhealthy and revert to direct emission.
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: { ok: true, dir: '/some/other/leaked/dir' } })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // reverted — do not trust a stale relay
  })

  // ── Durable revert key (the 2026-07-24 cold-start wedge, hook level) ─────────

  it('THE COLD-START WEDGE: pinned global + durable copy + NO stash + forwarder gone → reverts to the DCE', async () => {
    // The incident replay end-to-end: persistent settings survived a container
    // rebuild pinned to the proxy; the ephemeral stash did not. With the durable
    // copy in the SAME file, the session heals itself — no manual re-provision.
    writeSettings(PROXY, { TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE })
    await selfHealGlobalOtlpEndpoint({ settingsPath, forwarderProbe: 'refused' })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(DCE) // recovered
    expect(out.env.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBeUndefined() // copy retired with the pin
    expect(out.env.TOKENSCOPE_OAUTH_REFRESH_TOKEN).toBe('super-secret') // credential survives
    expect(out.permissions).toEqual({ allow: ['Bash'] }) // top-level keys survive
  })

  it('BACKFILLS the durable copy for a legacy pin on a broken CLI (endpoint unchanged, env still written)', async () => {
    // A pin made before 0.1.26 has only the stash. While that stash is still
    // alive, the reconcile copies it into settings — closing the durability gap
    // BEFORE the ephemeral state dir is next wiped. This exercises the whole-env
    // change detection: the ENDPOINT does not change, only the new env key.
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    writeSettings(PROXY)
    writeFileSync(join(stateDir, 'otlp-forward.json'), JSON.stringify({ dceLogsEndpoint: DCE }))
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY) // still pinned — shim needed
    expect(out.env.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBe(DCE) // durability gained
  })

  it('AUTO pin on a broken CLI records the durable copy alongside the stash', async () => {
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    writeSettings(DCE)
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    const out = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(out.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe(PROXY)
    expect(out.env.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBe(DCE)
    expect(JSON.parse(readFileSync(join(stateDir, 'otlp-forward.json'), 'utf8')).dceLogsEndpoint).toBe(DCE)
  })

  it('RE-MATERIALIZES a wiped stash from the durable copy on a broken CLI (no settings churn)', async () => {
    // Pinned + durable copy present + stash gone + shim active: the forwarder needs
    // its stash file back. The settings file itself has nothing to change, so it
    // must stay byte-identical (no churn) while the stash reappears on disk.
    process.env.CLAUDE_CODE_EXECPATH = BROKEN_EXECPATH
    writeSettings(PROXY, { TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE })
    const rawBefore = readFileSync(settingsPath, 'utf8')
    await selfHealGlobalOtlpEndpoint({ settingsPath })
    expect(readFileSync(settingsPath, 'utf8')).toBe(rawBefore) // untouched
    expect(JSON.parse(readFileSync(join(stateDir, 'otlp-forward.json'), 'utf8')).dceLogsEndpoint).toBe(DCE)
  })
})
