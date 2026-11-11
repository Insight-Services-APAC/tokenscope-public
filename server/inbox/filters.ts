/*
 * The inbox's filters as SQL, in ONE place (#574, #569).
 *
 * The list route (GET /api/v1/me/inbox) and "Mark all read" (POST
 * /api/v1/me/inbox/bulk) must select the same items for the same filters:
 * "Mark all read" under Data health · Urgent marks exactly what the list shows
 * under those filters, including the items past the first page. Two copies of
 * this would drift, so both call these.
 *
 * Every fragment is meant to be ANDed into a WHERE on `inbox_item i` that
 * already pins `i.recipient_teammate_id` to the caller.
 */
import { sql, type SQL } from 'drizzle-orm'
import {
  KNOWN_INBOX_CATEGORIES,
  categoriesInGroup,
  type InboxCategoryGroup,
} from '../../shared/inbox/categories'

export type InboxAckStateFilter =
  | 'unread' | 'read' | 'acknowledged' | 'dismissed' | 'resolved' | 'open' | 'closed'

export interface InboxFilters {
  ack_state?: InboxAckStateFilter
  category?: string
  group?: InboxCategoryGroup
  severity?: string
}

/** `open` = unread + read + acknowledged (unresolved); `closed` = dismissed + resolved. */
export function ackStateSql(state: InboxAckStateFilter | undefined): SQL {
  if (state === 'open') return sql`i.ack_state IN ('unread', 'read', 'acknowledged')`
  if (state === 'closed') return sql`i.ack_state IN ('dismissed', 'resolved')`
  if (state) return sql`i.ack_state = ${state}`
  return sql`TRUE`
}

/** Category, group and severity, each `AND ...` or empty. */
export function kindFiltersSql(f: Pick<InboxFilters, 'category' | 'group' | 'severity'>): SQL {
  const categoryFilter = f.category ? sql`AND i.category = ${f.category}` : sql``
  // Other also holds any category this build does not know (a newer producer
  // mid-deploy): the page badges those as Other, so the filter must find them.
  const inList = (cats: readonly string[]) => sql.join(cats.map((c) => sql`${c}`), sql`, `)
  const groupFilter = !f.group
    ? sql``
    : f.group === 'other'
      ? sql`AND (i.category IN (${inList(categoriesInGroup('other'))}) OR i.category NOT IN (${inList(KNOWN_INBOX_CATEGORIES)}))`
      : sql`AND i.category IN (${inList(categoriesInGroup(f.group))})`
  const severityFilter = f.severity ? sql`AND i.severity = ${f.severity}` : sql``
  return sql`${categoryFilter} ${groupFilter} ${severityFilter}`
}

/*
 * The list's page cursor (#569): the last row's (created_at, id), newest first.
 * created_at alone is not unique (a dispatcher fan-out writes several rows in
 * one statement, so they share NOW()), hence the id tiebreak — and the list's
 * ORDER BY carries the same pair.
 *
 * Wire form: `<created_at as UTC ISO with microseconds>_<uuid>`. The server
 * mints it (`next_cursor`), the client hands it back unchanged.
 */
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export interface InboxCursor { createdAt: string; id: string }

/** Null for anything that is not a cursor this server minted. */
export function parseInboxCursor(raw: string): InboxCursor | null {
  const m = CURSOR_RE.exec(raw)
  if (!m) return null
  // A real instant, not one Date.parse would roll over (2026-02-31 → 3 Mar),
  // which Postgres would then refuse as a 500.
  const d = new Date(m[1]!)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19) !== m[1]!.slice(0, 19)) return null
  return { createdAt: m[1]!, id: m[2]! }
}

/** SQL that renders a row's cursor; pairs with `parseInboxCursor`. */
export const CURSOR_SELECT_SQL = sql`to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '_' || i.id::text`

export function cursorSql(c: InboxCursor | null): SQL {
  return c ? sql`AND (i.created_at, i.id) < (${c.createdAt}::timestamptz, ${c.id}::uuid)` : sql``
}
