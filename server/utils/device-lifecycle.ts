/*
 * Ending several of a teammate's devices at once.
 *
 * Every path that locks more than one device row takes them in instance_id
 * order. A bare `UPDATE … WHERE teammate_id = …` locks rows in scan order, so
 * two concurrent multi-device ends (an admin revoke-sessions and a legacy
 * grant revoke, say) could each hold one device and wait on the other.
 * Single-device paths lock one row and cannot form that cycle.
 *
 * The wider order these locks sit in (device, then emit_handoff, then
 * oauth_token) is described at consumeEmitHandoff (server/auth/emit-provision.ts).
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Db = PostgresJsDatabase<Record<string, unknown>>

/** Lock a teammate's live devices, in instance_id order. Must run in a transaction. */
export async function lockLiveDevicesOf(db: Db, teammateId: string): Promise<void> {
  await db.execute(sql`
    SELECT 1 FROM instance_attestation
     WHERE teammate_id = ${teammateId}::uuid AND ts_actual_end IS NULL
     ORDER BY instance_id
       FOR UPDATE
  `)
}

/**
 * End every live device of a teammate (mig 0141 revokes their credentials).
 * Returns the ended instance ids. Must run in a transaction.
 */
export async function endLiveDevicesOf(db: Db, teammateId: string): Promise<string[]> {
  await lockLiveDevicesOf(db, teammateId)
  const rows = await db.execute<{ instance_id: string }>(sql`
    UPDATE instance_attestation SET ts_actual_end = now()
     WHERE teammate_id = ${teammateId}::uuid AND ts_actual_end IS NULL
    RETURNING instance_id::text AS instance_id
  `)
  return [...rows].map((r) => r.instance_id)
}
