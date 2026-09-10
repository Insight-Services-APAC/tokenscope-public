/*
 * normalizeInet — the audit IP must be a REAL address or nothing (MDASH F374).
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The value comes from
 * `getRequestIP(event, { xForwardedFor: true })`, which returns the FIRST
 * X-Forwarded-For hop — a value the client sets. It is written into an `inet`
 * column, and Postgres rejects anything that is not an address, so a bad value
 * throws on INSERT. Two callers catch that and continue: the deny-audit in
 * report-scope.ts, whose own comment calls it "the only record of a denied
 * privilege-escalation attempt", and the named-person drill audit. So a
 * shape-only check let one header suppress a security audit row while the
 * refusal it recorded still happened.
 *
 * The old implementation matched SHAPES: /\d{1,3}(\.\d{1,3}){3}/ and
 * /[0-9a-fA-F:]+/. Every value in the first block below satisfies one of those
 * and is NOT an address.
 */
import { describe, it, expect } from 'vitest'
import { normalizeInet } from '../../../server/db/audit'

describe('normalizeInet rejects what Postgres would reject', () => {
  it.each([
    '999.999.999.999',
    '256.1.1.1',
    '10.0.0.256',
    'deadbeef',
    'cafe',
    '::::',
    'abcdef',
    '1.2.3.4.5',
    // net.isIP() ACCEPTS these two (returns 6); Postgres `inet` does not.
    'fe80::1%eth0',
    'fe80::1%1',
  ])('%s is not an address -> null', (bad) => {
    expect(normalizeInet(bad), `${bad} would have thrown on INSERT`).toBeNull()
  })

  it('rejects hostnames and junk', () => {
    for (const v of ['localhost', 'evil.example.com', '', '   ', 'null', '-1']) {
      expect(normalizeInet(v)).toBeNull()
    }
    expect(normalizeInet(null)).toBeNull()
    expect(normalizeInet(undefined)).toBeNull()
  })
})

describe('normalizeInet keeps every real address, port or not', () => {
  it.each([
    ['10.0.0.1', '10.0.0.1'],
    ['10.0.0.1:443', '10.0.0.1'],
    ['10.80.12.36:46306', '10.80.12.36'], // the shape dev's WAF actually sends
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[::1]:443', '::1'],
    ['2001:db8::8a2e:370:7334', '2001:db8::8a2e:370:7334'],
    ['  10.0.0.1  ', '10.0.0.1'],
    // IPv4-mapped IPv6: net.isIP says 6 and Postgres inet accepts it, but a
    // hex-and-colon charset in the bracket pre-parser excludes the dots and
    // silently drops the audit row. Bracketed and bare, since a dual-stack
    // listener produces the mapped form for every IPv4 client it serves.
    ['[::ffff:192.0.2.1]:443', '::ffff:192.0.2.1'],
    ['[::ffff:192.0.2.1]', '::ffff:192.0.2.1'],
    ['::ffff:192.0.2.1', '::ffff:192.0.2.1'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeInet(input)).toBe(expected)
  })
})
