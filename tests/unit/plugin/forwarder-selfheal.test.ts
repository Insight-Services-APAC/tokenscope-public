/*
 * decideForwarderAction — the pure self-heal decision for the OTLP forwarder spawn.
 * The old spawn relied on the port-bind singleton alone, so a bound-but-broken
 * forwarder (a prior run under a leaked HOME resolving a different stateDir/config)
 * kept the port forever and every export silently 502'd. This decision replaces it
 * unless /healthz answers AND reports OUR stateDir.
 *
 * S1 fix 6: /healthz no longer reports a raw `pid` (an unauthenticated local
 * HTTP response is untrusted input; a network-supplied pid used as a SIGTERM
 * target would let anything answering on the port choose what gets killed).
 * `dir` (the absolute path) is likewise replaced by a `dirMatches` boolean the
 * SERVER computes against a caller-supplied `?dir=`. Every kill decision now
 * goes through the PIDFILE (killForwarderPidfile — filesystem-trusted, reads
 * from inside our own 0700 state dir), never a `killPid: <n>` sourced from the
 * response. LEGACY TOLERANCE: a pre-hardening forwarder mid-upgrade still
 * answers with the OLD shape (`{ok,pid,dir,ready}`, no `dirMatches`) — the
 * decision falls back to comparing `dir` directly in that case, so an
 * in-flight upgrade isn't treated as unconditionally stale.
 */
import { describe, it, expect } from 'vitest'
import { decideForwarderAction, forwarderSpawnEnv } from '../../../plugin/hooks/session-start.mjs'

const DIR = '/home/dev/.tokenscope/state'

describe('decideForwarderAction', () => {
  it('nothing listening (refused) → spawn', () => {
    expect(decideForwarderAction('refused', DIR)).toEqual({ action: 'spawn' })
  })

  it('bound but not answering /healthz (hung) → kill the pidfile owner + spawn', () => {
    expect(decideForwarderAction('hung', DIR)).toEqual({ action: 'spawn', killPidfile: true })
  })

  it('answering AND dirMatches AND ready → healthy (leave it running)', () => {
    expect(decideForwarderAction({ ok: true, dirMatches: true, ready: true }, DIR)).toEqual({ action: 'healthy' })
  })

  it('answering AND dirMatches, no ready field (older forwarder) → healthy (backward-compatible)', () => {
    expect(decideForwarderAction({ ok: true, dirMatches: true }, DIR)).toEqual({ action: 'healthy' })
  })

  it('dirMatches but ready:false (stash gone / wiped ~/.tokenscope) → kill the pidfile owner + spawn', () => {
    expect(decideForwarderAction({ ok: true, dirMatches: true, ready: false }, DIR)).toEqual({
      action: 'spawn',
      killPidfile: true,
    })
  })

  it('answering but dirMatches:false (stale / leaked HOME) → kill the pidfile owner + spawn', () => {
    expect(decideForwarderAction({ ok: true, dirMatches: false }, DIR)).toEqual({ action: 'spawn', killPidfile: true })
  })

  it('LEGACY (pre-hardening) shape: dir matches expectedDir directly (no dirMatches field) → healthy', () => {
    expect(decideForwarderAction({ ok: true, pid: 123, dir: DIR, ready: true }, DIR)).toEqual({ action: 'healthy' })
  })

  it('LEGACY shape: dir differs from expectedDir → kill the pidfile owner + spawn (never the response pid)', () => {
    const decision = decideForwarderAction({ ok: true, pid: 456, dir: '/tmp/leaked-home/.tokenscope/state' }, DIR)
    expect(decision).toEqual({ action: 'spawn', killPidfile: true })
    expect(decision).not.toHaveProperty('killPid') // network-supplied pid is NEVER trusted
  })

  it('a malformed-but-ok response with neither dirMatches nor a matching legacy dir → still evicts via the pidfile, never a blind network-pid kill', () => {
    const decision = decideForwarderAction({ ok: true, dir: '/elsewhere' }, DIR)
    expect(decision).toEqual({ action: 'spawn', killPidfile: true })
    expect(decision).not.toHaveProperty('killPid')
  })

  it('no `ok:true` at all (garbage / non-object) → best-effort spawn, no kill attempted', () => {
    expect(decideForwarderAction(null, DIR)).toEqual({ action: 'spawn' })
    expect(decideForwarderAction({}, DIR)).toEqual({ action: 'spawn' })
    expect(decideForwarderAction({ ok: false }, DIR)).toEqual({ action: 'spawn' })
  })
})

describe('forwarderSpawnEnv (explicit durable-DCE handoff — never rely on settings-env inheritance)', () => {
  const DCE = 'https://dce-abc.westus3-1.ingest.monitor.azure.com/streams/x'

  it('injects the durable copy from the merged settings env into the spawn env', () => {
    const out = forwarderSpawnEnv({ PATH: '/bin' }, { TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE })
    expect(out.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBe(DCE)
    expect(out.PATH).toBe('/bin') // base env preserved
  })

  it('settings copy WINS over any inherited process-env value (fresh-from-disk is authoritative)', () => {
    const out = forwarderSpawnEnv({ TOKENSCOPE_DCE_LOGS_ENDPOINT: 'https://stale.example/old' }, { TOKENSCOPE_DCE_LOGS_ENDPOINT: DCE })
    expect(out.TOKENSCOPE_DCE_LOGS_ENDPOINT).toBe(DCE)
  })

  it('no durable copy in settings → base env passed through untouched', () => {
    const base = { PATH: '/bin' }
    expect(forwarderSpawnEnv(base, {})).toEqual({ PATH: '/bin' })
    expect(forwarderSpawnEnv(base, { TOKENSCOPE_DCE_LOGS_ENDPOINT: '   ' })).toEqual({ PATH: '/bin' })
  })
})
