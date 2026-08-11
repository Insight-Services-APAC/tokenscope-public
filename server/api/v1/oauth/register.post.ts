/*
 * Dynamic Client Registration — RFC 7591.
 *
 * MCP clients (Claude Code) call this to register before the OAuth flow. No
 * user session required — the endpoint is the entry point of the flow. Returns
 * the RFC 6749 OAuth error shape { error, error_description } on failure (the
 * MCP SDK requires a string `error`), NOT TokenScope's RFC-9457 problem+json.
 *
 * NOTE: no assertSameOrigin here — this is a programmatic (non-browser) OAuth
 * endpoint hit by a CLI, so the cookie-CSRF threat model doesn't apply.
 */
import { defineEventHandler, readValidatedBody, getRequestIP, setResponseHeaders, setResponseStatus } from 'h3'
import { consola } from 'consola'
import { registerClient, OAuthError } from '../../../auth/oauth'
import { recordAuditEvent } from '../../../db/audit'
import { getDb } from '../../../db'
import { registrationRequestSchema } from '../../../../shared/schemas/oauth'

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })

  let body
  try {
    body = await readValidatedBody(event, (d) => registrationRequestSchema.parse(d))
  } catch {
    setResponseStatus(event, 400)
    return { error: 'invalid_client_metadata', error_description: 'Invalid registration request' }
  }

  const db = getDb()
  // Source key for the per-source registration ceiling (S6 Ceiling fix) — same
  // best-effort IP capture as setup/enroll.post.ts; never crashes registration.
  let ip: string | null
  try {
    ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  } catch {
    ip = null
  }
  try {
    const client = await registerClient(db, {
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      source: ip ?? 'unknown',
    })

    await recordAuditEvent(db, {
      eventType: 'oauth_client_register',
      actorSystem: 'oauth',
      subjectKind: 'oauth_client',
      payload: {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
      },
    })

    setResponseStatus(event, 201)
    return {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'client_secret_post',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Bounded (S6) — see MAX_CLIENT_SECRET_AGE_MS; enforced in
      // validateClientCredentials against the client row's own created_at.
      client_secret_expires_at: client.clientSecretExpiresAt,
    }
  } catch (err) {
    if (err instanceof OAuthError) {
      // The registration cap surfaces as a 429 (Too Many Requests) — a coarse
      // DoS backstop, distinct from a 400 client-metadata error.
      const status = err.code === 'temporarily_unavailable' ? 429 : 400
      setResponseStatus(event, status)
      return { error: err.code, error_description: err.message }
    }
    consola.error('[oauth:register] failed', err instanceof Error ? err.message : err)
    setResponseStatus(event, 500)
    return { error: 'server_error', error_description: 'Registration failed. Please try again.' }
  }
})
