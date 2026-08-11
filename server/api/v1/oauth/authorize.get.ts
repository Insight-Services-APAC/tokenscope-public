/*
 * OAuth 2.1 Authorization Endpoint (RFC 6749 §4.1.1) with PKCE (RFC 7636).
 *
 * The MCP client (Claude Code) redirects the user's browser here. We reuse
 * TokenScope's existing Entra OIDC session as the "user":
 *   - Unauthenticated  → redirect to the Entra login, preserving this URL so
 *     the user returns here post-login (no separate OAuth login page).
 *   - Authenticated    → validate client + redirect_uri + PKCE, issue an auth
 *     code bound to session.teammateId, and redirect to redirect_uri with
 *     code + state.
 *
 * This GET is the AS-metadata `authorization_endpoint` the browser lands on. It
 * gates auth (Entra session) + validates client/redirect_uri, then HANDS OFF to
 * the consent PAGE (`app/pages/oauth/authorize.vue`) — it no longer auto-issues a
 * code. The page shows the requested scopes + Approve/Deny and POSTs to
 * `authorize.post` (which issues the teammate-bound, PKCE-carried code and returns
 * `{ redirect_url }` for the loopback/paste-back delivery). The auto-approve +
 * direct-302-with-code path is GONE — consent is now explicit (the headless
 * integration tests drive `authorize.post` with `action:approve`).
 *
 * Validation order matters: client + redirect_uri are validated BEFORE any
 * redirect, to prevent open-redirect via a crafted error. Errors that CANNOT
 * safely redirect (bad/unknown client or redirect_uri) are returned as OAuth JSON.
 *
 * `Accept: application/json` (S6): the consent page is a directly-navigable
 * Nuxt route, so `route.query` there is exactly as caller-controlled as this
 * endpoint's OWN query params — a client_name shown on the page could never be
 * trusted if it were just echoed back as another query param on the redirect.
 * Instead the page calls straight back into THIS handler (server-verified
 * cookie session forwarded via useRequestFetch, same as useSession.ts) once
 * client + redirect_uri are validated, and gets the DB row's client_name +
 * the matched redirect_uri's host + the effective granted scope set as JSON —
 * never derived from route.query. See app/pages/oauth/authorize.vue.
 */
import {
  defineEventHandler,
  getValidatedQuery,
  getRequestURL,
  getRequestHeader,
  sendRedirect,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { consola } from 'consola'
import { tryAuth } from '../../../utils/auth'
import { getClient, computeGrantedScopes } from '../../../auth/oauth'
import { getDb } from '../../../db'
import { authorizeQuerySchema } from '../../../../shared/schemas/oauth'

function oauthJsonError(event: H3Event, code: string, detail: string, status = 400) {
  setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  setResponseStatus(event, status)
  return { error: code, error_description: detail }
}

function wantsJson(event: H3Event): boolean {
  return (getRequestHeader(event, 'accept') || '').includes('application/json')
}

export default defineEventHandler(async (event) => {
  // Parse query first so we can preserve it across the login bounce. If the
  // query itself is malformed we can't safely do anything but return JSON.
  let q
  try {
    q = await getValidatedQuery(event, (d) => authorizeQuerySchema.parse(d))
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : 'Invalid authorization request parameters'
    return oauthJsonError(event, 'invalid_request', detail)
  }

  // response_type must be 'code' (RFC 6749) when present.
  if (q.response_type && q.response_type !== 'code') {
    return oauthJsonError(event, 'unsupported_response_type', 'Only response_type=code is supported')
  }

  // Auth gate — reuse the existing Entra session. Unauthenticated ⇒ bounce to
  // login, preserving the full authorize URL so the user lands back here. The
  // consent page's own info fetch (Accept: application/json) can't be bounced
  // through a browser redirect — it gets a clean JSON error instead.
  const session = await tryAuth(event)
  if (!session) {
    if (wantsJson(event)) {
      return oauthJsonError(event, 'login_required', 'Sign in required', 401)
    }
    const returnTo = getRequestURL(event).pathname + getRequestURL(event).search
    // nuxt-oidc-auth login route for the default provider. The module's post-login
    // return target is `callbackRedirectUrl` (login.get.js stores it in the session)
    // — NOT `redirect`, which it silently ignores (→ falls to the configured default
    // `/`, i.e. home: the bug seen in the live flow). The module's OWN bug (#149)
    // would clear the session before the callback reads it, but we already PATCH that
    // (patches/nuxt-oidc-auth+1.0.0-beta.11.patch reads the value before session.clear),
    // so the native callbackRedirectUrl survives — no cookie/middleware hack needed.
    // Its sanitizer requires a path starting with `/` but not `//`; our authorize path
    // satisfies that. (Honoured because the entra provider config does not pin
    // callbackRedirectUrl — a configured value would override this per-request one.)
    const loginUrl = `/auth/entra/login?callbackRedirectUrl=${encodeURIComponent(returnTo)}`
    return sendRedirect(event, loginUrl, 302)
  }

  const db = getDb()

  // Validate the client + redirect_uri BEFORE any redirect to redirect_uri.
  const client = await getClient(db, q.client_id)
  if (!client) {
    return oauthJsonError(event, 'invalid_client', 'Unknown client_id')
  }
  if (!client.redirectUris.includes(q.redirect_uri)) {
    return oauthJsonError(
      event,
      'invalid_request',
      'redirect_uri does not match any registered redirect URIs',
    )
  }

  // The consent page's own info fetch (S6 Consent (a)/(b)): server-verified
  // client_name + the MATCHED redirect_uri's host + the effective granted
  // scope set, returned as DATA rather than a redirect. computeGrantedScopes
  // is the SAME filter authorize.post.ts applies to actually issue the grant
  // — this display and that grant can never drift.
  if (wantsJson(event)) {
    setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return {
      client_name: client.clientName,
      redirect_host: new URL(q.redirect_uri).host,
      granted_scopes: computeGrantedScopes(q.scope),
    }
  }

  // Client + redirect_uri are validated → HAND OFF to the consent PAGE. The
  // browser lands on app/pages/oauth/authorize.vue, which shows the requested
  // scopes + Approve/Deny and POSTs the decision to authorize.post (which issues
  // the teammate-bound, PKCE-carried code). Preserve the EXACT query so the page
  // (and its POST) carry the PKCE challenge / scope / state through unchanged.
  consola.info('[oauth:authorize] handoff to consent page', {
    clientId: client.clientId,
    teammateId: session.teammateId,
  })
  return sendRedirect(event, `/oauth/authorize${getRequestURL(event).search}`, 302)
})
