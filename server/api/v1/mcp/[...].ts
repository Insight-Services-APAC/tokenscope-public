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
  readBody,
  type H3Event,
} from 'h3'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import consola from 'consola'
import { requireOAuthBearer } from '../../../auth/oauth-bearer'
import { createMcpServer, MCP_READ_SCOPE } from '../../../utils/mcp'
import { getPublicRequestURL } from '../../../utils/public-url'

const logger = consola.withTag('api-mcp')

/** RFC 9728 — point the MCP client at the protected-resource metadata document. */
function challenge(event: H3Event): void {
  // PUBLIC (Front Door) origin so the client's discovery + re-auth hit the
  // reachable host, not the internal CA FQDN.
  const origin = getPublicRequestURL(event).origin
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource`
  setResponseHeader(
    event,
    'WWW-Authenticate',
    `Bearer resource_metadata="${resourceMetadataUrl}"`,
  )
}

export default defineEventHandler(async (event) => {
  // 1. Authenticate the bearer (no scope arg — we want to distinguish
  //    unauthenticated (401) from authenticated-but-unscoped (403) ourselves).
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

  // 3. Fresh server + stateless transport per request.
  const mcpServer = createMcpServer()
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — each request is independent
  })

  // The MCP SDK reads req.auth and threads it to tools via extra.authInfo. Pack
  // the resolved teammate so tools never re-parse the Authorization header.
  const req = event.node.req as typeof event.node.req & { auth?: AuthInfo }
  req.auth = {
    token: '',
    clientId: 'tokenscope',
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
