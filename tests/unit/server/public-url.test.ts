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
import { readFileSync } from 'node:fs'
import { getPublicRequestURL, isPublicOriginTrusted } from '../../../server/utils/public-url'
import authServerMetadataHandler from '../../../server/routes/.well-known/oauth-authorization-server.get'
import { handleProtectedResourceMetadata } from '../../../server/routes/.well-known/oauth-protected-resource/handler'

function makeEvent(headers: Record<string, string>): H3Event {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = '/api/v1/setup/redeem'
  req.headers.host = 'ca-tokenscope-sandbox-aue.example.azurecontainerapps.io'
  Object.assign(req.headers, headers)
  return createEvent(req, new ServerResponse(req))
}

// defineEventHandler wraps the handler in an object with a `.handler`
// property AND makes the object itself callable via h3's runtime. Same
// unwrap pattern as tests/integration/middleware/require-front-door.test.ts.
type CallableHandler = (event: H3Event) => unknown
type WrappedHandler = CallableHandler & { handler?: CallableHandler }
function unwrap(h: unknown): CallableHandler {
  const wrapped = h as WrappedHandler
  return wrapped.handler ?? wrapped
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
      makeEvent({
        'x-forwarded-host': 'ep-tokenscope.z03.azurefd.net',
        'x-forwarded-proto': 'https',
      }),
    )
    expect(url.origin).toBe('https://ep-tokenscope.z03.azurefd.net')
  })

  it('NOT behind Front Door, ignores X-Forwarded-Host (anti-spoof) and uses the request Host', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const url = getPublicRequestURL(makeEvent({ 'x-forwarded-host': 'evil.attacker.example' }))
    // Full origin (not just .host) — the scheme was previously untested here,
    // which hid the xForwardedProto-gated-on-behindFrontDoor bug (public-url.ts).
    // https, not http: TLS terminates upstream so the container's own scheme is
    // always http, and that cleartext origin used to be baked into durable emit
    // credentials. The anti-spoof property under test is the HOST, unchanged.
    expect(url.origin).toBe('https://ca-tokenscope-sandbox-aue.example.azurecontainerapps.io')
    expect(url.origin).not.toContain('evil.attacker.example')
  })

  it('non-AFD, no APP_PUBLIC_ORIGIN, but a real X-Forwarded-Proto: https header (platform ingress terminates TLS even pre-Front-Door) → origin scheme is https', () => {
    // Regression test for the xForwardedProto bug: the OLD code gated
    // `xForwardedProto` on `behindFrontDoor`, so this header was silently
    // ignored whenever AZURE_FRONT_DOOR_ID was unset — even though TLS
    // genuinely terminates upstream of the container in every deployed
    // environment (connection.encrypted is structurally false here).
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const url = getPublicRequestURL(makeEvent({ 'x-forwarded-proto': 'https' }))
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('ca-tokenscope-sandbox-aue.example.azurecontainerapps.io')
  })

  it('behind Front Door, a multi-hop X-Forwarded-Host resolves to the TRUSTED (last) hop, never hop 1', () => {
    // An attacker-supplied X-Forwarded-Host arrives first in the chain;
    // Front Door appends its own value after it. h3's own xForwardedHost
    // option takes hop 1 (`.split(',').shift()`) — public-url.ts must not
    // delegate to it for this reason.
    process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
    const url = getPublicRequestURL(
      makeEvent({
        'x-forwarded-host': 'evil.example, real.host',
        'x-forwarded-proto': 'https',
      }),
    )
    expect(url.host).toBe('real.host')
    expect(url.origin).not.toContain('evil.example')
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
      const url = getPublicRequestURL(
        makeEvent({ host: 'ca-tokenscope-example.internal.azurecontainerapps.io' }),
      )
      expect(url.origin).toBe('https://tokenscope.example.com')
    })

    it('takes precedence over AZURE_FRONT_DOOR_ID when both are set', () => {
      process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
      process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
      const url = getPublicRequestURL(
        makeEvent({
          'x-forwarded-host': 'ep-tokenscope.z03.azurefd.net',
          'x-forwarded-proto': 'https',
        }),
      )
      expect(url.origin).toBe('https://tokenscope.example.com')
    })

    it('a malformed APP_PUBLIC_ORIGIN fails SAFE — ignored, falls back to request Host', () => {
      delete process.env.AZURE_FRONT_DOOR_ID
      process.env.APP_PUBLIC_ORIGIN = 'not a url'
      const url = getPublicRequestURL(makeEvent({}))
      // Full origin (not just .host) — see the note on the non-AFD test above.
      // https, not http: TLS terminates upstream so the container's own scheme is
      // always http, and that cleartext origin used to be baked into durable emit
      // credentials. The anti-spoof property under test is the HOST, unchanged.
      expect(url.origin).toBe('https://ca-tokenscope-sandbox-aue.example.azurecontainerapps.io')
    })
  })
})

describe('.well-known OAuth metadata handlers — Vary + Cache-Control (cache-poisoning backstop)', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AZURE_FRONT_DOOR_ID
    else process.env.AZURE_FRONT_DOOR_ID = ORIGINAL
    if (ORIGINAL_PINNED === undefined) delete process.env.APP_PUBLIC_ORIGIN
    else process.env.APP_PUBLIC_ORIGIN = ORIGINAL_PINNED
  })

  function varyOrNonPublicCacheControl(res: ServerResponse): void {
    const vary = res.getHeader('vary')
    const cacheControl = String(res.getHeader('cache-control') ?? '')
    const hasVary = typeof vary === 'string' && /x-forwarded-host/i.test(vary)
    const nonPublicCache = !/(^|,)\s*public\s*(,|$)/i.test(cacheControl)
    expect(hasVary || nonPublicCache).toBe(true)
  }

  it('oauth-authorization-server.get.ts emits a Vary covering the forwarded-host headers (or a non-public Cache-Control)', async () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const event = makeEvent({})
    await unwrap(authServerMetadataHandler)(event)
    varyOrNonPublicCacheControl(event.node.res as ServerResponse)
  })

  it('oauth-protected-resource/handler.ts emits a Vary covering the forwarded-host headers (or a non-public Cache-Control)', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const event = makeEvent({})
    handleProtectedResourceMetadata(event)
    varyOrNonPublicCacheControl(event.node.res as ServerResponse)
  })

  it('a pinned APP_PUBLIC_ORIGIN makes the body independent of an injected X-Forwarded-Host', async () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    const event = makeEvent({ 'x-forwarded-host': 'evil.attacker.example' })
    const body = (await unwrap(authServerMetadataHandler)(event)) as { issuer: string }
    expect(body.issuer).toBe('https://tokenscope.example.com')
    expect(body.issuer).not.toContain('evil.attacker.example')
  })
})

describe('X-Forwarded-Proto is honoured ONLY behind a trusted proxy chain (PR #204 review)', () => {
  // The file-level afterEach restores AZURE_FRONT_DOOR_ID / APP_PUBLIC_ORIGIN.
  it('a spoofed http X-Forwarded-Proto cannot DOWNGRADE the origin off the trusted chain', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    // The dangerous direction: csrf.ts derives expectedOrigin from this, so a
    // spoofed `http` would let a plaintext origin satisfy same-origin.
    const url = getPublicRequestURL(
      makeEvent({ host: 'tokenscope.example.com', 'x-forwarded-proto': 'http' }),
    )
    expect(url.protocol).toBe('https:')
  })

  it('a non-loopback host with no proxy config still resolves https, not the container scheme', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    // TLS terminates upstream, so the request's OWN scheme is always http in a
    // container — that is what baked a cleartext origin into durable emit
    // credentials. Absent a trusted chain we assume https rather than trusting
    // either the header or connection.encrypted.
    const url = getPublicRequestURL(makeEvent({ host: 'tokenscope.example.com' }))
    expect(url.protocol).toBe('https:')
  })

  it('loopback stays http — the one structural local-dev signal', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    const url = getPublicRequestURL(makeEvent({ host: 'localhost:3450' }))
    expect(url.protocol).toBe('http:')
    expect(url.host).toBe('localhost:3450')
  })
})

describe('isPublicOriginTrusted — may this origin be handed to a client as a secret destination?', () => {
  // getPublicRequestURL always returns SOMETHING; this decides whether that
  // something is operator-controlled or merely what the caller asked to be
  // called. The distinction matters because the origin becomes the host a
  // developer machine POSTs a one-time emit-handoff code to, and gets baked
  // into durable emit credentials.

  it('trusts a pinned APP_PUBLIC_ORIGIN regardless of the Host header', () => {
    delete process.env.AZURE_FRONT_DOOR_ID
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    expect(isPublicOriginTrusted(makeEvent({ host: 'attacker.example' }))).toBe(true)
  })

  it('trusts the origin behind Front Door', () => {
    delete process.env.APP_PUBLIC_ORIGIN
    process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
    expect(isPublicOriginTrusted(makeEvent({ 'x-forwarded-host': 'ep.z03.azurefd.net' }))).toBe(
      true,
    )
  })

  it('does NOT trust a Front-Door deployment when the request carries no forwarded host', () => {
    // AZURE_FRONT_DOOR_ID says the DEPLOYMENT is configured to sit behind Front
    // Door. It does not say THIS request came from there. Without the header,
    // getPublicRequestURL falls back to the request's own Host, so answering
    // "trusted" here would bake whatever the caller asked to be called — the
    // precise thing this function exists to refuse.
    //
    // require-front-door rejects such a request today, so this is defence in
    // depth rather than a live hole; the point is that the guard holds on its
    // own instead of inheriting a middleware's path coverage.
    delete process.env.APP_PUBLIC_ORIGIN
    process.env.AZURE_FRONT_DOOR_ID = 'b0f4f6c8-1a2b-4c3d-9e8f-abcdef012345'
    expect(isPublicOriginTrusted(makeEvent({ host: 'attacker.example' }))).toBe(false)
    // And the honest-but-useless case it also covers: the internal CA FQDN,
    // which is what Host actually holds on that deployment. Baking it produces
    // an enrolment that reports success and never emits.
    expect(
      isPublicOriginTrusted(
        makeEvent({ host: 'ca-tokenscope-sandbox-aue.internal.azurecontainerapps.io' }),
      ),
    ).toBe(false)
  })

  it('trusts loopback, so local dev is not gratuitously broken', () => {
    delete process.env.APP_PUBLIC_ORIGIN
    delete process.env.AZURE_FRONT_DOOR_ID
    expect(isPublicOriginTrusted(makeEvent({ host: 'localhost:3450' }))).toBe(true)
    expect(isPublicOriginTrusted(makeEvent({ host: '127.0.0.1:3450' }))).toBe(true)
  })

  it('does NOT trust an arbitrary Host when unpinned and not behind Front Door', () => {
    delete process.env.APP_PUBLIC_ORIGIN
    delete process.env.AZURE_FRONT_DOOR_ID
    expect(isPublicOriginTrusted(makeEvent({ host: 'attacker.example' }))).toBe(false)
  })

  it('does NOT trust the internal Container Apps FQDN', () => {
    // The realistic case, and the one that motivated the gate: CA ingress
    // rewrites Host to an internal FQDN no developer machine can resolve, so
    // trusting it bakes an unreachable endpoint and emission dies silently.
    delete process.env.APP_PUBLIC_ORIGIN
    delete process.env.AZURE_FRONT_DOOR_ID
    expect(
      isPublicOriginTrusted(
        makeEvent({ host: 'ca-tokenscope-sandbox-aue.internal.azurecontainerapps.io' }),
      ),
    ).toBe(false)
  })
})

describe('the trusted-origin gate is actually applied at its call sites', () => {
  // The provision-emit suite constructs createMcpServer directly with an
  // origin, so it cannot notice if the ROUTE stops consulting the gate. A
  // policy that is correct and unused is indistinguishable from one that is
  // absent, so pin the wiring at the source, the same way the endpoint
  // redaction guard is pinned.
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\s+/g, ' ')

  it('the MCP route passes the origin to createMcpServer only when trusted', () => {
    // BOTH arms, in order. Matching only up to the `?` accepted the inverted
    // guard -- `isPublicOriginTrusted(event) ? undefined : publicUrl.origin`
    // names the host precisely when it is untrusted, which is the bug this pin
    // exists to catch, and it satisfied the old pattern exactly.
    const src = read('../../../server/api/v1/mcp/[...].ts')
    expect(src).toMatch(
      /createMcpServer\(\s*undefined,\s*isPublicOriginTrusted\(event\)\s*\?\s*publicUrl\.origin\s*:\s*undefined\s*,?\s*\)/,
    )
  })

  it('no route hands getPublicRequestURL(...).origin to createMcpServer unguarded', () => {
    const src = read('../../../server/api/v1/mcp/[...].ts')
    expect(src).not.toMatch(/createMcpServer\(\s*undefined,\s*publicUrl\.origin\s*\)/)
  })
})
