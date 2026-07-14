/*
 * Session GC worker — closes abandoned sessions.
 *
 * Per api-and-connector-interfaces.md §1.3a: every 5 minutes, find rows
 * where `ts_actual_end IS NULL` AND `expires_at < NOW()`, set
 * `ts_actual_end = NOW()`, emit `audit_event` with `actor_system =
 * 'session-gc-worker'`.
 *
 * The expires-at column doesn't exist on instance_attestation (the spec
 * conceptually carries an expiry but the table only stores ts_start +
 * ts_expected_end + ts_actual_end + ts_purged). We use ts_expected_end
 * as the abandonment cue when populated; otherwise we fall back to
 * `ts_start + the durable-credential life` (refresh token, 90d). The old
 * `ts_start + 12h` fallback matched the DEAD session-token TTL and closed
 * still-emitting OAuth instances (the 2026-06-06 attribution outage).
 *
 * Pure function: takes a Drizzle client + a "now" timestamp. Production
 * scheduling is BullMQ at Epic 10; the test calls runSessionGc() directly
 * with a synthetic now.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { REFRESH_TOKEN_TTL_MS } from '../auth/oauth'

// Fallback abandonment cue when ts_expected_end is NULL: the DURABLE credential
// life (refresh token, 90d), NOT the dead 12h session-token TTL — a 12h cutoff
// closed still-emitting OAuth instances (the 2026-06-06 outage).
const DEFAULT_TTL_MS = REFRESH_TOKEN_TTL_MS

/*
 * OAuth-lifecycle sweep bounds (AUTH-5). Nothing previously deleted
 * expired/consumed oauth_auth_code or emit_handoff rows, expired/revoked
 * oauth_token rows, or abandoned oauth_client registrations — and every MCP
 * client install dynamically registers a NEW client row on the unauthenticated
 * RFC 7591 endpoint, so abandoned registrations monotonically fill the
 * MAX_OAUTH_CLIENTS cap until registration 429s forever.
 */
// Single-use artifacts (codes/handoffs, ~5 min TTL): keep a day for incident forensics.
const ARTIFACT_GC_GRACE_HOURS = 24
// Dead tokens / stale clients: keep 30 days (the grant-review / audit window).
const CREDENTIAL_GC_GRACE_DAYS = 30

export interface SessionGcResult {
  closedSessionIds: string[]
  /** AUTH-5 sweep counts. */
  authCodesDeleted: number
  emitHandoffsDeleted: number
  oauthTokensDeleted: number
  oauthClientsDeleted: number
}

export async function runSessionGc(
  db: PostgresJsDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<SessionGcResult> {
  const expiryFallback = new Date(now.getTime() - DEFAULT_TTL_MS).toISOString()
  const nowIso = now.toISOString()

  // Find sessions that are open (ts_actual_end is NULL) and have either
  // exceeded their declared ts_expected_end OR — if ts_expected_end was
  // never set — exceeded the durable-credential life since ts_start.
  //
  // Dates are bound as ISO strings + explicit ::timestamptz cast because
  // drizzle's sql tag + postgres-js doesn't auto-serialise Date over the
  // timestamptz wire type for ad-hoc execute() calls.
  const candidates = await db.execute<{
    instance_id: string
    teammate_id: string
  }>(
    sql`
      SELECT instance_id::text AS instance_id, teammate_id::text AS teammate_id
      FROM instance_attestation
      WHERE ts_actual_end IS NULL
        AND (
          (ts_expected_end IS NOT NULL AND ts_expected_end < ${nowIso}::timestamptz)
          OR (ts_expected_end IS NULL AND ts_start < ${expiryFallback}::timestamptz)
        )
    `,
  )

  const closed: string[] = []
  for (const row of candidates) {
    await db.execute(sql`
      UPDATE instance_attestation
      SET ts_actual_end = ${nowIso}::timestamptz
      WHERE instance_id = ${row.instance_id}::uuid AND ts_actual_end IS NULL
    `)
    await recordAuditEvent(db, {
      eventType: 'session-gc-closed',
      actorTeammateId: row.teammate_id,
      actorSystem: 'session-gc-worker',
      subjectKind: 'session',
      subjectId: row.instance_id,
      payload: { reason: 'abandoned', closedAt: now.toISOString() },
    })
    closed.push(row.instance_id)
  }

  // ── AUTH-5: OAuth-lifecycle sweep ──────────────────────────────────────────
  // Single-use auth codes past expiry/consumption + the artifact grace. Consumed
  // codes must outlive the grace (not be dropped immediately) so replay attempts
  // inside the window still hit the consumed row's invalid_grant, not unknown-code.
  const deadCodes = await db.execute<{ id: string }>(sql`
    DELETE FROM oauth_auth_code
     WHERE COALESCE(consumed_at, expires_at) < ${nowIso}::timestamptz - (${ARTIFACT_GC_GRACE_HOURS} * INTERVAL '1 hour')
    RETURNING id::text AS id
  `)
  const deadHandoffs = await db.execute<{ id: string }>(sql`
    DELETE FROM emit_handoff
     WHERE COALESCE(consumed_at, expires_at) < ${nowIso}::timestamptz - (${ARTIFACT_GC_GRACE_HOURS} * INTERVAL '1 hour')
    RETURNING id::text AS id
  `)
  // Tokens that are revoked or whose refresh credential expired, past the
  // credential grace. Live + merely-access-expired (refresh still valid) stay.
  const deadTokens = await db.execute<{ id: string }>(sql`
    DELETE FROM oauth_token
     WHERE COALESCE(revoked_at, refresh_expires_at) < ${nowIso}::timestamptz - (${CREDENTIAL_GC_GRACE_DAYS} * INTERVAL '1 day')
    RETURNING id::text AS id
  `)
  // Abandoned dynamic registrations: never the internal emit client, old enough,
  // and with NO remaining token or code rows at all (the sweeps above own the
  // retention of dead ones — the client goes only once nothing references it).
  const deadClients = await db.execute<{ client_id: string }>(sql`
    DELETE FROM oauth_client c
     WHERE c.internal = false
       AND c.created_at < ${nowIso}::timestamptz - (${CREDENTIAL_GC_GRACE_DAYS} * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM oauth_token t WHERE t.client_id = c.client_id)
       AND NOT EXISTS (SELECT 1 FROM oauth_auth_code ac WHERE ac.client_id = c.client_id)
    RETURNING client_id::text AS client_id
  `)
  if (deadCodes.length || deadHandoffs.length || deadTokens.length || deadClients.length) {
    await recordAuditEvent(db, {
      eventType: 'oauth-gc-swept',
      actorTeammateId: null,
      actorSystem: 'session-gc-worker',
      subjectKind: 'system',
      subjectId: null,
      payload: {
        authCodesDeleted: deadCodes.length,
        emitHandoffsDeleted: deadHandoffs.length,
        oauthTokensDeleted: deadTokens.length,
        oauthClientsDeleted: deadClients.length,
        sweptAt: now.toISOString(),
      },
    })
  }

  return {
    closedSessionIds: closed,
    authCodesDeleted: deadCodes.length,
    emitHandoffsDeleted: deadHandoffs.length,
    oauthTokensDeleted: deadTokens.length,
    oauthClientsDeleted: deadClients.length,
  }
}
