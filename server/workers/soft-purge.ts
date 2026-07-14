/*
 * Soft-purge worker — clears PII from instance_attestation rows past 12
 * months while preserving the FK-load-bearing columns.
 *
 * Per data-model.md §instance_attestation Retention (R1 F6 / R2 F2):
 *   - 12-month active retention.
 *   - At month 13, clear principal_email, raw_project_code, notes; set
 *     ts_purged = NOW().
 *   - Keep session_id, principal_oid, region_id, org_unit_id,
 *     cost_owning_unit_id, attestation_state so attribution_record's FK
 *     stays valid for the financial-audit retention horizon.
 *   - Emit one audit_event per purged row of type 'session-pii-purged'
 *     with actor_system = 'session-attestation-purge-worker'.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'

const PURGE_AFTER_DAYS = 365 // ~12 months; data-model.md tunable per ADMIN-7

export interface SoftPurgeResult {
  purgedSessionIds: string[]
}

export async function runSoftPurge(
  db: PostgresJsDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<SoftPurgeResult> {
  const cutoffIso = new Date(now.getTime() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const nowIso = now.toISOString()

  const candidates = await db.execute<{ instance_id: string; teammate_id: string }>(
    sql`
      SELECT instance_id::text AS instance_id, teammate_id::text AS teammate_id
      FROM instance_attestation
      WHERE ts_start < ${cutoffIso}::timestamptz
        AND ts_purged IS NULL
    `,
  )

  const purged: string[] = []
  for (const row of candidates) {
    await db.execute(sql`
      UPDATE instance_attestation
      SET principal_email = NULL,
          raw_project_code = NULL,
          notes = NULL,
          ts_purged = ${nowIso}::timestamptz
      WHERE instance_id = ${row.instance_id}::uuid AND ts_purged IS NULL
    `)
    await recordAuditEvent(db, {
      eventType: 'session-pii-purged',
      actorTeammateId: row.teammate_id,
      actorSystem: 'session-attestation-purge-worker',
      subjectKind: 'session',
      subjectId: row.instance_id,
      payload: { purgedAt: nowIso, cutoff: cutoffIso },
    })
    purged.push(row.instance_id)
  }

  return { purgedSessionIds: purged }
}
