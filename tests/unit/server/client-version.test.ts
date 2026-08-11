/*
 * Client-asserted version headers — the storage-hygiene boundary.
 *
 * These values come from the device and nothing about them is attested, so the
 * only guarantees worth testing are the ones this module actually makes: what
 * gets stored is short, charset-constrained, and either a plausible version or
 * NULL. In particular a header we cannot make sense of must yield NULL ("never
 * reported"), never a truncated or mangled value — a wrong-looking version in an
 * admin table is worse than an absent one, because an operator will act on it.
 */
import { describe, it, expect } from 'vitest'
import {
  sanitizeClientVersion,
  readClientVersionHeaders,
  MAX_CLIENT_VERSION_LENGTH,
  PLUGIN_VERSION_HEADER,
  CLIENT_VERSION_HEADER,
} from '../../../server/utils/client-version'

describe('sanitizeClientVersion', () => {
  it('accepts the shapes our clients actually report', () => {
    expect(sanitizeClientVersion('0.1.27')).toBe('0.1.27') // plugin
    expect(sanitizeClientVersion('2.1.212')).toBe('2.1.212') // Claude Code CLI
  })

  it('accepts pre-release and build suffixes rather than insisting on bare semver', () => {
    // A version regex tuned to today's shapes would silently blind us to the
    // exact fleet we most want to see the moment a client ships '1.2.3-beta.4'.
    expect(sanitizeClientVersion('1.2.3-beta.4')).toBe('1.2.3-beta.4')
    expect(sanitizeClientVersion('1.2.3+build.77')).toBe('1.2.3+build.77')
    expect(sanitizeClientVersion('v2.1.212')).toBe('v2.1.212')
  })

  it('trims surrounding whitespace (headers routinely carry it)', () => {
    expect(sanitizeClientVersion('  0.1.27  ')).toBe('0.1.27')
  })

  it('returns null for absent / empty / non-string input', () => {
    expect(sanitizeClientVersion(undefined)).toBeNull()
    expect(sanitizeClientVersion(null)).toBeNull()
    expect(sanitizeClientVersion('')).toBeNull()
    expect(sanitizeClientVersion('   ')).toBeNull()
    expect(sanitizeClientVersion(127)).toBeNull()
  })

  it('REJECTS rather than truncates an over-long value', () => {
    // Truncation would store a value that reads as a real (wrong) version.
    const long = '1'.repeat(MAX_CLIENT_VERSION_LENGTH + 1)
    expect(sanitizeClientVersion(long)).toBeNull()
    expect(sanitizeClientVersion('1'.repeat(MAX_CLIENT_VERSION_LENGTH))).toBe('1'.repeat(MAX_CLIENT_VERSION_LENGTH))
  })

  it('rejects anything that could render as something other than a version', () => {
    // These are storage-hygiene rejections, not security claims: the value is
    // client-asserted either way, and it must not be able to smuggle markup,
    // quotes, control characters or newlines into an operator surface.
    for (const bad of [
      '<script>alert(1)</script>',
      "0.1.27'; DROP TABLE instance_attestation--",
      '0.1.27\nX-Injected: yes',
      '0.1.27 (dev build)', // whitespace inside
      '0.1.27\u0000', // a raw NUL, written escaped so this source file stays text
      '0.1 27', // interior whitespace (a TRAILING space IS trimmed — see the trim test above)
      '../../etc/passwd',
      '-leading-dash',
      '.leading-dot',
    ]) {
      expect(sanitizeClientVersion(bad), `should reject ${JSON.stringify(bad)}`).toBeNull()
    }
  })
})

describe('readClientVersionHeaders', () => {
  it('reads both headers and reports them as reported', () => {
    const c = readClientVersionHeaders({
      [PLUGIN_VERSION_HEADER]: '0.1.27',
      [CLIENT_VERSION_HEADER]: '2.1.212',
    })
    expect(c).toEqual({ pluginVersion: '0.1.27', cliVersion: '2.1.212', reported: true })
  })

  it('treats the two fields INDEPENDENTLY — one bad value must not blind the other', () => {
    const c = readClientVersionHeaders({
      [PLUGIN_VERSION_HEADER]: '0.1.27',
      [CLIENT_VERSION_HEADER]: 'garbage value with spaces',
    })
    expect(c.pluginVersion).toBe('0.1.27')
    expect(c.cliVersion).toBeNull()
    expect(c.reported).toBe(true)
  })

  it('reported=false only when NEITHER value survived — the "leave the columns alone" signal', () => {
    expect(readClientVersionHeaders({}).reported).toBe(false)
    expect(readClientVersionHeaders(undefined).reported).toBe(false)
    expect(readClientVersionHeaders(null).reported).toBe(false)
    expect(readClientVersionHeaders({ [PLUGIN_VERSION_HEADER]: '  ' }).reported).toBe(false)
  })

  it('takes the FIRST value of a repeated header rather than joining them', () => {
    // Joining would produce "0.1.27, 0.1.26", which sanitises to null and loses
    // BOTH readings — strictly worse than picking one.
    const c = readClientVersionHeaders({ [PLUGIN_VERSION_HEADER]: ['0.1.27', '0.1.26'] })
    expect(c.pluginVersion).toBe('0.1.27')
  })

  it('ignores unrelated headers', () => {
    const c = readClientVersionHeaders({ authorization: 'Bearer secret', 'user-agent': '1.2.3' })
    expect(c).toEqual({ pluginVersion: null, cliVersion: null, reported: false })
  })
})
