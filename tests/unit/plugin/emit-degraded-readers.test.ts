/*
 * Every reader of emission health must say "degraded", not "OK", while the
 * helper is handing back its CACHED Azure bearer (#409).
 *
 * The helper exits 0 on that path (Claude Code must get a header), and before
 * this change every reader took exit 0 as proof of a verified credential:
 * `/tokenscope:status` printed "This proves the credential is VALID", the status
 * line showed green, and the SessionStart hook said nothing — indefinitely, even
 * when the helper itself knew the cached bearer had expired. These tests pin
 * the four readers (Claude status, Copilot status, status line, session-start
 * notice) and the shared expiry phrase.
 */
import { describe, it, expect } from 'vitest'
import { interpretEmissionProbe as claudeProbe } from '../../../plugin/scripts/status.mjs'
import { interpretEmissionProbe as copilotProbe } from '../../../copilot-plugin/scripts/status.mjs'
import { formatStatusLine } from '../../../plugin/scripts/statusline.mjs'
import { degradedNotice } from '../../../plugin/hooks/session-start.mjs'
import { degradedExpiryNote, emitDegradedName } from '../../../plugin/scripts/plugin-runtime.mjs'

// Absolute epochs, far past / far future: the probe readers use the REAL clock
// (no `now` seam), so the fixtures must read the same on any machine, any year.
const NOW = 1_800_000_000
const valid = { ts: '2026-10-07T00:00:00Z', reason: 'could not reach https://ts.example/bearer', expires_at: 9_999_999_999 }
const expired = { ...valid, expires_at: 1_000_000_000 }
const unknown = { ...valid, expires_at: 0 }

describe('degradedExpiryNote — one phrase for every reader', () => {
  it('valid / expired / unknown', () => {
    expect(degradedExpiryNote(valid, NOW)).toMatch(/valid until 2286-/)
    expect(degradedExpiryNote(expired, NOW)).toMatch(/EXPIRED at .* — exports are probably being refused/)
    expect(degradedExpiryNote(unknown, NOW)).toBe('cached bearer expiry unknown')
    expect(degradedExpiryNote(null, NOW)).toBe('cached bearer expiry unknown')
  })
  it('the marker file name is per tool, like the sentinel', () => {
    expect(emitDegradedName('claude-code')).toBe('emit-degraded.claude-code.json')
    expect(emitDegradedName('copilot-cli')).toBe('emit-degraded.copilot-cli.json')
  })
})

describe.each([
  ['Claude', claudeProbe],
  ['Copilot', copilotProbe],
])('%s interpretEmissionProbe — exit 0 on the cached bearer is DEGRADED, never "OK"', (_name, probe) => {
  it('reports degraded with the reason and the expiry, and does NOT claim the credential is valid', () => {
    const v = probe({ status: 0, stdoutHasAuth: true, sentinel: null, degraded: valid })
    expect(v.emitting).toBe(true)
    expect(v.degraded).toBe(true)
    expect(v.message).toMatch(/DEGRADED/)
    expect(v.message).toMatch(/could not reach/)
    expect(v.message).toMatch(/NOT verified/)
    expect(v.message).not.toMatch(/VALID/)
  })
  it('an expired cache says exports are probably being refused', () => {
    const v = probe({ status: 0, stdoutHasAuth: true, sentinel: null, degraded: expired })
    expect(v.message).toMatch(/EXPIRED/)
  })
  it('no marker → the existing OK verdict is unchanged', () => {
    const v = probe({ status: 0, stdoutHasAuth: true, sentinel: null })
    expect(v.emitting).toBe(true)
    expect(v.degraded).toBeUndefined()
    expect(v.message).toMatch(/^OK: this computer can send usage to TokenScope\./)
  })
})

describe.each([
  ['Claude', claudeProbe, '/tokenscope:setup'],
  ['Copilot', copilotProbe, 'the tokenscope-setup skill'],
])('%s interpretEmissionProbe — verdict first, plain words, one next step (#418)', (_name, probe, setup) => {
  const branches = [
    { status: 0, stdoutHasAuth: true, sentinel: null },
    { status: 0, stdoutHasAuth: false, sentinel: null },
    { status: 1, stdoutHasAuth: false, sentinel: { http_status: 401, message: 'revoked' } },
    { status: 1, stdoutHasAuth: false, sentinel: { http_status: 0, message: 'unreachable' } },
    { status: 1, stdoutHasAuth: false, sentinel: null },
    { status: 1, stdoutHasAuth: false, sentinel: { http_status: 503, message: 'upstream' } },
  ]
  it.each(branches)('%o', (input) => {
    const { message } = probe(input)
    expect(message).toMatch(/^(OK|ERROR|NOT SENDING|UNVERIFIED): /)
    expect(message).not.toMatch(/\b(bearer|OTel|provision|emit|Azure|headers helper)\b/i)
  })
  it('a revoked credential sends the reader to setup', () => {
    const { message } = probe({ status: 1, stdoutHasAuth: false, sentinel: { http_status: 401, message: 'revoked' } })
    expect(message).toContain(`Run ${setup} to reconnect this computer.`)
  })
})

describe('formatStatusLine — degraded is amber, before landing', () => {
  const base = { configured: true, emitting: true, mcpAuthed: true, color: false }
  it('shows ⚠ emit-auth degraded', () => {
    expect(formatStatusLine({ ...base, degraded: true, landing: 'landed', sessionId: '65d2c64f-0545' })).toBe(
      'TokenScope ⚠ emit-auth degraded #65d2c64f',
    )
  })
  it('a failing sentinel still outranks degraded (red first)', () => {
    expect(formatStatusLine({ ...base, emitting: false, degraded: true, sessionId: 'abc' })).toMatch(/✗ emit-auth failing/)
  })
  it('without the flag the line is unchanged', () => {
    expect(formatStatusLine({ ...base, landing: 'landed', sessionId: '65d2c64f-0545' })).toBe('TokenScope ✓ landed #65d2c64f')
  })
})

describe('session-start degradedNotice', () => {
  it('informational while the cached bearer is still valid', () => {
    const n = degradedNotice(valid, NOW)
    expect(n).toMatch(/^ℹ TokenScope: TokenScope is unreachable/)
    expect(n).toMatch(/valid until/)
  })
  it('a warning once the cached bearer is known to be expired', () => {
    const n = degradedNotice(expired, NOW)
    expect(n).toMatch(/^⚠ TokenScope/)
    expect(n).toMatch(/probably NOT being accepted/)
  })
})
