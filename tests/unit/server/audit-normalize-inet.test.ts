/*
 * normalizeInet — coerces a client address into something the `inet` audit
 * column accepts. Regression for the dev 500: h3's getRequestIP returned
 * `10.80.12.36:46306` (dev's WAF forwards the source port), and Postgres `inet`
 * rejects a port, 500ing every browser-driven admin action.
 */
import { describe, it, expect } from 'vitest'
import { normalizeInet } from '../../../server/db/audit'

describe('normalizeInet', () => {
  it('strips the port from an IPv4:port (the dev WAF case)', () => {
    expect(normalizeInet('10.80.12.36:46306')).toBe('10.80.12.36')
    expect(normalizeInet('203.0.113.7:443')).toBe('203.0.113.7')
  })

  it('strips the port from a bracketed IPv6', () => {
    expect(normalizeInet('[::1]:443')).toBe('::1')
    expect(normalizeInet('[2001:db8::1]:8080')).toBe('2001:db8::1')
  })

  it('passes a bare IPv4 / IPv6 through unchanged', () => {
    expect(normalizeInet('10.80.12.36')).toBe('10.80.12.36')
    expect(normalizeInet('::1')).toBe('::1')
    expect(normalizeInet('2001:db8::1')).toBe('2001:db8::1')
  })

  it('nulls empty / non-IP values rather than letting them crash the insert', () => {
    expect(normalizeInet(null)).toBeNull()
    expect(normalizeInet(undefined)).toBeNull()
    expect(normalizeInet('')).toBeNull()
    expect(normalizeInet('not-an-ip')).toBeNull()
  })
})
