/*
 * Device names for the caller's OWN devices (#576).
 *
 * A device's name (instance_attestation.display_name, mig 0171) is a personal,
 * display-only field: it is shown to the device's own teammate wherever that
 * device appears to them (worklist, Tag dialog, Activity, session drawer, the
 * silent-device alert), and to admins on Admin > Devices. It is never matched or
 * attributed on, and never written into a report or export. The 12-month soft
 * purge clears it once the device has ended.
 *
 * So every per-person read that wants a name asks THIS helper, scoped to the
 * caller's own teammate id: a name never leaks to another teammate even if an
 * instance id did, and the lookup cannot widen what a list returns. Unknown or
 * unnamed ids are simply absent from the map; the caller falls back to the tool
 * and the short id.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

type Tx = PostgresJsDatabase<Record<string, unknown>>

export async function ownDeviceNames(
  tx: Tx,
  teammateId: string,
  instanceIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(instanceIds.filter((v): v is string => typeof v === 'string' && v !== ''))]
  const out = new Map<string, string>()
  if (!ids.length) return out
  const rows = await tx.execute<{ instance_id: string; display_name: string } & Record<string, unknown>>(sql`
    SELECT ia.instance_id::text AS instance_id, ia.display_name
      FROM instance_attestation ia
     WHERE ia.teammate_id = ${teammateId}::uuid
       AND ia.display_name IS NOT NULL
       AND ia.instance_id::text IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)
  for (const r of rows) out.set(r.instance_id, r.display_name)
  return out
}
