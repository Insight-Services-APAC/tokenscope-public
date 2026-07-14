/*
 * Project-lifecycle inbox notifications (D2a / D3 of
 * docs/design/project-lifecycle.md):
 *   - notifyProjectEndingSoon  — proactive "your project ends in N days, re-tag"
 *     warning, emitted by the ending-soon worker BEFORE the cutoff (D3).
 *   - notifyProjectEndedRetag  — "your spend spilled to unallocated because the
 *     project ended, re-tag it" signal, emitted by the joiner when post-end
 *     events actually spill (D2a, Step 8).
 *
 * Both are PER-DEVELOPER (recipientTeammateIdHint) and deduped with an
 * EXISTS-guard on (recipient, category, project, unresolved) so a re-scanned
 * session / a daily worker tick doesn't re-notify — one live item per
 * (dev, project) at a time. Mirrors budget-alert.ts's dedup shape, extended
 * with the per-recipient dimension.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from './dispatch'
import { monthStartIso as monthStartIsoFor } from '../utils/period'

type Db = PostgresJsDatabase<typeof schema>

/**
 * True if a live item of this category already exists for (recipient, project)
 * THIS MONTH. The month-start floor (matching budget-alert.ts) is load-bearing:
 * without it, a dev who reads-but-never-resolves the first item would be
 * suppressed forever — a project that re-opens and re-ends a month later would
 * never re-notify. The floor lets a genuinely-new spill in a later month fire.
 */
async function hasLiveItem(
  db: Db,
  category: 'project-ending-soon' | 'project-ended-retag',
  recipientTeammateId: string,
  projectId: string,
): Promise<boolean> {
  const monthStartIso = monthStartIsoFor()
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM inbox_item
     WHERE category = ${category}
       AND recipient_teammate_id = ${recipientTeammateId}::uuid
       AND related_entity_kind = 'project'
       AND related_entity_id = ${projectId}::uuid
       AND ack_state IN ('unread', 'read', 'acknowledged')
       AND created_at >= ${monthStartIso}::timestamptz
     LIMIT 1
  `)
  return rows.length > 0
}

async function projectLabel(db: Db, projectId: string): Promise<{ code: string; name: string } | null> {
  const rows = await db.execute<{ code: string; display_name: string }>(sql`
    SELECT code, display_name FROM project WHERE id = ${projectId}::uuid LIMIT 1
  `)
  const p = [...rows][0]
  return p ? { code: p.code, name: p.display_name } : null
}

/**
 * D3 — warn a developer ahead of a project's end. Deduped per (dev, project):
 * one live item until acked (re-entering the window after an ack re-alerts).
 */
export async function notifyProjectEndingSoon(
  db: Db,
  opts: {
    teammateId: string
    projectId: string
    endDate: string
    daysRemaining: number
    // The caller (ending-soon worker) already has the project row loaded; pass
    // its label to skip a redundant lookup.
    label?: { code: string; name: string }
  },
): Promise<boolean> {
  if (await hasLiveItem(db, 'project-ending-soon', opts.teammateId, opts.projectId)) return false
  const p = opts.label ?? (await projectLabel(db, opts.projectId))
  const name = p?.name ?? 'A project you work on'
  const dispatched = await dispatchInbox(db, {
    category: 'project-ending-soon',
    subject: `${name} ends in ${opts.daysRemaining} day${opts.daysRemaining === 1 ? '' : 's'} — re-tag soon`,
    body: {
      project: p?.code,
      projectId: opts.projectId,
      endDate: opts.endDate,
      daysRemaining: opts.daysRemaining,
    },
    relatedEntityKind: 'project',
    relatedEntityId: opts.projectId,
    recipientTeammateIdHint: opts.teammateId,
  })
  return dispatched.length > 0
}

/**
 * D2a — tell a developer their spend spilled to unallocated because the project
 * ended, so they re-tag the spilled portion to its successor. Deduped per
 * (dev, project): one live item until acked.
 */
export async function notifyProjectEndedRetag(
  db: Db,
  opts: { teammateId: string; projectId: string },
): Promise<boolean> {
  if (await hasLiveItem(db, 'project-ended-retag', opts.teammateId, opts.projectId)) return false
  const p = await projectLabel(db, opts.projectId)
  const name = p?.name ?? 'A project'
  const dispatched = await dispatchInbox(db, {
    category: 'project-ended-retag',
    subject: `${name} has ended — re-tag your recent spend`,
    body: { project: p?.code, projectId: opts.projectId, reason: 'ended-spill' },
    relatedEntityKind: 'project',
    relatedEntityId: opts.projectId,
    recipientTeammateIdHint: opts.teammateId,
  })
  return dispatched.length > 0
}
