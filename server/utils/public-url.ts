import { getRequestURL, getRequestHeader, createError, type H3Event } from 'h3'
import consola from 'consola'

let warnedInvalidOrigin = false

/**
 * The optional PINNED public origin (scheme://host[:port]) from
 * `APP_PUBLIC_ORIGIN`, or null when unset / malformed.
 *
 * This is the "fronted under a fixed hostname" module: when an upstream
 * WAF / reverse proxy serves us under a stable public hostname (e.g. the
 * IT-hosted dev zone's `https://tokenscope.example.com`), set this and
 * the app pins its public origin from config. It is deliberately
 * independent of the Host / X-Forwarded-* headers, so it is correct
 * whether the proxy PRESERVES or REWRITES the Host header.
 *
 * Malformed value fails SAFE (logged once, then ignored) rather than
 * taking the app down over a config typo.
 */
function pinnedPublicOrigin(): string | null {
  const raw = process.env.APP_PUBLIC_ORIGIN
  if (!raw) return null
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('non-http(s) scheme')
    return u.origin
  } catch {
    if (!warnedInvalidOrigin) {
      console.warn(
        `[public-url] APP_PUBLIC_ORIGIN is set but not a valid http(s) origin: "${raw}" — ignoring`,
      )
      warnedInvalidOrigin = true
    }
    return null
  }
}

/**
 * Resolve the TRUSTED `X-Forwarded-Host` hop. In a proxy chain each hop
 * APPENDS its own value (comma-separated); the value nearest to us — the
 * LAST hop — is the one Azure Front Door itself set. The FIRST hop is
 * whatever the client sent and is never trustworthy (an attacker can send
 * `X-Forwarded-Host: evil.example` and AFD appends its own value after it).
 *
 * h3's own `xForwardedHost` option takes hop 1 (`.split(',').shift()`,
 * see node_modules/h3/dist/index.mjs `getRequestHost`) — which is why this
 * is resolved by hand instead of delegating to it.
 */
function trustedForwardedHost(event: H3Event): string | undefined {
  const raw = getRequestHeader(event, 'x-forwarded-host')
  if (!raw) return undefined
  const hops = raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  return hops.at(-1)
}

/**
 * The PUBLIC URL the client actually used to reach us. Resolution order:
 *
 * 1. `APP_PUBLIC_ORIGIN` pinned origin (optional module above) — for an
 *    upstream WAF/proxy that fronts us under a fixed hostname. Path + query
 *    come from the actual request; scheme + host come from config.
 *
 * 2. Azure Front Door (sandbox / prod): FD rewrites the Host header to the
 *    backend origin (the firewalled `*.azurecontainerapps.io` CA FQDN) and
 *    forwards the real client host in `X-Forwarded-Host`. We honour it ONLY
 *    when `AZURE_FRONT_DOOR_ID` is set — the same gate as `require-front-door`
 *    middleware and `assertSameOrigin`; inside that gate every request has
 *    already been validated to carry a matching `X-Azure-FDID`, so the
 *    forwarded headers are trustworthy. Outside it, trusting them would allow
 *    host injection. Even then, we take the LAST hop, never the first
 *    (`trustedForwardedHost` above).
 *
 * 3. Otherwise the request's own Host (local dev, no proxy).
 *
 * Scheme resolution is UNCONDITIONAL on `X-Forwarded-Proto`, regardless of
 * whether we're behind Front Door: TLS always terminates upstream of this
 * process (Front Door, or the platform ingress in front of the Container
 * App during the pre-Front-Door bootstrap phase) — `connection.encrypted`
 * is structurally false inside the container and is never the right
 * fallback signal. When the header is absent (genuine local dev, no proxy
 * in front of us at all) we correctly fall through to the request's own
 * (http) scheme.
 *
 * A bearer / OTLP / MCP endpoint or an OAuth-metadata issuer derived from the
 * naive request Host would be baked with an UNREACHABLE host behind a proxy,
 * silently breaking clients — hence this single chokepoint that CSRF, the
 * provisioning endpoints, and the OAuth metadata all route through.
 */
export function getPublicRequestURL(event: H3Event): URL {
  const pinned = pinnedPublicOrigin()
  if (pinned) {
    const reqUrl = getRequestURL(event)
    return new URL(reqUrl.pathname + reqUrl.search, pinned)
  }

  const behindFrontDoor = Boolean(process.env.AZURE_FRONT_DOOR_ID)
  const trustedHost = behindFrontDoor ? trustedForwardedHost(event) : undefined
  // X-Forwarded-Proto is honoured ONLY behind a trusted proxy chain (PR #204
  // review). Off that chain the header is caller-supplied, and the dangerous
  // direction is a DOWNGRADE: a spoofed `http` makes csrf.ts's expectedOrigin
  // http://…, so a request from a plaintext origin would satisfy same-origin.
  //
  // Not trusting it does NOT mean falling back to the request's own scheme: TLS
  // terminates upstream in a container, so `connection.encrypted` is structurally
  // false and the request scheme is ALWAYS http — which is what put a cleartext
  // origin into durable emit credentials in the first place. So: assume https,
  // which is true of every deployed environment, and special-case only the one
  // structural signal that genuinely means local dev, a loopback host.
  const reqUrl = getRequestURL(event, { xForwardedProto: behindFrontDoor })
  if (!behindFrontDoor && !isLoopbackHost(reqUrl.hostname) && reqUrl.protocol !== 'https:') {
    reqUrl.protocol = 'https:'
  }
  if (!trustedHost) return reqUrl
  return new URL(reqUrl.pathname + reqUrl.search, `${reqUrl.protocol}//${trustedHost}`)
}

/**
 * The hostnames the PLATFORM serves this container under, as distinct from the
 * public hostname a client dials.
 *
 * WHY THIS EXISTS. A fronting proxy is free to rewrite the Host header to the
 * backend's own address, and Azure Container Apps effectively REQUIRES it to:
 * CA ingress routes on Host, and an app with no custom domain bound is only
 * addressable by its platform FQDN. So on any proxy-fronted deployment the
 * Host we receive is NOT the host the client typed, and `APP_PUBLIC_ORIGIN`
 * exists precisely because of that (see pinnedPublicOrigin above).
 *
 * Any allowlist of "hosts we answer to" that omits these is wrong on every
 * deployed environment. That is not hypothetical: the MCP transport's
 * DNS-rebinding allowlist shipped with only the public host plus a Front-Door
 * branch, and dev — fronted by IT's zone WAF, no Front Door — rejected every
 * MCP request with `Invalid Host header: ca-tokenscope-example.…`.
 *
 * BOTH forms are returned, and the distinction is load-bearing (verified
 * 2026-07-28 by `printenv` inside the running dev container):
 *
 *   CONTAINER_APP_NAME + CONTAINER_APP_ENV_DNS_SUFFIX
 *     → ca-tokenscope-example.<suffix>            ← the APP-level FQDN,
 *       the latest-revision endpoint, and the exact value in the failure.
 *   CONTAINER_APP_HOSTNAME
 *     → ca-tokenscope-example--0000080.<suffix>   ← the REVISION-pinned FQDN.
 *
 * CONTAINER_APP_HOSTNAME alone does NOT cover the observed case — it carries
 * the revision suffix. A fix built on it (the intuitive single-variable guess)
 * would have deployed and stayed broken.
 *
 * Empty off-platform (local dev, tests) — callers must treat it as additive.
 *
 * `MCP_ALLOWED_HOSTS` (comma-separated) is an ESCAPE HATCH for a topology this
 * function does not model — a custom backend domain, a private DNS alias, a
 * traffic-label FQDN, a proxy origin name. Deriving from platform variables
 * covers what we run today; it cannot cover what someone stands up next, and
 * the cost of being wrong is a dead MCP surface. An operator can add a host
 * with an env var instead of a code change and a release.
 */
export function platformSelfHosts(): string[] {
  const hosts: string[] = []
  const name = process.env.CONTAINER_APP_NAME
  const suffix = process.env.CONTAINER_APP_ENV_DNS_SUFFIX
  if (name && suffix) hosts.push(`${name}.${suffix}`)
  const revisionFqdn = process.env.CONTAINER_APP_HOSTNAME
  if (revisionFqdn) hosts.push(revisionFqdn)
  for (const extra of (process.env.MCP_ALLOWED_HOSTS ?? '').split(',')) {
    const h = extra.trim()
    if (h) hosts.push(h)
  }
  return hosts
}

/**
 * Compare two `Host` authorities the way HTTP means them: hostname
 * case-insensitively (RFC 3986), and with the scheme's default port equivalent
 * to no port at all — `example.com` and `example.com:443` are the same origin,
 * and a proxy is free to send either. Raw string equality (which is what the
 * MCP SDK does) would reject one of them for no reason a user could act on.
 */
function sameAuthority(a: string, b: string): boolean {
  const ca = canonicalAuthority(a)
  const cb = canonicalAuthority(b)
  // An unparseable value equals NOTHING, including another unparseable value —
  // otherwise two different malformed hosts would match each other.
  return ca !== null && ca === cb
}

/**
 * Canonical form of a `Host` authority, or null if it is not a valid one.
 *
 * PARSED, not string-munged. An earlier version stripped a `:80|:443` suffix
 * with a regex, which (a) made `example.com:80` and `example.com:443` the same
 * authority despite being different origins, and (b) let malformed pairs like
 * `example.com::443` and `example.com:` compare equal. Adversarial review
 * caught both. Handing the value to the URL parser gets IPv6 brackets, ports
 * and casing right for free, and lets us REFUSE the shapes a Host header may
 * not contain rather than normalising them away into a match.
 *
 * Only `:443` elides. Every deployed environment is https (TLS terminates at
 * the proxy) and local dev uses an explicit non-default port, so eliding `:80`
 * buys nothing — and doing it anyway is what conflated the two schemes.
 */
function canonicalAuthority(host: string): string | null {
  const raw = host.trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(`https://${raw}`)
  } catch {
    return null
  }
  // A Host header carries an authority and nothing else. Userinfo or a path
  // means the value is malformed or an injection attempt: refuse it rather
  // than normalise it into a match.
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null
  if (!u.hostname) return null
  return u.port && u.port !== '443' ? `${u.hostname}:${u.port}` : u.hostname
}

/**
 * Every `Host` value this app legitimately answers to, for a transport that
 * enforces a Host allowlist (today: the MCP Streamable HTTP transport).
 *
 * PURE and fully parameterised on purpose. The allowlist depends on exactly
 * three deployment facts — pinned public origin?, Front Door?, running on the
 * Container Apps platform? — which is EIGHT possible shapes, and the bug this
 * replaced was a wrong answer in one of them that nobody could see because the
 * logic was inlined in a handler that needs a DB and an OAuth token to reach.
 * As a pure function every shape is enumerable in a unit test
 * (tests/unit/server/self-addressable-hosts.test.ts asserts all eight).
 *
 * Deriving `publicHost` from the request is the caller's job
 * (getPublicRequestURL) — note that when nothing is pinned and there is no
 * Front Door it resolves to the request's OWN Host, which makes the allowlist
 * self-satisfying. That is a real property of the un-fronted topology, not an
 * oversight: an app with no independent notion of its own identity cannot
 * refute a Host claim. It is pinned as a test case rather than hidden.
 */
export function selfAddressableHosts(input: {
  /** getPublicRequestURL(event).host — pinned origin, else FD host, else our own. */
  publicHost: string
  /** The raw incoming Host header, if any. */
  rawHost?: string | undefined
  /** AZURE_FRONT_DOOR_ID present — require-front-door has already vetted X-Azure-FDID. */
  behindFrontDoor?: boolean
  /** Defaults to the live platform values; injectable for tests. */
  platformHosts?: string[]
}): string[] {
  const {
    publicHost,
    rawHost,
    behindFrontDoor = false,
    platformHosts = platformSelfHosts(),
  } = input

  const hosts = [
    ...new Set([publicHost, ...platformHosts, ...(behindFrontDoor && rawHost ? [rawHost] : [])]),
  ].filter(Boolean)

  // The MCP SDK compares the raw header with `Array.includes` — exact,
  // case-SENSITIVE, port-sensitive (webStandardStreamableHttp.js
  // validateRequestHeaders). HTTP does not mean it that way: hostnames are
  // case-insensitive and `:443` is the same authority as no port. So admit the
  // header VERBATIM whenever it is the same authority as a host we already
  // trust — otherwise a proxy sending `Host: EXAMPLE.com:443` is turned away
  // over punctuation, which is exactly the failure mode this whole module
  // exists to stop.
  if (rawHost && !hosts.includes(rawHost) && hosts.some((h) => sameAuthority(h, rawHost))) {
    hosts.push(rawHost)
  }
  return hosts
}

/**
 * Is this `Host` one we answer to? The question the caller actually has —
 * asked here so no caller re-implements the authority comparison and gets the
 * port or casing rule subtly different.
 *
 * An ABSENT Host is not self-addressable. HTTP/1.1 requires the header and
 * HTTP/2 synthesises it from `:authority`, so absence is a malformed request,
 * and answering it would make "did this deployment accept my Host" ambiguous
 * for anything probing the endpoint.
 */
export function isSelfAddressableHost(allowed: string[], rawHost: string | undefined): boolean {
  if (!rawHost) return false
  return allowed.some((h) => sameAuthority(h, rawHost))
}

/** Loopback = the only structural "this is local dev" signal we accept. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Is `getPublicRequestURL`'s host derived from something the CALLER cannot
 * choose?
 *
 * WHY THIS MATTERS. `getPublicRequestURL` has three host sources (see its
 * docstring): a pinned `APP_PUBLIC_ORIGIN`, a Front-Door-validated
 * `X-Forwarded-Host`, and — when neither is configured — the request's own
 * `Host` header. The first two are operator-controlled. The third is
 * client-supplied, and for most consumers that is harmless: an origin is used
 * to build a URL the SAME caller then dials, so choosing a wrong one only
 * misdirects yourself.
 *
 * It stops being harmless the moment the derived origin is handed back as a
 * destination for a SECRET. `provision_emit` returns a redeem URL that the
 * developer's machine then POSTs a one-time emit-handoff code to; deriving that
 * host from `Host` means an unpinned deployment can be induced to name any host
 * at all as the place to send it. It is also the exact shape that silently
 * breaks a real deployment: Azure Container Apps ingress rewrites `Host` to the
 * internal `*.azurecontainerapps.io` FQDN, so during the documented
 * pre-Front-Door bootstrap phase the absolute URL would be baked with a host
 * the developer's machine cannot resolve.
 *
 * Loopback counts as trusted: local dev has no proxy to pin, and an attacker
 * who can already set `Host` on a loopback request is inside the machine.
 *
 * Callers embedding an origin in a credential, a secret destination, or
 * anything durable MUST gate on this and degrade (usually to a relative URL)
 * when it is false.
 */
export function isPublicOriginTrusted(event: H3Event): boolean {
  if (pinnedPublicOrigin()) return true
  // AZURE_FRONT_DOOR_ID alone is NOT the answer, and asking only that was a
  // weaker check than this docstring promised. It says the deployment is
  // *configured* to sit behind Front Door; it does not say THIS request's origin
  // came from there. `getPublicRequestURL` only honours `X-Forwarded-Host` when
  // the header is actually present, and falls back to the request's own `Host`
  // when it is not — so a request reaching the container without it was being
  // declared trusted while its origin came from the caller.
  //
  // `require-front-door` rejects such a request today, which is why this was a
  // latent weakness rather than a live hole. But this function is the control
  // the setup routes name when they refuse to bake an origin, so it has to hold
  // on its own rather than inherit a middleware's coverage — the middleware
  // excludes paths, and the set of excluded paths is not this file's to know.
  //
  // Requiring the header costs nothing real: on a Front-Door deployment its
  // ABSENCE already means the derived origin is the internal Container Apps
  // FQDN, which no developer machine can resolve. Refusing to bake that is
  // strictly better than baking it (see the docstring above), so the tightened
  // check has no correct-deployment case it turns away.
  if (process.env.AZURE_FRONT_DOOR_ID && trustedForwardedHost(event)) return true
  return isLoopbackHost(getPublicRequestURL(event).hostname)
}

/**
 * Fail the request unless this server can vouch for its own public origin.
 *
 * Same decision as `isPublicOriginTrusted`, raised as the RFC-9457 500 the
 * callers need. It exists separately so the check can be made TWICE, for two
 * different reasons, without duplicating the error:
 *
 *  - At the TOP of a handler, before anything is consumed. `/setup/redeem`
 *    commits its transaction (burning the one-time handoff code and minting the
 *    durable credential) BEFORE it builds the bundle, so a throw at bundle-build
 *    time costs the developer their single-use code and leaves an orphaned
 *    credential behind, for a fault that is entirely server-side. `/setup/enroll`
 *    likewise consumes a provisional-cap slot. Neither is recoverable by the
 *    caller, and neither needed to happen.
 *  - Inside `buildOtelBundle`, so a future third caller that forgets the early
 *    check still cannot bake an untrusted origin into a durable credential.
 *
 * The early call is the one that protects the developer; the late call is the
 * one that protects the invariant. Both are pure reads of env plus headers, so
 * calling twice costs nothing.
 */
export function assertTrustedPublicOrigin(event: H3Event): void {
  if (isPublicOriginTrusted(event)) return
  consola.error(
    { host: getPublicRequestURL(event).hostname },
    'refusing to act on an untrusted public origin; set APP_PUBLIC_ORIGIN',
  )
  throw createError({
    statusCode: 500,
    statusMessage: 'Server Misconfigured',
    data: {
      type: 'https://tokenscope.example.com/problems/server-misconfigured',
      title: 'Server Misconfigured',
      status: 500,
      detail:
        'This server cannot determine its own public origin, so it will not issue an emit credential that would point at an unreachable host. Set APP_PUBLIC_ORIGIN.',
    },
  })
}
