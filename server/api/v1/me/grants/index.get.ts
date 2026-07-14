/*
 * GET /api/v1/me/grants — the caller's OWN authorized connections (oauth_token
 * rows). Design doc §Grant lifecycle & consent management (F3b.1).
 *
 * Owner-scoping is the live gate: getMyGrants bounds every row to
 * `oauth_token.teammate_id = session.teammateId`. `oauth_token` has no RLS
 * policy and the owner DB connection makes RLS inert anyway (see request-rls.ts),
 * so this app-level predicate — NOT RLS — is what stops a dev seeing a peer's
 * grant. Mirrors GET /api/v1/me/instances.
 *
 * Per grant: id, client name (joined from oauth_client), scopes (split +
 * plain-language label), derived state (active/inactive/revoked/expired),
 * created_at (the stable refresh_issued_at anchor — oauth_token has no
 * created_at), last_used_at, and is_emit (so the UI can warn that revoke
 * cascades to the emitting device).
 *
 * Multiple grants per user are EXPECTED (N machines / re-enrol / reconnect) —
 * the list disambiguates by created_at + last_used_at.
 */
import { defineEventHandler } from 'h3'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireAuth } from '../../../../auth/rbac'
import { getDb } from '../../../../db'
import { getMyGrants } from '../../../../utils/me-queries'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const db = getDb() as unknown as PostgresJsDatabase<Record<string, unknown>>
  const grants = await getMyGrants(db, session.teammateId)
  return { grants }
})
