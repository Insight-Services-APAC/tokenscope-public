/*
 * Catch-all handler for /api/v1/mcp/* — TokenScope MCP server over the MCP
 * Streamable HTTP transport.
 *
 * Auth: OAuth 2.1 bearer (server/auth/oauth-bearer.ts), scope `tokenscope.read`.
 * The path matches the `resource` advertised by the protected-resource metadata
 * (/.well-known/oauth-protected-resource → resource: <origin>/api/v1/mcp), so an
 * MCP client that 401s here discovers the OAuth flow via the WWW-Authenticate
 * resource_metadata pointer (RFC 9728) and re-authenticates against this same
 * authorization server.
 *
 * Failure semantics (matching the brief + RFC 6750/9728/6749):
 *   - missing / invalid / expired / revoked bearer → 401 with
 *     WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
 *     (this is what tells the MCP client it must OAuth).
 *   - valid bearer but missing `tokenscope.read` scope → 403 insufficient_scope.
 *
 * A fresh McpServer is built per request (stateless transport): the SDK's
 * Protocol.connect() throws if the server is already bound to a transport.
 */
import {
  defineEventHandler,
  createError,
  setResponseHeader,
  getRequestHeader,
  readBody,
  setResponseStatus,
  type H3Event,
} from 'h3'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import consola from 'consola'
import { requireOAuthBearer } from '../../../auth/oauth-bearer'
import { createMcpServer, MCP_READ_SCOPE } from '../../../utils/mcp'
import {
  getPublicRequestURL,
  isPublicOriginTrusted,
  selfAddressableHosts,
  isSelfAddressableHost,
} from '../../../utils/public-url'

const logger = consola.withTag('api-mcp')

/** RFC 9728 — point the MCP client at the protected-resource metadata document. */
function challenge(event: H3Event): void {
  // PUBLIC (Front Door) origin so the client's discovery + re-auth hit the
  // reachable host, not the internal CA FQDN.
  const origin = getPublicRequestURL(event).origin
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`
  setResponseHeader(event, 'WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"`)
}

export default defineEventHandler(async (event) => {
  // 0. Host allowlist — DNS-rebinding protection, BEFORE authentication.
  //
  // The allowlist is "every hostname this app is legitimately served under",
  // which is NOT the same question as "what hostname did the client type":
  //
  //   • publicUrl.host        — the public hostname (pinned APP_PUBLIC_ORIGIN,
  //                             else the Front Door host, else our own Host).
  //   • platformSelfHosts()   — the Container Apps app-level and revision-level
  //                             FQDNs. ANY fronting proxy may rewrite Host to
  //                             the backend address, and CA ingress requires it
  //                             (it routes on Host). See public-url.ts.
  //   • the raw Host          — additionally trusted behind Front Door, where
  //                             require-front-door middleware has already
  //                             rejected anything without a matching X-Azure-FDID.
  //
  // The first version shipped with only the first and third, assuming Front Door
  // is the only thing that rewrites Host. Dev is fronted by IT's zone WAF with
  // NO Front Door, so that gate was false, the raw Host was the CA FQDN, and
  // EVERY MCP request 403'd with `Invalid Host header` — MCP dead on dev.
  //
  // WHY BEFORE AUTH. Behind the bearer check this rejection was invisible to
  // anything without a valid OAuth token, and CI cannot hold one — nor can it
  // even reach dev (deploy.yml's health check exits UNVERIFIED because the
  // runner resolves neither the internal CA FQDN nor the WAF host). So the only
  // post-deploy check available is an UNAUTHENTICATED one, run from a network
  // that can reach the target. Ordered first, `401` vs `403` separates
  // "transport reachable, Host accepted" from "this deployment's Host is not in
  // the allowlist" with no credential at all — which is what
  // scripts/verify-mcp-endpoint.sh asserts. A legitimate client never sees this
  // branch; it is dialling a host we answer to by definition.
  //
  // Why widening this is not a weakening: the Host allowlist defends against DNS
  // rebinding, an attack on AMBIENT authority — a browser tricked into
  // addressing an internal service it can reach but the attacker cannot. This
  // endpoint has no ambient authority to steal: it is bearer-only (no cookies),
  // so a rebound browser request carries no credential, and a cross-origin
  // fetch cannot attach Authorization without the token.
  const publicUrl = getPublicRequestURL(event)
  const behindFrontDoor = Boolean(process.env.AZURE_FRONT_DOOR_ID)
  const rawHost = getRequestHeader(event, 'host')
  const allowedHosts = selfAddressableHosts({
    publicHost: publicUrl.host,
    rawHost,
    behindFrontDoor,
  })
  if (!isSelfAddressableHost(allowedHosts, rawHost)) {
    // The SDK's own rejection leaves NOTHING in our logs (its onerror hook is
    // unset), which is how the dev outage cost an investigation instead of a
    // grep. Say it plainly, with both sides of the comparison — but TRUNCATE
    // the caller's value: this branch is reachable unauthenticated, so an
    // unbounded attacker-chosen string would be a log-flooding primitive.
    const shown = (rawHost ?? '(absent)').slice(0, 120)
    logger.warn(
      `MCP request rejected: Host "${shown}" is not in the allowlist [${allowedHosts.join(', ')}]. ` +
        'If this host is legitimate, the deployment is fronted by a proxy this app does not know it is behind.',
    )
    setResponseStatus(event, 403)
    // Byte-compatible with the SDK's own createJsonErrorResponse(403, -32000),
    // so moving the check earlier changes WHEN a client is told, never WHAT.
    return {
      jsonrpc: '2.0',
      error: { code: -32000, message: `Invalid Host header: ${shown}` },
      id: null,
    }
  }

  // 1. Authenticate the bearer (no scope arg — we want to distinguish
  //    unauthenticated (401) from authenticated-but-unscoped (403) ourselves).
  //    NO requiredInstanceId either — this is the ONE deliberately-excluded
  //    caller of requireOAuthBearer's per-device binding check (fix 1's other
  //    four consumers are the /instances/{instanceId}/* handlers). The MCP
  //    surface is read-scoped and instance-agnostic by design: a read/tag
  //    token is NULL-bound by construction (mig 0031 only ever binds
  //    tokenscope.emit credentials), so passing an instance id here would
  //    just never match anything — there is no "this MCP call is FOR
  //    instance X" concept to bind against.
  let teammate
  try {
    teammate = await requireOAuthBearer(event)
  } catch {
    // requireOAuthBearer already set an RFC 6750 WWW-Authenticate header; replace
    // it with the RFC 9728 resource_metadata form the MCP client needs to start
    // the OAuth flow, and surface the 401.
    challenge(event)
    throw createError({ statusCode: 401, statusMessage: 'AUTH_REQUIRED' })
  }

  // 2. Scope check — `tokenscope.read` required. Insufficient scope is a 403
  //    (the token is valid; it just can't do this), per RFC 6750 §3.1.
  const granted = teammate.scope ? teammate.scope.split(' ').filter(Boolean) : []
  if (!granted.includes(MCP_READ_SCOPE)) {
    setResponseHeader(
      event,
      'WWW-Authenticate',
      `Bearer error="insufficient_scope", scope="${MCP_READ_SCOPE}"`,
    )
    throw createError({
      statusCode: 403,
      statusMessage: 'SCOPE_INSUFFICIENT',
      message: `Token requires the '${MCP_READ_SCOPE}' scope`,
    })
  }

  // 3. Fresh server + stateless transport per request. The SDK re-checks the
  //    same allowlist (defence in depth — step 0 is ours, this is the
  //    transport's own); Origin is checked only when the header is present
  //    (browsers; MCP clients are typically not browsers, so its absence is
  //    expected and allowed).
  // Pass the origin ONLY when it is operator-controlled. Unpinned and not
  // behind Front Door, `publicUrl.host` comes from the caller's own `Host`
  // header, and the origin's use here is not cosmetic: it becomes the
  // destination the developer's machine POSTs a one-time emit-handoff code to.
  // Degrade to a relative redeem URL rather than name a host we were told to
  // name (isPublicOriginTrusted's docstring carries the full reasoning).
  const mcpServer = createMcpServer(
    undefined,
    isPublicOriginTrusted(event) ? publicUrl.origin : undefined,
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — each request is independent
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins: [publicUrl.origin],
  })

  // The MCP SDK reads req.auth and threads it to tools via extra.authInfo. Pack
  // the resolved teammate so tools never re-parse the Authorization header.
  // clientId is the REAL registered OAuth client that minted this credential
  // (requireOAuthBearer now selects oauth_token.client_id) — previously
  // hardcoded to the literal 'tokenscope', so no audit row could ever name
  // the driving client. Falls back to that same literal only for the
  // defensive case of a null clientId (never happens on a live row —
  // oauth_token.client_id is NOT NULL — but BearerTeammate types it nullable).
  const req = event.node.req as typeof event.node.req & { auth?: AuthInfo }
  req.auth = {
    token: '',
    clientId: teammate.clientId ?? 'tokenscope',
    scopes: granted,
    extra: { teammate },
  }

  try {
    await mcpServer.connect(transport)
    await transport.handleRequest(
      req,
      event.node.res,
      req.method === 'POST' ? await readBody(event) : undefined,
    )
  } catch (err) {
    logger.error('MCP request failed', {
      error: err instanceof Error ? err.message : String(err),
      teammateId: teammate.teammateId,
    })
    throw createError({
      statusCode: 500,
      statusMessage: 'MCP_ERROR',
      data: { message: 'MCP request processing failed' },
    })
  }
})
