/*
 * decideForwarderAction — the pure self-heal decision for the OTLP forwarder spawn.
 * The old spawn relied on the port-bind singleton alone, so a bound-but-broken
 * forwarder (a prior run under a leaked HOME resolving a different stateDir/config)
 * kept the port forever and every export silently 502'd. This decision replaces it
 * unless /healthz answers AND reports OUR stateDir.
 */
import { describe, it, expect } from 'vitest'
import { decideForwarderAction } from '../../../plugin/hooks/session-start.mjs'

const DIR = '/home/dev/.tokenscope/state'

describe('decideForwarderAction', () => {
  it('nothing listening (refused) → spawn', () => {
    expect(decideForwarderAction('refused', DIR)).toEqual({ action: 'spawn' })
  })

  it('bound but not answering /healthz (hung) → kill the pidfile owner + spawn', () => {
    expect(decideForwarderAction('hung', DIR)).toEqual({ action: 'spawn', killPidfile: true })
  })

  it('answering AND our stateDir → healthy (leave it running)', () => {
    expect(decideForwarderAction({ ok: true, pid: 123, dir: DIR }, DIR)).toEqual({ action: 'healthy' })
  })

  it('answering but a DIFFERENT stateDir (stale / leaked HOME) → kill its pid + spawn', () => {
    expect(
      decideForwarderAction({ ok: true, pid: 456, dir: '/tmp/leaked-home/.tokenscope/state' }, DIR),
    ).toEqual({ action: 'spawn', killPid: 456 })
  })

  it('a malformed response → best-effort spawn, never a blind kill', () => {
    expect(decideForwarderAction({ ok: true, dir: '/elsewhere' }, DIR)).toEqual({ action: 'spawn' }) // no pid to target
    expect(decideForwarderAction(null, DIR)).toEqual({ action: 'spawn' })
  })
})
