/*
 * requireOAuthBearer — validate an incoming `Authorization: Bearer <token>`
 * against oauth_token, returning the bound teammate.
 *
 * This is what protected emission/read endpoints (the next slice) gate on. The
 * checks, in order:
 *   1. Bearer header present + parseable.
 *   2. Token hash matches a live oauth_token row (not revoked, not expired).
 *   3. Optional required scope is present in the granted scope set.
 *   4. DEACTIVATION: the bound teammate must be `is_active = true`. Unlike (5)
 *      this is a durable STATE with no timestamp comparison — see below.
 *   5. ADR-0005 E2 revocation cascade: the bound teammate must NOT have been
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
import { consola } from 'consola'
import { hashSessionToken } from './hmac'
import { getDb } from '../db'

const legacyBindingLogger = consola.withTag('oauth-bearer')

export interface BearerTeammate {
  teammateId: string
  email: string
  displayName: string | null
  role: string
  regionId: string
  scope: string
  /** The instance this credential is bound to (mig 0031); null for read/tag/legacy grants. */
  instanceId: string | null
  /** The oauth_client that minted this credential (oauth_token.client_id, NOT NULL at rest). */
  clientId: string | null
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
  teammate_is_active: boolean | null
  is_current: boolean
  prev_in_grace: boolean | null
  instance_id: string | null
  client_id: string | null
}

/**
 * How many times this process has let a NULL-bound (pre-mig-0031 legacy, or
 * genuinely un-instance-bound) emit credential through an instance-scoped
 * route's binding check. Not attacker-reachable (see the check below) — this
 * exists purely so an operator can watch the legacy population shrink to zero
 * and know when the permissive branch is safe to delete.
 */
let legacyUnboundBearerHits = 0

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
  /**
   * When supplied, the credential MUST be bound (oauth_token.instance_id) to
   * THIS instance — the per-DEVICE check the four /instances/{instanceId}/*
   * consumers pass their path param as. A NULL-bound row (pre-mig-0031
   * legacy grant, or a read/tag credential that is never instance-bound by
   * construction) stays PERMISSIVE — see the check below for why that's safe.
   * Omit for callers with no single-instance target (e.g. the MCP endpoint,
   * which is read-scoped and instance-agnostic by design).
   */
  requiredInstanceId?: string,
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
           tm.is_active              AS teammate_is_active,
           t.instance_id::text       AS instance_id,
           t.client_id::text         AS client_id,
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

  // DEACTIVATION — the durable axis, and NOT the same shape as the E2 check
  // below. `is_active = false` denies EVERY credential for that teammate,
  // existing or freshly minted, with no timestamp comparison: there is no
  // "after" to be on the right side of, because the account is retired.
  //
  // Why this has to be here and not only on the cookie path: the
  // privileged-identity-cleanup worker's ONLY identity mutation is
  // `UPDATE teammate SET is_active = FALSE`
  // (server/workers/privileged-identity-cleanup.ts) — it never touches
  // revoked_at — so the E2 comparison below can never fire for a cleaned
  // account. isRevoked() (server/utils/auth.ts) closed that hole for the
  // COOKIE session; this closes it for the credential that actually carries
  // telemetry. Without it a deactivated teammate keeps a valid unexpired
  // access token across every requireOAuthBearer consumer — the four
  // /instances/{id}/* emit routes and the MCP endpoint.
  //
  // FAIL CLOSED: the test is `!== true`, so NULL (not expected — mig 0001
  // declares the column NOT NULL DEFAULT TRUE) or an absent field denies.
  if (row.teammate_is_active !== true) {
    bearerError(event, 'invalid_token', 'The teammate bound to this token has been deactivated')
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

  // Per-DEVICE binding. oauth_token.instance_id is written at mint (mig 0031)
  // but was never selected here — every instance-scoped consumer therefore
  // degraded a per-DEVICE check into a per-TEAMMATE one: any of a teammate's
  // OWN emit credentials could drive ANY of that teammate's OTHER instances'
  // /bearer, /health, /end, /project-resolve. This is what ADR-0008 §2's
  // anti-spoof claim ("a cross-instance spoofer cannot mint a bearer for a
  // victim's instance") depends on — this check is what makes it true.
  //
  // A NULL row.instance_id MUST stay permissive — rejecting it would 401
  // every pre-mig-0031 legacy device's /bearer in one deploy, a silent
  // fleet-wide emission stop (the 2026-06-06 outage class; see bearer.get.ts
  // §"Must not break"). This permissive branch is NOT attacker-reachable: the
  // sole `INSERT INTO oauth_token` (oauth.ts:334) never sets instance_id; the
  // binding only happens via the UPDATE at emit-provision.ts:394-397, reached
  // only from setup/redeem.post.ts and setup/enroll.post.ts; and
  // INTERACTIVE_GRANTABLE_SCOPES (oauth.ts:44) is
  // ['tokenscope.read','tokenscope.tag'] — the interactive/consent flow can
  // never mint an emit token to begin with, so there is no route by which an
  // attacker can cause a NULL-bound row to exist and then exploit it.
  if (requiredInstanceId && row.instance_id !== null && row.instance_id !== requiredInstanceId) {
    bearerError(event, 'invalid_token', 'Bearer token is not bound to this instance')
  }
  if (requiredInstanceId && row.instance_id === null) {
    legacyUnboundBearerHits += 1
    // Two more reasons a NULL binding can persist — worth carrying in the
    // same line so an operator watching this doesn't have to go dig:
    //  (1) oauth_token.instance_id is ON DELETE SET NULL (mig 0031:47) —
    //      deleting an instance_attestation silently de-binds a LIVE emit
    //      credential back into this permissive branch;
    //  (2) the rotate-on-reissue revoke (emit-provision.ts:386-391) filters
    //      WHERE instance_id = X, so a NULL-bound credential is never
    //      rotated out by a later re-provision of the SAME device.
    legacyBindingLogger.warn(
      'legacy NULL-bound emit credential accepted on an instance-scoped route (permissive branch — not attacker-reachable; see requireOAuthBearer)',
      {
        teammateId: row.teammate_id,
        requestedInstanceId: requiredInstanceId,
        totalHitsThisProcess: legacyUnboundBearerHits,
      },
    )
  }

  return {
    teammateId: row.teammate_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    regionId: row.region_id,
    scope: row.scope,
    instanceId: row.instance_id,
    clientId: row.client_id,
  }
}
