/*
 * Budget-alert worker — emits `over-budget` inbox items for projects whose
 * MTD attributed cost has exceeded their current baseline+top-up allocation.
 *
 * Why this exists: prior to MVP-Final convergence, inbox over-budget items
 * were hard-coded in `drizzle/seed.ts` while the homepage rendered live
 * numbers from `attribution_record + allocation`. The two surfaces diverged
 * — homepage said "Healthy" while the inbox said "$210 over". This worker
 * is the producer that closes that gap: it reads the SAME SQL shape the
 * homepage uses (server/api/v1/me/usage.get.ts) so the two surfaces agree
 * by construction.
 *
 * Mirrors `runReconciliation`'s shape:
 *   - Pure SQL scan, no external clients.
 *   - Idempotency-check before dispatch (no duplicates within a month).
 *   - Uses dispatchInbox — the dispatcher picks recipients (project's CoU
 *     teammates) via its own routing rule. We do NOT specify a recipient.
 *
 * Body field contract: matches app/components/inbox/DrawerBodyOverBudget.vue
 * exactly — `project`, `usedUsd`, `capUsd`, `overBy`, `otelPct`, `anthroPct`.
 *
 * On otelPct / anthroPct: today the codebase's per-project cost comes purely
 * from `attribution_record` (the OTel attribution path); `actual_spend`
 * (Anthropic Analytics API) is keyed by teammate+date and carries no
 * project_id, so a per-project Anthropic-API split is not directly
 * computable. We therefore emit `otelPct = 1.0`, `anthroPct = 0.0` —
 * truthful for the data path used by the homepage. A future refinement
 * could apportion `actual_spend` across a teammate's projects, but doing so
 * here would break homepage-parity, which is the bug class this worker
 * fixes.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'
import { monthStartIso as monthStartIsoFor } from '../utils/period'

export interface BudgetAlertResult {
  projectsScanned: number
  alertsDispatched: number
  skippedExisting: number
}

interface ProjectRow extends Record<string, unknown> {
  project_id: string
  project_code: string
  display_name: string
  used_usd: string
  cap_usd: string
}

export async function runBudgetAlert(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<BudgetAlertResult> {
  const now = opts?.now ?? new Date()
  const monthStartIso = monthStartIsoFor(now)

  // Per-project MTD spend (from attribution_record, mirroring
  // server/api/v1/me/usage.get.ts) and current allocation cap
  // (baseline + top-up effective at month-start; burst excluded —
  // matches usage.get.ts and the allocation_total_usd contract).
  //
  // Only projects with at least one allocation row (cap > 0) are
  // candidates; a project with no allocation has no over-budget concept.
  const rows = await db.execute<ProjectRow>(
    sql`
      SELECT p.id::text   AS project_id,
             p.code       AS project_code,
             p.display_name AS display_name,
             COALESCE((
               SELECT SUM(ar.cost_usd)
                 FROM attribution_record ar
                WHERE ar.project_id = p.id
                  AND ar.ts_event >= ${monthStartIso}::timestamptz
                  -- Provisional (emit-on-install, pre-confirmation) usage must never
                  -- drive a budget-alert page. NULL = legacy = treated as confirmed.
                  AND ar.identity_state IS DISTINCT FROM 'provisional'
             ), 0)::text AS used_usd,
             COALESCE((
               SELECT SUM(al.budget_usd)
                 FROM allocation al
                WHERE al.scope_type = 'project'
                  AND al.scope_id = p.id
                  AND al.allocation_kind IN ('baseline', 'top-up')
                  AND al.effective @> ${monthStartIso}::timestamptz
             ), 0)::text AS cap_usd
        FROM project p
       WHERE EXISTS (
              SELECT 1 FROM allocation al
               WHERE al.scope_type = 'project'
                 AND al.scope_id = p.id
                 AND al.allocation_kind IN ('baseline', 'top-up')
                 AND al.effective @> ${monthStartIso}::timestamptz
             )
    `,
  )

  let alertsDispatched = 0
  let skippedExisting = 0
  const projectsScanned = rows.length

  for (const r of rows) {
    const usedUsd = Number(r.used_usd)
    const capUsd = Number(r.cap_usd)
    if (capUsd <= 0) continue
    if (usedUsd <= capUsd) continue

    // Idempotency: skip if ANY recipient has an unresolved over-budget item
    // for this project created since month-start. Tradeoff: per-recipient
    // scoping re-fires when the dispatcher fans out to a manager added
    // after the first alert (false-positive); project-wide scoping
    // silently fails to backfill a teammate added to the CoU mid-month
    // (false-negative). We pick project-wide because the dispatcher's
    // fan-out target is stable enough for the demo; a per-recipient
    // dispatch_log is the right production answer and is tracked as a
    // follow-up.
    const existing = await db.execute<{ id: string }>(
      sql`
        SELECT id::text AS id FROM inbox_item
         WHERE category = 'over-budget'
           AND related_entity_kind = 'project'
           AND related_entity_id = ${r.project_id}::uuid
           AND ack_state IN ('unread', 'read', 'acknowledged')
           AND created_at >= ${monthStartIso}::timestamptz
         LIMIT 1
      `,
    )
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const overBy = usedUsd - capUsd
    // See file-header comment: per-project Anthropic-API spend isn't
    // directly computable today. Emit otelPct=1.0 to mirror the data
    // path the homepage uses; a future refinement would split this
    // when actual_spend gains a project_id.
    const otelPct = 1
    const anthroPct = 0

    const dispatched = await dispatchInbox(db, {
      category: 'over-budget',
      subject: `${r.display_name} is $${overBy.toFixed(0)} over allocation`,
      body: {
        project: r.project_code,
        usedUsd,
        capUsd,
        overBy,
        otelPct,
        anthroPct,
      },
      relatedEntityKind: 'project',
      relatedEntityId: r.project_id,
      // Same clock as this run's spend window — the contributor routing
      // must see the spend that triggered the alert.
      now,
    })
    if (dispatched.length > 0) {
      alertsDispatched += 1
    }
  }

  return { projectsScanned, alertsDispatched, skippedExisting }
}
