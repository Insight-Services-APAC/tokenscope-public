/*
 * CSRF Origin-header policy — server/auth/csrf.ts::checkOriginPolicy
 *
 * Threat model: a malicious page in a victim's browser POSTs to our
 * state-changing endpoint using the victim's cookie. Browsers always
 * send Origin on cross-origin POSTs; we reject when Origin is present
 * and doesn't match. Origin-absent (CLI / curl / Node fetch) is
 * allowed — those callers aren't the CSRF vector.
 *
 * Tests target the pure helper; assertSameOrigin is a thin h3 wrapper.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { checkOriginPolicy, assertSameOrigin } from '../../../server/auth/csrf'

const SELF = 'http://localhost:3450'

describe('checkOriginPolicy', () => {
  it('allows GET regardless of origin', () => {
    expect(
      checkOriginPolicy({ method: 'GET', expectedOrigin: SELF, origin: 'http://evil.test' }),
    ).toEqual({ ok: true })
  })

  it('allows POST with matching Origin', () => {
    expect(checkOriginPolicy({ method: 'POST', expectedOrigin: SELF, origin: SELF })).toEqual({
      ok: true,
    })
  })

  it('rejects POST with mismatched Origin', () => {
    const r = checkOriginPolicy({
      method: 'POST',
      expectedOrigin: SELF,
      origin: 'http://evil.test',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.presented).toBe('http://evil.test')
      expect(r.expected).toBe(SELF)
    }
  })

  it('allows POST with NO Origin and NO Referer (CLI / curl / server-to-server)', () => {
    // Threat model: a curl / Node script POST doesn't ride a stolen
    // browser cookie, so it isn't the CSRF vector. Reject would also
    // break the plugin (Node fetch doesn't send Origin).
    expect(checkOriginPolicy({ method: 'POST', expectedOrigin: SELF })).toEqual({ ok: true })
  })

  it('rejects POST with mismatched Referer when Origin absent', () => {
    const r = checkOriginPolicy({
      method: 'POST',
      expectedOrigin: SELF,
      referer: 'http://evil.test/some/page',
    })
    expect(r.ok).toBe(false)
  })

  it('allows POST with matching Referer when Origin absent', () => {
    expect(
      checkOriginPolicy({
        method: 'POST',
        expectedOrigin: SELF,
        referer: `${SELF}/login`,
      }),
    ).toEqual({ ok: true })
  })

  it('allows PATCH/DELETE with matching Origin', () => {
    expect(
      checkOriginPolicy({ method: 'PATCH', expectedOrigin: SELF, origin: SELF }),
    ).toEqual({ ok: true })
    expect(
      checkOriginPolicy({ method: 'DELETE', expectedOrigin: SELF, origin: SELF }),
    ).toEqual({ ok: true })
  })

  it('rejects PATCH with mismatched Origin', () => {
    const r = checkOriginPolicy({
      method: 'PATCH',
      expectedOrigin: SELF,
      origin: 'http://attacker.test',
    })
    expect(r.ok).toBe(false)
  })

  it('handles malformed Referer URL safely (treats as absent → allow)', () => {
    expect(
      checkOriginPolicy({ method: 'POST', expectedOrigin: SELF, referer: 'not-a-url' }),
    ).toEqual({ ok: true })
  })
})

describe('assertSameOrigin honours APP_PUBLIC_ORIGIN (pinned public origin)', () => {
  const ORIG_FD = process.env.AZURE_FRONT_DOOR_ID
  const ORIG_PIN = process.env.APP_PUBLIC_ORIGIN
  afterEach(() => {
    if (ORIG_FD === undefined) delete process.env.AZURE_FRONT_DOOR_ID
    else process.env.AZURE_FRONT_DOOR_ID = ORIG_FD
    if (ORIG_PIN === undefined) delete process.env.APP_PUBLIC_ORIGIN
    else process.env.APP_PUBLIC_ORIGIN = ORIG_PIN
  })

  function postEvent(headers: Record<string, string>): H3Event {
    const req = new IncomingMessage(new Socket())
    req.method = 'POST'
    req.url = '/api/v1/admin/regions/x/project-lifecycle'
    // Internal CA host — the dev WAF rewrote the original Host away.
    req.headers.host = 'ca-tokenscope-example.internal.azurecontainerapps.io'
    Object.assign(req.headers, headers)
    return createEvent(req, new ServerResponse(req))
  }

  it('accepts a POST whose Origin matches the pinned public origin (even though Host is the internal CA)', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    expect(() =>
      assertSameOrigin(postEvent({ origin: 'https://tokenscope.example.com' })),
    ).not.toThrow()
  })

  it('rejects a cross-origin POST against the pinned origin', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    expect(() => assertSameOrigin(postEvent({ origin: 'https://evil.example' }))).toThrow()
  })
})
