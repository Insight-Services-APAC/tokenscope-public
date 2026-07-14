/*
 * requireOAuthBearer — validate an incoming `Authorization: Bearer <token>`
 * against oauth_token, returning the bound teammate.
 *
 * This is what protected emission/read endpoints (the next slice) gate on. The
 * checks, in order:
 *   1. Bearer header present + parseable.
 *   2. Token hash matches a live oauth_token row (not revoked, not expired).
 *   3. Optional required scope is present in the granted scope set.
 *   4. ADR-0005 E2 revocation cascade: the bound teammate must NOT have been
 *      revoked AFTER the token was issued (teammate.revoked_at > access_issued_at),
 *      AND must still exist. This is the emit-path analogue of isRevoked() —
 *      `bearer.get.ts` historically never checked teammate.revoked_at.
 *
 * On any failure it throws a 401 createError carrying a WWW-Authenticate header
 * (RFC 6750 §3) so MCP clients can re-initiate the OAuth flow. The error `data`
 * body follows TokenScope's RFC-9457 problem+json (this is OUR protected API,
 * not an OAuth token/authorize endpoint).
 */
import { createError, getHeader, setHeader, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { hashSessionToken } from './hmac'
import { getDb } from '../db'

export interface BearerTeammate {
  teammateId: string
  email: string
  displayName: string | null
  role: string
  regionId: string
  scope: string
}

type Db = PostgresJsDatabase<Record<string, unknown>>

function bearerError(event: H3Event, errorCode: string, detail: string): never {
  // RFC 6750 §3 — protected resource signals the OAuth error in the
  // WWW-Authenticate header so the MCP client knows to re-auth.
  setHeader(
    event,
    'WWW-Authenticate',
    `Bearer error="${errorCode}", error_description="${detail.replace(/"/g, "'")}"`,
  )
  throw createError({
    statusCode: 401,
    statusMessage: 'Unauthenticated',
    data: {
      type: 'https://tokenscope.example.com/errors/oauth-bearer',
      title: 'Invalid bearer token',
      status: 401,
      detail,
    },
  })
}

interface TokenJoinRow extends Record<string, unknown> {
  teammate_id: string
  email: string
  display_name: string | null
  role: string
  region_id: string
  scope: string
  access_expires_at: string | Date
  token_revoked_at: string | Date | null
  access_issued_at: string | Date
  teammate_revoked_at: string | Date | null
  is_current: boolean
  prev_in_grace: boolean | null
}

function toMs(v: string | Date | null | undefined): number | null {
  if (!v) return null
  const ms = v instanceof Date ? v.getTime() : Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Validate the request's Bearer token. Returns the bound teammate.
 *
 * @param scope optional required scope (e.g. 'tokenscope.emit'); the token's
 *              granted scope set must include it.
 */
/** What a presented (possibly rejected) Bearer token resolves to. */
export interface PresentedTokenInfo {
  teammateId: string
  /** The row's granted scope string (space-delimited). */
  scope: string
  /** The instance the credential is bound to (mig 0031); null for read/tag/legacy. */
  instanceId: string | null
}

/**
 * Identify the stored credential a presented Bearer token belongs to —
 * REGARDLESS of whether it's expired/revoked — by matching its hash against an
 * oauth_token row (current OR one-deep previous access hash, mig 0044). Returns
 * null for a missing / unrecognised (un-issued) token.
 *
 * This is the un-spoofable discriminator the went-silent re-anchor needs: a token
 * whose hash matches a stored row was genuinely issued by us to that teammate (an
 * attacker can't produce one without the token). The returned scope + instance
 * binding let the caller require that the rejected token is genuinely the
 * instance's EMIT credential (AUTH-6) — a rejected read/tag token at /bearer is a
 * misconfigured helper, not the emission disaster, and must not open a health
 * signal.
 */
export async function presentedTokenInfo(
  event: H3Event,
  dbOverride?: Db,
): Promise<PresentedTokenInfo | null> {
  const header = getHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const accessHash = hashSessionToken(match[1]!.trim())
  const db = dbOverride ?? (getDb() as unknown as Db)
  const rows = await db.execute<{ teammate_id: string; scope: string; instance_id: string | null }>(sql`
    SELECT teammate_id::text AS teammate_id, scope, instance_id::text AS instance_id
      FROM oauth_token
     WHERE access_token_hash = ${accessHash}
        OR prev_access_token_hash = ${accessHash}
     ORDER BY (access_token_hash = ${accessHash}) DESC
     LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) return null
  return { teammateId: row.teammate_id, scope: row.scope, instanceId: row.instance_id }
}

export async function requireOAuthBearer(
  event: H3Event,
  scope?: string,
  dbOverride?: Db,
): Promise<BearerTeammate> {
  const header = getHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) {
    bearerError(event, 'invalid_request', 'Missing or malformed Authorization: Bearer header')
  }
  const rawToken = match[1]!.trim()
  const accessHash = hashSessionToken(rawToken)

  const db = dbOverride ?? (getDb() as unknown as Db)
  // Single join: token row + its teammate (for the E2 revocation comparison and
  // the returned identity). We compare timestamps in JS rather than SQL so the
  // E2 vs token-expiry vs token-revoked distinctions are explicit. A token may
  // match as the CURRENT access hash, or — one-deep grace window (mig 0044,
  // AUTH-3) — as the PREVIOUS hash a concurrent refresh just superseded, valid
  // only until prev_valid_until.
  const rows = await db.execute<TokenJoinRow>(sql`
    SELECT t.teammate_id::text       AS teammate_id,
           tm.email                  AS email,
           tm.display_name           AS display_name,
           tm.role                   AS role,
           tm.region_id::text        AS region_id,
           t.scope                   AS scope,
           t.access_expires_at       AS access_expires_at,
           t.revoked_at              AS token_revoked_at,
           t.access_issued_at        AS access_issued_at,
           tm.revoked_at             AS teammate_revoked_at,
           (t.access_token_hash = ${accessHash}) AS is_current,
           -- Grace-window validity is judged DB-side (mig 0044 writes
           -- prev_valid_until with now()); comparing app-side Date.now()
           -- would reintroduce the AUTH-9 clock-skew class on a replica or a
           -- skewed app node — shortening the window re-opens the refresh
           -- ping-pong AUTH-3 fixes, lengthening it lets a superseded token
           -- live past 60s.
           (t.prev_valid_until > now()) AS prev_in_grace
      FROM oauth_token t
      JOIN teammate tm ON tm.id = t.teammate_id
     WHERE t.access_token_hash = ${accessHash}
        OR t.prev_access_token_hash = ${accessHash}
     ORDER BY (t.access_token_hash = ${accessHash}) DESC
     LIMIT 1
  `)
  const row = [...rows][0]
  if (!row) {
    bearerError(event, 'invalid_token', 'Bearer token is not recognised')
  }

  // Token revoked (explicit revoke, or superseded by a refresh).
  if (toMs(row.token_revoked_at) !== null) {
    bearerError(event, 'invalid_token', 'Bearer token has been revoked')
  }

  if (row.is_current) {
    // Token expired.
    const expMs = toMs(row.access_expires_at)
    if (expMs === null || expMs <= Date.now()) {
      bearerError(event, 'invalid_token', 'Bearer token has expired')
    }
  } else {
    // Previous-hash match: valid only inside the post-refresh grace window,
    // judged DB-side (prev_in_grace) to stay clock-consistent with the write.
    if (row.prev_in_grace !== true) {
      bearerError(event, 'invalid_token', 'Bearer token has expired')
    }
  }

  // ADR-0005 E2 — teammate revoked AFTER the token was issued ⇒ reject. A
  // teammate.revoked_at at or before issuance does not invalidate (the token
  // was minted post-revocation-clear, e.g. a re-provisioned account).
  const issuedMs = toMs(row.access_issued_at) ?? 0
  const teammateRevokedMs = toMs(row.teammate_revoked_at)
  if (teammateRevokedMs !== null && teammateRevokedMs > issuedMs) {
    bearerError(event, 'invalid_token', 'The teammate bound to this token has been revoked')
  }

  // Scope check (RFC 6749 §3.3 — granted scope is a space-delimited set).
  const granted = row.scope ? row.scope.split(' ').filter(Boolean) : []
  if (scope && !granted.includes(scope)) {
    bearerError(event, 'insufficient_scope', `Token is missing the required scope: ${scope}`)
  }

  return {
    teammateId: row.teammate_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    regionId: row.region_id,
    scope: row.scope,
  }
}
