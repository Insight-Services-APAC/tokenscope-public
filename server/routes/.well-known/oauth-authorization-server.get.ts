/*
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * Lets MCP clients (Claude Code) discover the authorization, token,
 * registration, and revocation endpoints dynamically. No auth required.
 *
 * MUST live under server/routes/ (NOT server/api/) — RFC 8414 requires the
 * path at the origin root. Nitro serves server/api/ under /api/ and
 * server/routes/ under /. (See a sibling project's handler.ts note re: a staging
 * outage from getting this wrong.)
 */
import { defineEventHandler, setResponseHeaders } from 'h3'
import { OAUTH_SCOPES } from '../../auth/oauth'
import { getPublicRequestURL } from '../../utils/public-url'

export default defineEventHandler((event) => {
  // PUBLIC origin (Front Door host behind AFD), NOT the rewritten CA FQDN —
  // else discovered endpoints point at the internal origin that 500s on a
  // direct hit (require-front-door). Same fix as exchange.post.ts's endpoints.
  const origin = getPublicRequestURL(event).origin

  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  })

  return {
    issuer: origin,
    // The GET authorize handler (server/api/v1/oauth/authorize.get.ts) gates the
    // Entra session + validates client/redirect_uri, then 302s the browser to the
    // CONSENT PAGE (app/pages/oauth/authorize.vue) — it no longer auto-approves;
    // the page shows the scopes + Approve/Deny and POSTs to authorize.post, which
    // issues the code. (Mirrors a sibling project's GET-page + POST-grant split.)
    authorization_endpoint: `${origin}/api/v1/oauth/authorize`,
    token_endpoint: `${origin}/api/v1/oauth/token`,
    registration_endpoint: `${origin}/api/v1/oauth/register`,
    revocation_endpoint: `${origin}/api/v1/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: [...OAUTH_SCOPES],
  }
})
