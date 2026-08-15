/**
 * copilot-forwarder — lifecycle unit tests (R3 heartbeat singleton + R4 rollback).
 *
 * R3: isAlreadyRunning() decides liveness by HEARTBEAT FRESHNESS, not process.kill —
 *     a stale PID record (a dead daemon) is detected even across container PID
 *     namespaces (process.kill on a reused PID in another namespace false-positives).
 * R4: readAndForward() rolls back the byte offset on a forward FAILURE so the batch
 *     is re-read and retried (dedup-absorbed) rather than silently dropped.
 *
 * PID_FILE + OFFSET_FILE are resolved at module load, so the env overrides MUST be
 * set BEFORE the dynamic import. No network, no Azure, no daemon spawn (the forward
 * function is injected).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'ts-fwd-life-'))
const pidFile = join(dir, 'copilot-forwarder.pid')
const offsetFile = join(dir, 'forwarder-offset')
process.env.TOKENSCOPE_FWD_PID_FILE = pidFile
process.env.TOKENSCOPE_FWD_OFFSET_FILE = offsetFile
process.env.TOKENSCOPE_FORWARD_INTERVAL_MS = '1000' // → HEARTBEAT_STALE_MS = 150s floor

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const {
  isAlreadyRunning, claimSingleton, writeHeartbeat, readPidRecord,
  readNewSpans, readAndForward, postWithRetry, _resetStateForTest,
  resolveProjectCodeHash, extractCodeHash,
} = await import('../../../plugin/scripts/copilot-forwarder.mjs')

const chatLine = (spanId: string) =>
  JSON.stringify({
    type: 'span', name: 'chat m', spanId, endTime: [1780825137, 0],
    attributes: {
      'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm',
      'gen_ai.conversation.id': 'c', 'gen_ai.usage.input_tokens': 10,
    },
  }) + '\n'

beforeEach(() => {
  _resetStateForTest()
  for (const f of [pidFile, offsetFile]) if (existsSync(f)) rmSync(f)
})
afterEach(() => {
  for (const f of [pidFile, offsetFile]) if (existsSync(f)) rmSync(f)
})

describe('R3 — heartbeat-freshness singleton guard', () => {
  it('no PID file → not running', () => {
    expect(isAlreadyRunning()).toBe(false)
  })

  it('fresh heartbeat → running (yield) regardless of whether the pid exists here', () => {
    writeFileSync(pidFile, JSON.stringify({ pid: 999999, startedAt: Date.now(), heartbeatAt: Date.now() }))
    expect(isAlreadyRunning()).toBe(true)
  })

  it('STALE heartbeat (dead daemon) → not running + record reaped (cross-namespace safe)', () => {
    writeFileSync(pidFile, JSON.stringify({ pid: 999999, startedAt: 0, heartbeatAt: Date.now() - 200_000 }))
    expect(isAlreadyRunning()).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
  })

  it('corrupt / legacy plain-pid record → treated as stale (reaped)', () => {
    writeFileSync(pidFile, '12345')
    expect(isAlreadyRunning()).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
  })

  it('claimSingleton writes a fresh record; writeHeartbeat refreshes it (keeps startedAt)', () => {
    const startedAt = claimSingleton()
    const rec1 = readPidRecord()
    expect(rec1.pid).toBe(process.pid)
    expect(rec1.startedAt).toBe(startedAt)
    expect(isAlreadyRunning()).toBe(true)
    const before = readPidRecord().heartbeatAt
    writeHeartbeat(startedAt)
    const after = readPidRecord()
    expect(after.startedAt).toBe(startedAt)
    expect(after.heartbeatAt).toBeGreaterThanOrEqual(before)
  })
})

describe('R4 — readAndForward rolls back the offset on forward failure', () => {
  it('forward FAILURE → offset rolls back so the SAME spans re-read next pass', async () => {
    const spanFile = join(dir, 'spans.ndjson')
    writeFileSync(spanFile, chatLine('s1') + chatLine('s2'))
    _resetStateForTest()

    let calls = 0
    const failing = async () => { calls++; throw new Error('HTTP 503') }
    expect(await readAndForward(spanFile, 'test', failing)).toBe(0)
    expect(calls).toBe(1)

    // Rolled back → a fresh read returns the SAME spans (the batch is retried, not lost).
    expect(readNewSpans(spanFile)).toHaveLength(2)
  })

  it('forward SUCCESS → offset commits so spans are NOT re-read', async () => {
    const spanFile = join(dir, 'spans2.ndjson')
    writeFileSync(spanFile, chatLine('s1') + chatLine('s2'))
    _resetStateForTest()

    const ok = async (spans: unknown[]) => spans.length
    expect(await readAndForward(spanFile, 'test', ok)).toBe(2)
    expect(readNewSpans(spanFile)).toHaveLength(0)
  })
})

describe('postWithRetry — re-mints the bearer once on 401/403', () => {
  it('2xx first try → single post, no force-remint', async () => {
    const auths: string[] = []
    const mint = (force: boolean) => (force ? 'FRESH' : 'STALE')
    const post = async (_u: string, h: { authorization: string }) => {
      auths.push(h.authorization)
      return { status: 204, body: '' }
    }
    const res = await postWithRetry('https://x', Buffer.from('p'), mint, post)
    expect(res.status).toBe(204)
    expect(auths).toEqual(['STALE']) // no retry
  })

  it('401 then 204 → retries with a FORCE-minted bearer', async () => {
    const auths: string[] = []
    const mintArgs: boolean[] = []
    const mint = (force: boolean) => { mintArgs.push(force); return force ? 'FRESH' : 'STALE' }
    let call = 0
    const post = async (_u: string, h: { authorization: string }) => {
      auths.push(h.authorization)
      return { status: call++ === 0 ? 401 : 204, body: '' }
    }
    const res = await postWithRetry('https://x', Buffer.from('p'), mint, post)
    expect(res.status).toBe(204)
    expect(auths).toEqual(['STALE', 'FRESH'])
    expect(mintArgs).toEqual([false, true])
  })

  it('401 twice → returns the second response, retries exactly once (no loop)', async () => {
    const mint = (force: boolean) => (force ? 'FRESH' : 'STALE')
    let call = 0
    const post = async () => { call++; return { status: 401, body: 'denied' } }
    const res = await postWithRetry('https://x', Buffer.from('p'), mint, post)
    expect(res.status).toBe(401)
    expect(call).toBe(2)
  })
})

// The project hash is derived from the committed `.tokenscope` in the daemon's cwd
// (= the project root) via the SHARED resolver (so Copilot + Claude hash identically),
// NOT from cfg.otel_resource_attributes. extractCodeHash stays exported (legacy parser)
// but is no longer the source of the tag. Per-project cwd-resolution (no cross-repo
// guard) + org stamp behaviour are tested in copilot-forwarder-tagging.test.ts; here we
// pin the legacy parser still behaves (it underpins nothing now but stays exported).
describe('extractCodeHash — legacy OTEL_RESOURCE_ATTRIBUTES CSV parser', () => {
  it('parses the hash and tolerates junk', () => {
    expect(extractCodeHash('a=1,project.code_hash=abc123,tool=copilot-cli')).toBe('abc123')
    expect(extractCodeHash('no hash here')).toBeNull()
    expect(extractCodeHash('')).toBeNull()
    expect(extractCodeHash(null)).toBeNull()
  })

  it('resolveProjectCodeHash NO LONGER reads cfg.otel_resource_attributes', () => {
    // Even with a hash in config, the result is driven by the cwd .tokenscope, not
    // the config string. With no .tokenscope above the temp cwd, it is untagged.
    const cfg = {
      otel_resource_attributes:
        'tokenscope.instance_id=21d0,project.code_hash=fa9f0ef4dee046725cca9bffcfa34eb3eeabbdf769c0fc1f90931606cb2851c8,tool=copilot-cli',
    }
    const orphan = mkdtempSync(join(tmpdir(), 'ts-fwd-orphan-'))
    expect(resolveProjectCodeHash(cfg, { cwd: orphan })).toBeNull()
    rmSync(orphan, { recursive: true, force: true })
  })
})

// Unprovisioned-host behaviour is about the process EXIT CODE (the Stop hook runs
// the script synchronously and propagates it), so it is tested by spawning the
// script as a child pointed at a config-less state dir — not via an in-process
// import (main() is not exported and calls process.exit).
//
// The sandbox seam is TOKENSCOPE_STATE_DIR, NOT `HOME`. It used to be `HOME`, which
// worked only because the forwarder resolved its credential store through
// `os.homedir()` — the very split this suite's sibling (copilot-state-dir.test.ts)
// exists to close. The store is anchored on the PASSWD home now, so a `HOME` override
// no longer moves it: a HOME-based sandbox would read the developer's own live
// ~/.tokenscope, and this test's outcome would depend on whether the machine running
// it happens to be enrolled. TOKENSCOPE_STATE_DIR is the supported process-level pin
// (same seam tag-repo-selfheal.test.ts uses on the Claude side).
describe('unprovisioned host → graceful no-op exit 0 (Stop hook must not fail)', () => {
  // Vitest runs from the repo root; resolve the script from cwd (import.meta.url
  // is not a file: URL under the test runner, so fileURLToPath on it throws).
  const scriptPath = join(process.cwd(), 'plugin/scripts/copilot-forwarder.mjs')

  function runWithoutConfig(mode: 'start' | 'stop') {
    const stateDir = mkdtempSync(join(tmpdir(), 'ts-fwd-noconfig-')) // holds no config.json
    try {
      const result = spawnSync(process.execPath, [scriptPath, mode], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, TOKENSCOPE_STATE_DIR: stateDir },
      })
      return { result, stateDir }
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }

  it('stop → exits 0 with a "not provisioned" notice (was exit 1)', () => {
    const { result: r, stateDir } = runWithoutConfig('stop')
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('not provisioned')
    // The notice names the path it looked at, so this also proves the SANDBOX held:
    // the child resolved the pinned dir, not the developer's own ~/.tokenscope. A
    // bare "not provisioned" assertion would pass on an unenrolled machine even if
    // the pin were ignored entirely.
    expect(r.stderr).toContain(join(stateDir, 'config.json'))
  })

  it('start → exits 0 and does not hang (guard fires before claiming the singleton)', () => {
    const { result: r, stateDir } = runWithoutConfig('start')
    expect(r.status).toBe(0)
    expect(r.signal).toBeNull() // not killed by the 10s timeout
    expect(r.stderr).toContain('not provisioned')
    expect(r.stderr).toContain(join(stateDir, 'config.json'))
  })
})
