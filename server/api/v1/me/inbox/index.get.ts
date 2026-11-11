/*
 * GET /api/v1/me/inbox — list the authenticated dev's inbox items.
 *
 * Filters: ack_state, category, group (one of the six inbox filter groups,
 * shared/inbox/categories.ts), severity, limit, cursor (#569: `next_cursor`
 * from the previous page; the filters must be the same). `total` counts
 * every match, whatever the cursor. `ack_state=open`
 * shorthand selects unread + read + acknowledged (the unresolved
 * states); `closed` selects dismissed + resolved.
 *
 * Goes through withRequestRls so the inbox_item self-policy fires
 * once Epic 10's non-owner DB role lands.
 */
import { createError, defineEventHandler, getValidatedQuery } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../../auth/rbac'
import { allocationScopePredicate } from '../../../../auth/allocation-scope'
import { withRequestRls } from '../../../../db/request-rls'
import { InboxListQuery } from '../../../../../shared/schemas/inbox'
import { isAdminRole, isPlatformAdmin } from '../../../../../shared/auth/roles'
import {
  INBOX_CATEGORY_GROUPS,
  inboxCategoryGroup,
  type InboxCategoryGroup,
} from '../../../../../shared/inbox/categories'
import {
  CURSOR_SELECT_SQL,
  ackStateSql,
  cursorSql,
  kindFiltersSql,
  parseInboxCursor,
  type InboxCursor,
} from '../../../../inbox/filters'

interface InboxRow extends Record<string, unknown> {
  id: string
  category: string
  severity: string
  subject: string
  body: unknown
  related_entity_kind: string | null
  related_entity_id: string | null
  ack_state: string
  ack_at: string | null
  created_at: string
  /*
   * For items where related_entity_kind='project', this is the id of
   * the project's currently-effective baseline allocation row. The
   * drawer turns this into a /allocations/{id} link so the recipient
   * can jump straight from an alert to the live project surface
   * (consumption, top-ups, audit trail). Null for non-project entities,
   * projects with no baseline currently in effect, OR — honourable-links
   * rule — recipients who would 404 on the editor (the link is only
   * emitted when the recipient passes the editor's own dual gate).
   */
  target_allocation_id: string | null
  /*
   * For items where related_entity_kind='project', the project's CODE: the
   * drawer's "Open project →" goes to /projects/{code}. Emitted only when THIS
   * recipient passes that page's own gate (honourable-links rule): a current
   * member, an active owner of the project's Business Unit, or an admin in
   * scope of its region (platform-admin, or that region's admin), the same
   * three arms as requireProjectMembership + isProjectAdmin. Null otherwise.
   */
  target_project_code: string | null
  /*
   * For items where related_entity_kind='instance' (the silent-device alert),
   * the name the recipient gave that device (#576). Read live, never copied
   * into the alert body, so renaming shows at once and the 12-month purge is
   * not outlived. Only when the device is the RECIPIENT's own; null otherwise.
   */
  target_device_name: string | null
  /* This row's page cursor (server/inbox/filters.ts); becomes `next_cursor`. */
  page_cursor: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const query = await getValidatedQuery(event, (data) => InboxListQuery.parse(data))

  const ackStateFilter = ackStateSql(query.ack_state)
  const kindFilters = kindFiltersSql(query)
  let cursor: InboxCursor | null = null
  if (query.cursor !== undefined) {
    cursor = parseInboxCursor(query.cursor)
    if (!cursor) throw createError({ statusCode: 400, statusMessage: 'Invalid inbox cursor' })
  }

  // The admin arm of the project page's gate (isProjectAdmin), as SQL operands.
  const adminAnyRegion = isPlatformAdmin(session.role)
  const adminRegionId =
    session.role === 'admin' && typeof session.regionId === 'string' && session.regionId !== ''
      ? session.regionId
      : null

  const { rows, total: totalRows, counts } = await withRequestRls(event, async (tx) => ({
    rows: await tx.execute<InboxRow>(sql`
      SELECT
        i.id::text AS id, i.category, i.severity, i.subject, i.body,
        i.related_entity_kind,
        i.related_entity_id::text AS related_entity_id,
        i.ack_state, i.ack_at::text AS ack_at,
        i.created_at::text AS created_at,
        target_alloc.allocation_id AS target_allocation_id,
        target_proj.code AS target_project_code,
        target_dev.display_name AS target_device_name,
        ${CURSOR_SELECT_SQL} AS page_cursor
      FROM inbox_item i
      LEFT JOIN LATERAL (
        SELECT al.id::text AS allocation_id
          FROM allocation al
         WHERE al.scope_type = 'project'
           AND al.scope_id = i.related_entity_id
           AND al.allocation_kind = 'baseline'
           AND al.effective @> CURRENT_TIMESTAMP
           -- Honourable-links rule: emit the editor deep-link only when
           -- THIS recipient passes the editor's own dual gate (org-role
           -- scope OR currently-effective PM — mirrors allocations/[id]).
           -- The scope predicate is gated by the same role list the editor
           -- uses: a developer-role caller reaches the editor ONLY via the
           -- PM arm, even when the project sits in their own org subtree.
           -- A contributor who can't open the editor still gets the alert
           -- for awareness, with no dead "Add top-up" button.
           AND (
             (
               current_setting('app.user_role', true) IN ('manager', 'admin', 'global-finops')
               AND ${allocationScopePredicate('al')}
             )
             OR EXISTS (
               SELECT 1 FROM project_assignment pa
               WHERE pa.project_id = al.scope_id
                 AND pa.teammate_id = ${session.teammateId}::uuid
                 AND pa.role = 'manager'
                 AND pa.effective @> now()
             )
           )
         ORDER BY lower(al.effective) DESC
         LIMIT 1
      ) target_alloc ON i.related_entity_kind = 'project'
      LEFT JOIN LATERAL (
        SELECT p.code
          FROM project p
         WHERE p.id = i.related_entity_id
           AND (
             EXISTS (
               SELECT 1 FROM project_assignment pa
               WHERE pa.project_id = p.id
                 AND pa.teammate_id = ${session.teammateId}::uuid
                 AND pa.effective @> now()
             )
             OR EXISTS (
               SELECT 1 FROM cou_owner co
               WHERE co.org_unit_id = p.cost_owning_unit_id
                 AND co.teammate_id = ${session.teammateId}::uuid
                 AND co.revoked_at IS NULL
             )
             OR ${adminAnyRegion}::boolean
             OR p.region_id = ${adminRegionId}::uuid
           )
         LIMIT 1
      ) target_proj ON i.related_entity_kind = 'project'
      LEFT JOIN instance_attestation target_dev
        ON i.related_entity_kind = 'instance'
       AND target_dev.instance_id = i.related_entity_id
       AND target_dev.teammate_id = ${session.teammateId}::uuid
      WHERE i.recipient_teammate_id = ${session.teammateId}::uuid
        AND ${ackStateFilter}
        ${kindFilters}
        ${cursorSql(cursor)}
      ORDER BY i.created_at DESC, i.id DESC
      -- One row past the page says whether there is a next one.
      LIMIT ${query.limit + 1}
    `),
    /*
     * Everything the filters match, ignoring the cursor: the "of N" in
     * "Showing 100 of 187" and the bell's count. A separate count, not
     * COUNT(*) OVER (), because the window would only count rows past the
     * cursor.
     */
    total: await tx.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM inbox_item i
      WHERE i.recipient_teammate_id = ${session.teammateId}::uuid
        AND ${ackStateFilter}
        ${kindFilters}
    `),
    /*
     * Items per filter group under the SAME status and severity, ignoring the
     * category and group (#546): the counts the Category buttons show, so a
     * group reads how much is in it before it is chosen.
     */
    counts: await tx.execute<{ category: string; n: string }>(sql`
      SELECT i.category, count(*)::text AS n
      FROM inbox_item i
      WHERE i.recipient_teammate_id = ${session.teammateId}::uuid
        AND ${ackStateFilter}
        ${kindFiltersSql({ severity: query.severity })}
      GROUP BY i.category
    `),
  }))

  const groupCounts = Object.fromEntries(INBOX_CATEGORY_GROUPS.map((g) => [g, 0])) as Record<InboxCategoryGroup, number>
  for (const r of counts) groupCounts[inboxCategoryGroup(r.category)] += Number(r.n)

  const hasMore = rows.length > query.limit
  const page = hasMore ? rows.slice(0, query.limit) : [...rows]
  const total = Number(totalRows[0]?.n ?? 0)
  const nextCursor = hasMore ? (page[page.length - 1]?.page_cursor ?? null) : null
  // Strip the helper column from the response shape so callers don't see it.
  const items = page.map(({ page_cursor: _c, ...rest }) => rest)
  // viewer_is_admin: whether the drawer may offer an admin page (#573). The
  // admin middleware's own test (isAdminRole); the pages still gate themselves.
  return { items, total, next_cursor: nextCursor, group_counts: groupCounts, viewer_is_admin: isAdminRole(session.role) }
})
