/*
 * Ending-soon worker (D3 of docs/design/project-lifecycle.md) — emits a
 * proactive "your project ends in N days — re-tag" inbox warning for each
 * developer affected by a project entering its end_date warning window. This is
 * what makes D2's post-end spill non-surprising.
 *
 * Owned by a DEDICATED daily worker (registered in WORKERS), NOT the joiner —
 * the joiner runs every tick and would spam. `warn_days` is resolved PER PROJECT
 * from its region's project_lifecycle_policy (D9). Affected developers = those
 * currently assigned to the project ∪ those who contributed spend this month
 * (covers the "tagged repo" case — a tagged repo shows up as the dev's spend).
 *
 * Dedup lives in notifyProjectEndingSoon: one live inbox item per
 * (dev, project) — mirrors budget-alert.ts's EXISTS-guard shape, extended with
 * the per-recipient dimension. No daily re-emission while an item is unresolved.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { loadLifecyclePolicyResolver } from '../db/project-lifecycle-policy'
import { notifyProjectEndingSoon } from '../notifications/project-lifecycle'
import { monthStartIso as monthStartIsoFor } from '../utils/period'

export interface EndingSoonResult {
  projectsInWindow: number
  warningsDispatched: number
  skippedExisting: number
}

interface ProjectRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
  region_id: string
  end_date: string
}

const DAY_MS = 86_400_000

export async function runEndingSoon(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<EndingSoonResult> {
  const now = opts?.now ?? new Date()
  const nowMs = now.getTime()
  const policyFor = await loadLifecyclePolicyResolver(db)
  const monthStartIso = monthStartIsoFor(now)

  // Projects with a FUTURE end_date (not yet ended). Small set — filter the
  // per-region warn window in JS since warn_days varies by region (D9).
  const projects = await db.execute<ProjectRow>(sql`
    SELECT id::text AS id, code, display_name,
           region_id::text AS region_id, end_date::text AS end_date
      FROM project
     WHERE end_date IS NOT NULL AND end_date > ${now.toISOString()}::timestamptz
  `)

  let projectsInWindow = 0
  let warningsDispatched = 0
  let skippedExisting = 0

  for (const p of projects) {
    const warnDays = policyFor(p.region_id).warnDays
    const daysRemaining = Math.max(1, Math.ceil((new Date(p.end_date).getTime() - nowMs) / DAY_MS))
    if (daysRemaining > warnDays) continue // not in the warning window yet
    projectsInWindow += 1

    // Affected developers: assigned now ∪ contributed this month.
    const devs = await db.execute<{ teammate_id: string }>(sql`
      SELECT teammate_id::text AS teammate_id FROM project_assignment
       WHERE project_id = ${p.id}::uuid AND effective @> now()
      UNION
      -- v_complete_usage: a Copilot-only contributor has no attribution_record
      -- rows, so reading the raw table would never warn them their project ends.
      SELECT DISTINCT teammate_id::text AS teammate_id FROM v_complete_usage
       WHERE project_id = ${p.id}::uuid AND ts_event >= ${monthStartIso}::timestamptz
    `)

    for (const d of devs) {
      const sent = await notifyProjectEndingSoon(db, {
        teammateId: d.teammate_id,
        projectId: p.id,
        endDate: p.end_date,
        daysRemaining,
        label: { code: p.code, name: p.display_name },
      })
      if (sent) warningsDispatched += 1
      else skippedExisting += 1
    }
  }

  return { projectsInWindow, warningsDispatched, skippedExisting }
}
