import { getRequestURL, type H3Event } from 'h3'

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
 *    host injection.
 *
 * 3. Otherwise the request's own Host (local dev, no proxy).
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
  return getRequestURL(event, { xForwardedHost: behindFrontDoor, xForwardedProto: behindFrontDoor })
}
