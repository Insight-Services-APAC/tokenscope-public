/*
 * Origin-header CSRF check for state-changing requests.
 *
 * Threat model: a malicious page in a victim's browser POSTs to our
 * endpoint using the victim's session cookie. The session cookie has
 * `sameSite: 'lax'` which blocks cross-site XHR but NOT top-level form
 * POSTs. This helper closes that gap by verifying the Origin (or
 * Referer fallback) on every state-changing method.
 *
 * Behaviour (per `checkOriginPolicy()` below):
 *   - Origin present AND mismatched → reject (browser CSRF attempt)
 *   - Origin present AND matches    → allow (same-origin browser)
 *   - Origin absent AND Referer present → check Referer's origin
 *   - Both absent → ALLOW (server-to-server / CLI / curl don't ride a
 *     stolen browser cookie, so they aren't the CSRF vector)
 *
 * The pure `checkOriginPolicy` function is exported separately so it's
 * testable without an h3 event mock; `assertSameOrigin` is the thin
 * h3-aware wrapper handlers call.
 */
import { createError, getHeader, type H3Event } from 'h3'
import { getPublicRequestURL } from '../utils/public-url'

export type OriginPolicyResult =
  | { ok: true }
  | { ok: false; presented: string; expected: string }

export function checkOriginPolicy(opts: {
  method: string
  expectedOrigin: string
  origin?: string | null
  referer?: string | null
}): OriginPolicyResult {
  const method = opts.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return { ok: true }
  }

  let presented: string | null = null
  if (opts.origin) {
    presented = opts.origin
  } else if (opts.referer) {
    try {
      presented = new URL(opts.referer).origin
    } catch {
      presented = null
    }
  }

  if (presented !== null && presented !== opts.expectedOrigin) {
    return { ok: false, presented, expected: opts.expectedOrigin }
  }
  return { ok: true }
}

export function assertSameOrigin(event: H3Event): void {
  // expectedOrigin is the PUBLIC origin, resolved by the single chokepoint
  // getPublicRequestURL: a pinned APP_PUBLIC_ORIGIN (proxy-fronted custom
  // hostname, e.g. the IT dev zone) wins, else the AFD-forwarded host (gated
  // on AZURE_FRONT_DOOR_ID so X-Forwarded-* can't be forged), else the
  // request's own Host. Routing CSRF through the same function keeps the
  // cross-origin check, the bearer/OTLP endpoints, and the OAuth metadata in
  // agreement about who we are.
  const result = checkOriginPolicy({
    method: event.method,
    expectedOrigin: getPublicRequestURL(event).origin,
    origin: getHeader(event, 'origin'),
    referer: getHeader(event, 'referer'),
  })
  if (!result.ok) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Cross-origin request rejected',
      data: {
        type: 'https://tokenscope.example.com/errors/csrf',
        title: 'Cross-origin request rejected',
        status: 403,
        detail:
          'State-changing request from a different origin was rejected. ' +
          `Expected ${result.expected}, got ${result.presented}.`,
      },
    })
  }
}
