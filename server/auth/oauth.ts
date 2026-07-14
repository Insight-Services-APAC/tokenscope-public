/*
 * OAuth 2.1 Authorization Server core (ADR-0005 — the credential pathway).
 *
 * Ported from a sibling project's lib/oauth/* (Redis) to TokenScope's Postgres/Drizzle.
 * Provides: client register/validate (RFC 7591), PKCE S256 validate (RFC 7636),
 * auth-code issue/consume (single-use, atomic), and token issue/refresh/revoke.
 *
 * Hashing: client secrets, auth codes, and access/refresh tokens are stored
 * only as HMAC-SHA-256 hashes (hashSessionToken). The raw value is returned to
 * the client once and never persisted — same discipline as
 * instance_attestation.session_token_hash.
 *
 * Errors: throws OAuthError with an RFC 6749 string `error` code. The endpoint
 * handlers translate that into the RFC-6749 JSON body { error, error_description }
 * the MCP SDK requires (NOT the RFC-9457 problem+json our own APIs use).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken, constantTimeEqualHex } from './hmac'
import { oauthClient, oauthAuthCode, oauthToken } from '../../drizzle/schema'

// ── Scopes ────────────────────────────────────────────────────────────────
//
// A deliberately small set for the MVP: read (authenticated dashboard-style
// reads — "my projects / tags / budget"), tag (the agentic self-tag write — the
// MCP `tag_session` tool; granted ALONGSIDE read on the read credential, never on
// emit), and emit (the ingest-refresh scope ADR-0005 E1 keeps separate from read).
// Mirrors a sibling project's VALID_SCOPES but TokenScope-shaped.
export const OAUTH_SCOPES = ['tokenscope.read', 'tokenscope.tag', 'tokenscope.emit'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

export function isValidScope(s: string): s is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(s)
}

// Scopes a PUBLIC client may obtain via the interactive authorization_code flow.
// `tokenscope.emit` is DELIBERATELY excluded: the broadly-readable durable emit
// credential must NEVER be issued over the LLM-adjacent client channel — it is
// minted ONLY via the internal emit-credential path (setup exchange) and the
// provision_emit→redeem handoff (process→server). Restricting the consent flow
// here closes the second, un-isolated route to an emit credential (adversarial R1
// F1; mcp-client-backbone §"Emit-credential isolation").
export const INTERACTIVE_GRANTABLE_SCOPES: readonly string[] = ['tokenscope.read', 'tokenscope.tag']

// ── Lifetimes ───────────────────────────────────────────────────────────────
/** Auth code: 5 min, single-use (RFC 6749 recommends ≤10 min). */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000
/** Access token: 30 days (matches a sibling project's PAT-as-access-token lifetime). */
export const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Refresh token: 90 days. */
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
/**
 * Grace window for the access token a refresh supersedes (AUTH-3): the old
 * hash stays valid this long after the refresh so concurrent refreshers
 * sharing one refresh token don't invalidate each other's access tokens.
 */
export const ACCESS_TOKEN_GRACE_MS = 60 * 1000

/** OAuth error with an RFC 6749 string error code. */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

type Db = PostgresJsDatabase<Record<string, unknown>>

// ── Redirect URI validation (RFC 8252 — loopback only) ──────────────────────
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']
export function isValidRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri)
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.includes(parsed.hostname)) return true
    // Also accept 127.0.0.0/8 (RFC 8252 §7.3 allows the whole loopback range).
    if (parsed.protocol === 'http:' && /^127\.\d+\.\d+\.\d+$/.test(parsed.hostname)) return true
    return false
  } catch {
    return false
  }
}

// ── PKCE ────────────────────────────────────────────────────────────────────
/**
 * Validate a code_verifier against a stored code_challenge. S256 only.
 * Constant-time comparison on the computed challenge.
 */
export function validatePkce(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method !== 'S256') return false
  // S256: BASE64URL(SHA256(code_verifier)) === code_challenge.
  const computed = createHash('sha256').update(codeVerifier).digest('base64url')
  if (computed.length !== codeChallenge.length) return false
  return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge))
}

// ── Clients (RFC 7591) ──────────────────────────────────────────────────────
export interface RegisteredClient {
  clientId: string
  clientSecret: string
  clientName: string
  redirectUris: string[]
}

/**
 * Reserved client_name no public registrant may claim — it belongs to the
 * internal emit client. Trust rides on the `internal` column, not this name;
 * the reservation is defence-in-depth so the name can't be squatted.
 */
export const RESERVED_EMIT_CLIENT_NAME = 'tokenscope-emit'

/**
 * Coarse DoS backstop: the public registration endpoint is unauthenticated, so
 * cap the TOTAL number of oauth_client rows. A generous ceiling — real MCP
 * clients number in the low dozens; this only stops a registration-flood. No
 * Redis; a COUNT(*) per registration is cheap.
 */
export const MAX_OAUTH_CLIENTS = 1000

/**
 * Register a new dynamic PUBLIC client; returns the raw secret ONCE.
 *
 * Always writes `internal = false` — the internal emit client is created ONLY
 * by ensureEmitClient (no public path can set the flag). Rejects the reserved
 * emit client_name and enforces a registration ceiling (DoS backstop).
 */
export async function registerClient(
  db: Db,
  input: { clientName?: string; redirectUris: string[] },
): Promise<RegisteredClient> {
  if (!input.redirectUris || input.redirectUris.length === 0) {
    throw new OAuthError('invalid_client_metadata', 'At least one redirect_uri is required')
  }
  for (const uri of input.redirectUris) {
    if (!isValidRedirectUri(uri)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `Invalid redirect_uri: ${uri}. Must be loopback http:// (localhost / 127.0.0.0/8 / ::1).`,
      )
    }
  }

  const clientName = input.clientName || 'MCP Client'
  // Reserved-name guard: the internal emit client's name is off-limits to public
  // registrants (even though identity is the `internal` flag, not the name).
  if (clientName === RESERVED_EMIT_CLIENT_NAME) {
    throw new OAuthError('invalid_client_metadata', 'client_name is reserved')
  }

  // Registration cap (coarse DoS backstop on the unauthenticated endpoint).
  const countRows = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM oauth_client`,
  )
  if (Number([...countRows][0]?.count ?? 0) >= MAX_OAUTH_CLIENTS) {
    throw new OAuthError('temporarily_unavailable', 'Client registration limit reached')
  }

  const clientSecret = randomBytes(32).toString('hex')
  const [row] = await db
    .insert(oauthClient)
    .values({
      clientSecretHash: hashSessionToken(clientSecret),
      clientName,
      redirectUris: input.redirectUris,
      internal: false,
    })
    .returning({ clientId: oauthClient.clientId })

  if (!row) throw new OAuthError('server_error', 'Client registration failed')

  return { clientId: row.clientId, clientSecret, clientName, redirectUris: input.redirectUris }
}

export interface ClientRow {
  clientId: string
  clientName: string
  redirectUris: string[]
  internal: boolean
}

export async function getClient(db: Db, clientId: string): Promise<ClientRow | null> {
  // clientId is a uuid PK; a malformed (non-uuid) value would throw at the DB
  // layer. Guard so a bad client_id yields a clean null (→ invalid_client).
  if (!isUuid(clientId)) return null
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      clientName: oauthClient.clientName,
      redirectUris: oauthClient.redirectUris,
      internal: oauthClient.internal,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1)
  return row ?? null
}

/** Validate client_id + client_secret. Returns the client if valid, else null. */
export async function validateClientCredentials(
  db: Db,
  clientId: string,
  clientSecret: string,
): Promise<ClientRow | null> {
  if (!isUuid(clientId)) return null
  const [row] = await db
    .select({
      clientId: oauthClient.clientId,
      clientName: oauthClient.clientName,
      redirectUris: oauthClient.redirectUris,
      internal: oauthClient.internal,
      clientSecretHash: oauthClient.clientSecretHash,
    })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1)
  if (!row) return null
  if (!constantTimeEqualHex(hashSessionToken(clientSecret), row.clientSecretHash)) return null
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    internal: row.internal,
  }
}

// ── Authorization codes (single-use) ────────────────────────────────────────
/** Issue an auth code bound to a teammate; returns the raw code for the redirect. */
export async function issueAuthCode(
  db: Db,
  params: {
    clientId: string
    teammateId: string
    redirectUri: string
    scope: string
    codeChallenge: string
    codeChallengeMethod: string
  },
): Promise<string> {
  const code = randomBytes(32).toString('hex')
  await db.insert(oauthAuthCode).values({
    codeHash: hashSessionToken(code),
    clientId: params.clientId,
    teammateId: params.teammateId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    scope: params.scope,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  })
  return code
}

export interface ConsumedAuthCode {
  clientId: string
  teammateId: string
  redirectUri: string
  scope: string
  codeChallenge: string
  codeChallengeMethod: string
}

/**
 * Consume an auth code: atomically mark it consumed iff it was unconsumed AND
 * not expired. The `consumed_at IS NULL AND expires_at > now()` predicate +
 * RETURNING makes this a single-statement compare-and-swap — concurrent
 * exchanges of the same code see at most one success (replay-safe).
 */
export async function consumeAuthCode(db: Db, rawCode: string): Promise<ConsumedAuthCode | null> {
  const codeHash = hashSessionToken(rawCode)
  const rows = await db.execute<{
    client_id: string
    teammate_id: string
    redirect_uri: string
    scope: string
    code_challenge: string
    code_challenge_method: string
  }>(sql`
    UPDATE oauth_auth_code
       SET consumed_at = now()
     WHERE code_hash = ${codeHash}
       AND consumed_at IS NULL
       AND expires_at > now()
    RETURNING client_id::text AS client_id,
              teammate_id::text AS teammate_id,
              redirect_uri,
              scope,
              code_challenge,
              code_challenge_method
  `)
  const row = [...rows][0]
  if (!row) return null
  return {
    clientId: row.client_id,
    teammateId: row.teammate_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
  }
}

// ── Tokens ──────────────────────────────────────────────────────────────────
export interface IssuedTokens {
  access_token: string
  token_type: 'bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

/** Issue an access + refresh token pair for an authorized teammate. */
export async function issueTokens(
  db: Db,
  params: { teammateId: string; clientId: string; scope: string },
): Promise<IssuedTokens> {
  const scopeArray = params.scope ? params.scope.split(' ').filter(Boolean) : []
  if (scopeArray.length === 0) {
    throw new OAuthError('invalid_scope', 'At least one scope is required')
  }
  // Defence in depth — the scope string was validated at /authorize but
  // re-validate here in case the stored code was tampered with.
  const invalid = scopeArray.filter((s) => !isValidScope(s))
  if (invalid.length > 0) {
    throw new OAuthError('invalid_scope', `Invalid scope(s): ${invalid.join(', ')}`)
  }

  const accessToken = randomBytes(32).toString('base64url')
  const refreshToken = randomBytes(32).toString('base64url')
  const now = Date.now()

  await db.insert(oauthToken).values({
    accessTokenHash: hashSessionToken(accessToken),
    refreshTokenHash: hashSessionToken(refreshToken),
    clientId: params.clientId,
    teammateId: params.teammateId,
    scope: params.scope,
    accessIssuedAt: new Date(now),
    accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
    refreshIssuedAt: new Date(now),
    refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
  })

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: params.scope,
  }
}

/**
 * Refresh: NON-ROTATING (ADR-0005). Re-mint a fresh ACCESS token IN PLACE on the
 * existing oauth_token row, keeping the SAME refresh token live and reusable
 * across cycles. Revocation — not rotation — is the control: the row's
 * revoked_at (explicit revoke, or the E2 teammate-revocation cascade) is what
 * kills a refresh, never the act of using it.
 *
 * This is the durable-emission fix: the headless emit helper re-presents the
 * same env refresh token every ~29min; a rotating scheme would invalidate it on
 * the first refresh and recreate the silent-death. The returned `refresh_token`
 * is the SAME one the caller presented (echoed for RFC-6749 conformance).
 *
 * Atomicity + checks in ONE UPDATE (compare-and-swap on the matched row):
 *   - refresh_token_hash matches, row live (revoked_at IS NULL), not expired,
 *     owned by this client_id;
 *   - E2 (ADR-0005): the bound teammate must NOT have been revoked at/after the
 *     refresh credential was granted (teammate.revoked_at > oauth_token.refresh_issued_at)
 *     — a revoked teammate can no longer mint fresh access tokens via refresh.
 *     refresh_issued_at (not the per-refresh-bumped access_issued_at) is the
 *     stable anchor. The join is in the UPDATE so the race is closed in-statement.
 * No match ⇒ invalid_grant (replayed/expired/revoked refresh, or revoked teammate).
 */
export async function refreshAccessToken(
  db: Db,
  refreshToken: string,
  clientId: string,
): Promise<IssuedTokens> {
  const refreshHash = hashSessionToken(refreshToken)
  const newAccessToken = randomBytes(32).toString('base64url')
  const now = Date.now()
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_MS)
  const accessIssuedAt = new Date(now)

  // Re-issue ONLY the access token (hash + issued/expiry) on the existing row.
  // The refresh token row stays live; we do NOT revoke it and do NOT rotate it.
  // The OUTGOING hash is parked one-deep in prev_access_token_hash with a ~60 s
  // grace horizon (mig 0044, AUTH-3): concurrent refreshers sharing this refresh
  // token (one instance per host) would otherwise invalidate each other's access
  // tokens in a ping-pong. SET expressions read the OLD row values, so
  // `prev_access_token_hash = t.access_token_hash` captures the superseded hash.
  const rows = await db.execute<{ teammate_id: string; scope: string }>(sql`
    UPDATE oauth_token t
       SET prev_access_token_hash = t.access_token_hash,
           prev_valid_until  = now() + make_interval(secs => ${ACCESS_TOKEN_GRACE_MS / 1000}),
           access_token_hash = ${hashSessionToken(newAccessToken)},
           access_issued_at  = ${accessIssuedAt.toISOString()},
           access_expires_at = ${accessExpiresAt.toISOString()},
           last_used_at      = now()
      FROM teammate tm
     WHERE t.teammate_id = tm.id
       AND t.refresh_token_hash = ${refreshHash}
       AND t.revoked_at IS NULL
       AND t.refresh_expires_at > now()
       AND t.client_id = ${clientId}::uuid
       AND NOT (tm.revoked_at IS NOT NULL AND tm.revoked_at > t.refresh_issued_at)
    RETURNING t.teammate_id::text AS teammate_id, t.scope AS scope
  `)
  const row = [...rows][0]
  if (!row) {
    throw new OAuthError('invalid_grant', 'Refresh token is invalid, expired, or revoked')
  }

  return {
    access_token: newAccessToken,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: row.scope,
  }
}

/**
 * Revoke a refresh token (RFC 7009). Idempotent and silent — revokes the row if
 * one matches; otherwise no-op. The endpoint always returns 200 regardless.
 */
export async function revokeRefreshToken(db: Db, refreshToken: string, clientId: string): Promise<void> {
  const refreshHash = hashSessionToken(refreshToken)
  // RFC 7009 §2.1: a client may only revoke a token issued TO IT. Bind the
  // revoke to the authenticated client so a registered client can't revoke
  // another client's token even if it learns the raw value (R2 LOW).
  await db
    .update(oauthToken)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthToken.refreshTokenHash, refreshHash),
        eq(oauthToken.clientId, clientId),
        isNull(oauthToken.revokedAt),
      ),
    )
}

// ── helpers ──────────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}
