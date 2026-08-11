/*
 * Persona-override sidecar cookie — encode, decode, tamper-detect.
 *
 * Same HMAC envelope as the legacy ts_session cookie; tests cover the
 * round-trip + the signature-verification path that protects against
 * a browser-side mutation flipping the impersonator identity.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  setPersonaOverrideCookie,
  readPersonaOverrideCookie,
  clearPersonaOverrideCookie,
  PERSONA_OVERRIDE_COOKIE_NAME,
  type PersonaOverridePayload,
} from '../../../server/utils/persona-override-cookie'

const VALID: PersonaOverridePayload = {
  targetTeammateId: '00000000-0000-0000-0000-000000000001',
  issuedAt: '2026-01-01T00:00:00.000Z',
  impersonatorOid: 'oid-real-admin',
  impersonatorEmail: 'admin@example.com',
}

beforeAll(() => {
  process.env.NUXT_SESSION_SECRET = 'test-secret-padded-to-thirty-two-chars-or-more'
})

function makeEvent() {
  const cookies = new Map<string, string>()
  return {
    cookies,
    node: {
      req: {
        get headers() {
          return { cookie: Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ') }
        },
        get socket() { return undefined },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        getHeader(name: string) { return this._headers[name.toLowerCase()] },
        setHeader(name: string, value: string | string[]) {
          this._headers[name.toLowerCase()] = value
          if (name.toLowerCase() === 'set-cookie') {
            const items = Array.isArray(value) ? value : [value]
            for (const item of items) {
              const [pair] = item.split(';')
              const eq = pair!.indexOf('=')
              const k = pair!.slice(0, eq)
              const v = pair!.slice(eq + 1)
              if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
              else cookies.set(k, v)
            }
          }
        },
        removeHeader(name: string) { this._headers[name.toLowerCase()] = '' },
        appendHeader(name: string, value: string | string[]) {
          const incoming = Array.isArray(value) ? value : [value]
          if (name.toLowerCase() === 'set-cookie') {
            for (const item of incoming) {
              const [pair] = item.split(';')
              const eq = pair!.indexOf('=')
              const k = pair!.slice(0, eq)
              const v = pair!.slice(eq + 1)
              if (v === '' && item.includes('Max-Age=0')) cookies.delete(k)
              else cookies.set(k, v)
            }
          }
          const existing = this._headers[name.toLowerCase()]
          this._headers[name.toLowerCase()] = existing
            ? (Array.isArray(existing) ? existing : [existing]).concat(incoming)
            : incoming
        },
        get headersSent() { return false },
      },
    },
  }
}

describe('persona-override sidecar cookie encode/decode', () => {
  it('roundtrips a valid payload', () => {
    const event = makeEvent()
    setPersonaOverrideCookie(event as unknown as Parameters<typeof setPersonaOverrideCookie>[0], VALID)
    const got = readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])
    expect(got).toEqual(VALID)
  })

  it('roundtrips a dev-mode payload (no impersonator fields)', () => {
    const event = makeEvent()
    const devOnly: PersonaOverridePayload = {
      targetTeammateId: '00000000-0000-0000-0000-000000000002',
      issuedAt: '2026-02-01T00:00:00.000Z',
    }
    setPersonaOverrideCookie(event as unknown as Parameters<typeof setPersonaOverrideCookie>[0], devOnly)
    const got = readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])
    expect(got).toEqual(devOnly)
  })

  it('clears the cookie', () => {
    const event = makeEvent()
    setPersonaOverrideCookie(event as unknown as Parameters<typeof setPersonaOverrideCookie>[0], VALID)
    expect(readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])).not.toBeNull()
    clearPersonaOverrideCookie(event as unknown as Parameters<typeof clearPersonaOverrideCookie>[0])
    expect(readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const event = makeEvent()
    setPersonaOverrideCookie(event as unknown as Parameters<typeof setPersonaOverrideCookie>[0], VALID)
    const cookieJar = event.cookies
    const raw = cookieJar.get('ts_persona_override')!
    const dot = raw.indexOf('.')
    const payload = raw.slice(0, dot)
    const sig = raw.slice(dot + 1)
    // Flip the target teammate id — would let a browser-side mutation
    // re-aim the override at a different persona without invalidating
    // the OIDC identity. The HMAC verification must catch this.
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    decoded.targetTeammateId = '99999999-9999-9999-9999-999999999999'
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    cookieJar.set('ts_persona_override', `${tampered}.${sig}`)

    const got = readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])
    expect(got).toBeNull()
  })
})

describe('persona-override sidecar cookie — NUXT_SESSION_SECRET strength floor', () => {
  const ORIGINAL = process.env.NUXT_SESSION_SECRET

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NUXT_SESSION_SECRET
    else process.env.NUXT_SESSION_SECRET = ORIGINAL
  })

  /**
   * Hand-mint the wire format directly (bypassing encode(), which is
   * allowed to throw loudly on a weak secret — see getSecret()'s doc
   * comment in persona-override-cookie.ts) so these tests exercise
   * ONLY decode()'s fail-closed contract, independent of encode()'s.
   */
  function mintRaw(secret: string, payload: PersonaOverridePayload): string {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const sig = createHmac('sha256', secret).update(body).digest('hex')
    return `${body}.${sig}`
  }

  it("a 32-char LOW-ENTROPY secret ('a'.repeat(32)) is REJECTED — decode() fails closed (returns null), never throws", () => {
    // Length passes (32 chars) but entropy does not — the exact shape
    // the pre-existing length-only check would have missed.
    const weakSecret = 'a'.repeat(32)
    process.env.NUXT_SESSION_SECRET = weakSecret
    const event = makeEvent()
    event.cookies.set(PERSONA_OVERRIDE_COOKIE_NAME, mintRaw(weakSecret, VALID))

    expect(() =>
      readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0]),
    ).not.toThrow()
    expect(
      readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0]),
    ).toBeNull()
  })

  it('a random base64 secret (>= 3.5 bits/byte) is ACCEPTED — round-trips normally', () => {
    process.env.NUXT_SESSION_SECRET = 'xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJiUoPsXcVnBmLkJhGfDsA=='
    const event = makeEvent()
    setPersonaOverrideCookie(event as unknown as Parameters<typeof setPersonaOverrideCookie>[0], VALID)
    const got = readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0])
    expect(got).toEqual(VALID)
  })

  it('still throws (unchanged, pre-existing behaviour) for a missing/too-short secret — only the entropy arm fails closed', () => {
    const shortSecret = 'too-short'
    process.env.NUXT_SESSION_SECRET = shortSecret
    const event = makeEvent()
    // A cookie must be PRESENT for decode()/getSecret() to even run —
    // readPersonaOverrideCookie short-circuits to null on a missing
    // cookie before ever touching the secret.
    event.cookies.set(PERSONA_OVERRIDE_COOKIE_NAME, mintRaw(shortSecret, VALID))
    expect(() =>
      readPersonaOverrideCookie(event as unknown as Parameters<typeof readPersonaOverrideCookie>[0]),
    ).toThrow(/missing or too short/)
  })
})
