/*
 * Which revocation anchor a credential is judged against (#414).
 *
 * teammate.revoked_at is bumped by a role change, a region move, revoke-sessions
 * and retirement. teammate.emit_revoked_at (mig 0152) is bumped by
 * revoke-sessions and retirement only. A DEVICE-BOUND EMIT credential is judged
 * against emit_revoked_at, everything else against revoked_at, so a benign role
 * or region change re-validates interactive access without ending a device's
 * telemetry.
 *
 * Device-bound emit is the exact scope `tokenscope.emit` with an instance
 * binding. A token with any other scope (read, tag, or a multi-scope set) or no
 * binding is not one, and keeps the revoked_at anchor.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Db = PostgresJsDatabase<Record<string, unknown>>

const DEVICE_EMIT_SCOPE = 'tokenscope.emit'

/** True for a device-bound emit credential, over an oauth_token alias. */
export function deviceBoundEmitSql(token: SQL): SQL {
  return sql`(${token}.scope = ${DEVICE_EMIT_SCOPE} AND ${token}.instance_id IS NOT NULL)`
}

/**
 * Revoke a teammate's live credentials EXCEPT device-bound emit ones. The
 * role-change and region-move cascade; revoke-sessions revokes everything.
 */
export async function revokeInteractiveCredentialsOf(db: Db, teammateId: string): Promise<void> {
  await db.execute(sql`
    UPDATE oauth_token t SET revoked_at = NOW()
     WHERE t.teammate_id = ${teammateId}::uuid
       AND t.revoked_at IS NULL
       AND NOT ${deviceBoundEmitSql(sql`t`)}
  `)
}
