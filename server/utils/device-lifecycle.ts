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

/**
 * Re-place every LIVE device of a teammate onto their new region and org unit,
 * so records the joiner attributes from now on carry the new placement (the
 * joiner stamps attribution_record.region_id / org_unit_id from this row).
 * Ended devices keep the placement they emitted under, and nothing already
 * attributed is touched. Same columns, same source as identity confirmation
 * (confirm-instance.ts) re-places a device. cost_owning_unit_id is not placement:
 * the joiner takes it from the attributed PROJECT, never from this row.
 * Returns the re-placed instance ids. Must run in a transaction.
 */
export async function rehomeLiveDevicesOf(
  db: Db,
  teammateId: string,
  placement: { regionId: string; orgUnitId: string },
): Promise<string[]> {
  await lockLiveDevicesOf(db, teammateId)
  const rows = await db.execute<{ instance_id: string }>(sql`
    UPDATE instance_attestation
       SET region_id = ${placement.regionId}::uuid, org_unit_id = ${placement.orgUnitId}::uuid
     WHERE teammate_id = ${teammateId}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL
    RETURNING instance_id::text AS instance_id
  `)
  return [...rows].map((r) => r.instance_id).sort()
}
