/*
 * Emit-credential issuance (ADR-0005 slice 2b — durable emission auth).
 *
 * The MCP provision_emit → /api/v1/setup/redeem flow mints an OAuth
 * **emit-scoped** credential for the teammate (issueEmitCredential, called via
 * emit-provision::issueInstanceEmitCredential). The plugin helper persists the
 * refresh token and runs the refresh_token grant against /api/v1/oauth/token to
 * obtain short-lived access tokens, which it presents to /bearer (auth-only;
 * emission stays direct-to-Azure). The legacy setup-token exchange + per-instance
 * session token were removed in the OAuth/MCP cutover.
 *
 * Design notes:
 *   - We REUSE the OAuth lib (issueTokens) rather than hand-rolling token
 *     hashing — the oauth_token row is identical to one minted via the
 *     interactive authorization_code flow, so requireOAuthBearer +
 *     refreshAccessToken work unchanged.
 *   - The credential carries scope `tokenscope.emit` ONLY (ADR-0005 E1 — the
 *     emit credential never carries the user's read scopes).
 *   - All emit credentials hang off a single internal **public** OAuth client
 *     ("tokenscope-emit"). It is public (no usable secret) because the headless
 *     helper has no place to safely hold a client secret beyond the refresh
 *     token itself; the token endpoint treats this one client_id as public for
 *     the refresh_token grant. Auth strength rides on the refresh token (a
 *     32-byte secret, HMAC-hashed at rest) + the E2 revocation cascade, not on
 *     a shared client secret. See server/api/v1/oauth/token.post.ts.
 */
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken } from './hmac'
import { issueTokens, type IssuedTokens } from './oauth'
import { oauthClient } from '../../drizzle/schema'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * Reserved client_name for the internal emit client. Public /oauth/register
 * REJECTS this name so a registrant can never present it. (Identity/trust is the
 * `internal` column, NOT the name — this reservation is defence-in-depth.)
 */
export const EMIT_CLIENT_NAME = 'tokenscope-emit'

/**
 * Ensure the internal public emit client exists and return its client_id.
 * Idempotent: a single shared row is reused across all instances/teammates.
 *
 * Identity is the server-controlled `internal = TRUE` flag (a partial unique
 * index guarantees at most one such row), NOT the free-form client_name — an
 * attacker who registers a client named 'tokenscope-emit' via the public
 * endpoint gets internal = FALSE and is never treated as the emit client.
 *
 * The client is "public" — it has no recoverable secret. We still write a
 * client_secret_hash column (NOT NULL) so the schema is satisfied, but it is the
 * hash of a fresh random value that is discarded immediately and never returned,
 * so client_secret_post can never succeed for this client. The refresh_token
 * grant for this client is handled as a public-client path in the token endpoint.
 */
export async function ensureEmitClient(db: Db): Promise<string> {
  const existing = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.internal, true))
    .limit(1)
  if (existing[0]) return existing[0].clientId

  // No usable secret: hash a discarded random value. redirect_uris is NOT NULL
  // but unused for the headless refresh grant — a loopback placeholder satisfies
  // the column without enabling any interactive redirect for this client.
  // onConflictDoNothing on the partial unique index (internal = TRUE) makes this
  // race-safe: two concurrent first-time exchanges can't both insert — the loser
  // gets an empty return and re-selects the winner's row (R2 LOW: TOCTOU 500).
  const [row] = await db
    .insert(oauthClient)
    .values({
      clientSecretHash: hashSessionToken(randomBytes(32).toString('hex')),
      clientName: EMIT_CLIENT_NAME,
      redirectUris: ['http://127.0.0.1/__tokenscope_emit_unused__'],
      internal: true,
    })
    .onConflictDoNothing()
    .returning({ clientId: oauthClient.clientId })

  if (row) return row.clientId

  // Lost the race — the other caller created it; re-select.
  const [winner] = await db
    .select({ clientId: oauthClient.clientId })
    .from(oauthClient)
    .where(eq(oauthClient.internal, true))
    .limit(1)
  if (!winner) throw new Error('Failed to provision the internal emit OAuth client')
  return winner.clientId
}

export interface EmitCredential {
  clientId: string
  tokens: IssuedTokens
}

/**
 * Mint an emit-scoped OAuth credential for a teammate. Returns the client_id and
 * the issued access+refresh token pair. Only the refresh token is durable +
 * persisted by the client; the access token is short-lived and re-minted via the
 * refresh_token grant.
 */
export async function issueEmitCredential(db: Db, teammateId: string): Promise<EmitCredential> {
  const clientId = await ensureEmitClient(db)
  const tokens = await issueTokens(db, {
    teammateId,
    clientId,
    scope: 'tokenscope.emit',
  })
  return { clientId, tokens }
}
