/*
 * Mitigation-query worker — detect OTel-vs-attestation gaps.
 *
 * Per docs/build/mvp-lite-epic.md §Epic 6: "Mitigation-query worker —
 * detects OTel-vs-attestation gaps; writes instance_attestation_health
 * rows".
 *
 * Rule (pilot-shaped): for any ENDED session (ts_actual_end IS NOT NULL),
 * if no attribution_record exists for it, write a instance_attestation_health
 * row with status='no-spans-received'. Idempotent — skip if a row for
 * that (session_id, status) already exists and isn't resolved.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import * as schemaImport from '../../drizzle/schema'

export interface MitigationResult {
  newHealthRows: number
}

export async function runMitigationQuery(
  db: PostgresJsDatabase<typeof schema>,
): Promise<MitigationResult> {
  const gaps = await db.execute<{
    instance_id: string
    expected: number
    actual: number
  }>(
    sql`
      SELECT sa.instance_id::text AS instance_id,
             0::int AS expected,
             COALESCE(ar.cnt, 0)::int AS actual
      FROM instance_attestation sa
      LEFT JOIN (
        SELECT instance_id, COUNT(*)::int AS cnt
        FROM attribution_record
        GROUP BY instance_id
      ) ar ON ar.instance_id = sa.instance_id
      WHERE sa.ts_actual_end IS NOT NULL
        AND COALESCE(ar.cnt, 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM instance_attestation_health sah
          WHERE sah.instance_id = sa.instance_id
            AND sah.status = 'no-spans-received'
            AND sah.resolved_at IS NULL
        )
    `,
  )

  let written = 0
  for (const gap of gaps) {
    await db.insert(schemaImport.instanceAttestationHealth).values({
      instanceId: gap.instance_id,
      status: 'no-spans-received',
      expectedSpanCount: gap.expected,
      actualSpanCount: gap.actual,
      payload: { detectedBy: 'mitigation-query-worker' },
    })
    written += 1
  }

  return { newHealthRows: written }
}
