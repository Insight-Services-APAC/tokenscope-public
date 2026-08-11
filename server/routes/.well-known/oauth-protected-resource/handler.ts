/*
 * Shared handler for OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Used by both the index and catch-all routes (RFC 9728 supports path-aware
 * discovery, e.g. /.well-known/oauth-protected-resource/api/mcp). Points MCP
 * clients at this authorization server.
 *
 * MUST live under server/routes/ (NOT server/api/) — RFC 9728 requires the
 * path at the origin root, and Nitro production builds only serve server/api/
 * under /api/. (a sibling project lost staging to exactly this — see their PR #198.)
 */
import { setResponseHeaders, type H3Event } from 'h3'
import { OAUTH_SCOPES } from '../../../auth/oauth'
import { getPublicRequestURL } from '../../../utils/public-url'

export function handleProtectedResourceMetadata(event: H3Event) {
  // PUBLIC (Front Door) origin, not the rewritten CA FQDN — see the AS metadata.
  const origin = getPublicRequestURL(event).origin

  setResponseHeaders(event, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
    // Same reasoning as the AS metadata handler: `resource` and
    // `authorization_servers` are resolved from the forwarded host/proto,
    // so a shared cache MUST key on them too, or one caller's resolved
    // origin can be served to another — cache poisoning.
    Vary: 'X-Forwarded-Host, X-Forwarded-Proto, Host',
    'Access-Control-Allow-Origin': '*',
  })

  return {
    // The protected MCP resource lives under /api/v1/mcp (built in the next
    // slice); the metadata is advertised now so discovery is wired ahead of it.
    resource: `${origin}/api/v1/mcp`,
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  }
}
