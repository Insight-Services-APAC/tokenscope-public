/*
 * getPublicRequestURL — resolves the PUBLIC origin the client used, honouring
 * X-Forwarded-Host ONLY behind Front Door (AZURE_FRONT_DOOR_ID set). This is
 * what makes the baked bearer/OTLP endpoints reachable: behind FD the default
 * Host is the 403-blocked CA FQDN, so we must use the forwarded host.
 *
 * Pure function over env + headers — mock an h3 event (same pattern as
 * tests/integration/middleware/require-front-door.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createEvent, type H3Event } from 'h3'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { getPublicRequestURL } from '../../../server/utils/public-url'

function makeEvent(headers: Record<string, string>): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/api/v1/setup/redeem'
  req.headers.host = 'ca-tokenscope-sandbox-aue.example.azurecontainerapps.io'
  Object.assign(req.headers, headers)
  return createEvent(req, new ServerResponse(req))
}

const ORIGINAL = process.env.AZURE_FRONT_DOOR_ID
const ORIGINAL_PINNED = process.env.APP_PUBLIC_ORIGIN
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AZURE_FRONT_DOOR_ID
  else process.env.AZURE_FRONT_DOOR_ID = ORIGINAL
  if (ORIGINAL_PINNED === undefined) delete process.env.APP_PUBLIC_ORIGIN
  else process.env.APP_PUBLIC_ORIGIN = ORIGINAL_PINNED
})

describe('getPublicRequestURL', () => {
  it('behind Front Door, uses X-Forwarded-Host/Proto (the public FD host, not the CA FQDN)', () => {
    process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
    const url = getPublicRequestURL(
      makeEvent({ 'x-forwarded-host': 'ep-tokenscope.z03.azurefd.net', 'x-forwarded-proto': 'https' }),
    )
    expect(url.origin).toBe('https://ep-tokenscope.z03.azurefd.net')
  })

  it('NOT behind Front Door, ignores X-Forwarded-Host (anti-spoof) and uses the request Host', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const url = getPublicRequestURL(makeEvent({ 'x-forwarded-host': 'evil.attacker.example' }))
    expect(url.host).toBe('ca-tokenscope-sandbox-aue.example.azurecontainerapps.io')
    expect(url.origin).not.toContain('evil.attacker.example')
  })

  describe('APP_PUBLIC_ORIGIN (pinned origin module)', () => {
    it('pins scheme+host from config and keeps the request path+query', () => {
      delete process.env.AZURE_FRONT_DOOR_ID
      process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
      const url = getPublicRequestURL(makeEvent({}))
      expect(url.origin).toBe('https://tokenscope.example.com')
      expect(url.pathname).toBe('/api/v1/setup/redeem') // path from the request
    })

    it('wins over a REWRITTEN Host header (proxy that rewrites Host still resolves the public origin)', () => {
      delete process.env.AZURE_FRONT_DOOR_ID
      process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
      // The internal CA FQDN arrives in Host (proxy rewrote it) — ignored.
      const url = getPublicRequestURL(makeEvent({ host: 'ca-tokenscope-example.internal.azurecontainerapps.io' }))
      expect(url.origin).toBe('https://tokenscope.example.com')
    })

    it('takes precedence over AZURE_FRONT_DOOR_ID when both are set', () => {
      process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
      process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
      const url = getPublicRequestURL(
        makeEvent({ 'x-forwarded-host': 'ep-tokenscope.z03.azurefd.net', 'x-forwarded-proto': 'https' }),
      )
      expect(url.origin).toBe('https://tokenscope.example.com')
    })

    it('a malformed APP_PUBLIC_ORIGIN fails SAFE — ignored, falls back to request Host', () => {
      delete process.env.AZURE_FRONT_DOOR_ID
      process.env.APP_PUBLIC_ORIGIN = 'not a url'
      const url = getPublicRequestURL(makeEvent({}))
      expect(url.host).toBe('ca-tokenscope-sandbox-aue.example.azurecontainerapps.io')
    })
  })
})
