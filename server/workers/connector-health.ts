/*
 * Connector-health / sync-conflict producer worker.
 *
 * Wave 1c (MVP-Lite convergence): emits sync-conflict inbox items from
 * pending rows in the sync_conflict table.
 *
 * The dispatch.ts inbox category set declares three "connector-class"
 * categories: sync-conflict, structural-conflict, connector-health. Only
 * sync-conflict has a real source table today (drizzle/schema/sync.ts).
 * The other two are stubs deferred to a future wave — see TODO comments
 * in dispatch.ts. This worker therefore covers sync-conflict only, and
 * is named connector-health for forward compatibility (the same worker
 * will later grow to emit the other two categories once their source
 * tables exist).
 *
 * Body shape MUST match app/components/inbox/DrawerBodySyncConflict.vue:
 *   { field, manual, sync, source, ... }
 * We pick the FIRST top-level key that diverges between manual_row_snapshot
 * and sync_row_payload and report it. The body also carries a
 * sync_conflict_id field for traceability + idempotency.
 *
 * Per-tick cap: SCAN_LIMIT (200) on the pending-conflicts SELECT. A
 * misbehaving connector that lands thousands of conflicts must not
 * dispatch all of them in one tick. The result carries
 * pendingConflictsTruncated so operators can wire an alert if the cap
 * is hit on consecutive runs.
 *
 * Routing: sync-conflict is dispatched WITHOUT a recipient hint, so
 * dispatchInbox routes to admins (resolveAdmins). When the target_table
 * is `project` we also set relatedEntityKind=project + relatedEntityId
 * so the drawer's "Open project" link resolves a baseline allocation.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'

export interface ConnectorHealthResult {
  pendingConflictsScanned: number
  alertsDispatched: number
  skippedExisting: number
  /*
   * True if the SELECT hit the per-tick cap. The next scheduled tick
   * picks up the tail; operators see this in worker logs and can wire
   * an alert if it stays true for consecutive runs (suggests a
   * misbehaving connector).
   */
  pendingConflictsTruncated: boolean
  /*
   * Count of un-replayed owed bills (pending_placement.placed_at IS NULL) whose
   * earliest sighting (first_seen_at) is older than OWED_BILL_GRACE_DAYS — the
   * mig-0066 "alert if any age past a grace window" signal. > 0 means owed bills
   * are stuck un-placed (e.g. placement-sync wedged, or a directory fault),
   * spend that is silently not landing in any cost-centre report.
   */
  agedOwedBills: number
}

// Per-tick cap on conflict scan. A misbehaving connector that lands
// thousands of conflicts must not produce thousands of inbox items in
// a single dispatch pass.
const SCAN_LIMIT = 200

// Grace window for un-replayed owed bills (mig 0066). placement-sync drains the
// queue on its own cadence; a row sitting un-placed past this is stuck (worker
// wedged / persistent directory fault), so its owed spend never reaches a
// cost-centre report. 7 days >> the placement cadence — well past any transient.
const OWED_BILL_GRACE_DAYS = 7

type SyncConflictRow = {
  id: string
  connector_id: string
  target_table: string
  target_pk: string
  manual_row_snapshot: Record<string, unknown>
  sync_row_payload: Record<string, unknown>
} & Record<string, unknown>

interface FieldDiff {
  field: string
  manual: string
  sync: string
}

export async function runConnectorHealth(
  db: PostgresJsDatabase<typeof schema>,
  _opts?: { now?: Date },
): Promise<ConnectorHealthResult> {
  const rows = await db.execute<SyncConflictRow>(sql`
    SELECT
      id::text AS id,
      connector_id,
      target_table,
      target_pk::text AS target_pk,
      manual_row_snapshot,
      sync_row_payload
    FROM sync_conflict
    WHERE resolution = 'pending'
    ORDER BY detected_at
    LIMIT ${SCAN_LIMIT + 1}
  `)
  const truncated = rows.length > SCAN_LIMIT
  const scanRows = truncated ? rows.slice(0, SCAN_LIMIT) : rows

  let dispatched = 0
  let skipped = 0

  for (const r of scanRows) {
    // Idempotency: skip if an unresolved sync-conflict inbox_item already
    // carries this sync_conflict_id in its body. We match on the jsonb
    // field rather than relatedEntityId because non-project targets reuse
    // relatedEntityKind values that don't have allocation context.
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM inbox_item
      WHERE category = 'sync-conflict'
        AND body->>'sync_conflict_id' = ${r.id}
        AND ack_state IN ('unread', 'read', 'acknowledged')
      LIMIT 1
    `)
    if (existing.length > 0) {
      skipped += 1
      continue
    }

    const manual = isRecord(r.manual_row_snapshot) ? r.manual_row_snapshot : {}
    const sync = isRecord(r.sync_row_payload) ? r.sync_row_payload : {}
    const diff = findFirstDiff(manual, sync)

    const subject = await buildSubject(db, r)

    const body: Record<string, unknown> = {
      sync_conflict_id: r.id,
      field: diff?.field ?? 'Field',
      manual: diff?.manual ?? '—',
      sync: diff?.sync ?? '—',
      source: r.connector_id,
    }

    const isProject = r.target_table === 'project'
    await dispatchInbox(db, {
      category: 'sync-conflict',
      severity: 'info',
      subject,
      body,
      relatedEntityKind: isProject ? 'project' : r.target_table,
      // target_pk is a UUID per the schema; non-project entity kinds are
      // still UUIDs (the column type is uuid). Pass it through unchanged.
      relatedEntityId: r.target_pk,
    })
    dispatched += 1
  }

  // ── Owed-bill aging alert (mig 0066: "alert if any age past a grace window") ──
  // Count un-replayed owed bills whose earliest sighting is past the grace window.
  // If any exist, dispatch ONE attention item to admins. Idempotent like the
  // sync-conflict loop: skip if an unresolved connector-health item already carries
  // the aged-owed-bills marker, so we don't pile a new row on every tick. Once the
  // admin acks/resolves it (or the backlog clears), the marker is gone and a still-
  // stuck backlog re-fires.
  const agedRows = await db.execute<{ aged: string }>(sql`
    SELECT count(*)::text AS aged
    FROM pending_placement
    WHERE placed_at IS NULL
      AND first_seen_at < now() - (${OWED_BILL_GRACE_DAYS} * INTERVAL '1 day')
  `)
  const agedOwedBills = Number(agedRows[0]?.aged ?? '0')

  if (agedOwedBills > 0) {
    const existingAged = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM inbox_item
      WHERE category = 'connector-health'
        AND body->>'aged_owed_bills' = 'true'
        AND ack_state IN ('unread', 'read', 'acknowledged')
      LIMIT 1
    `)
    if (existingAged.length === 0) {
      await dispatchInbox(db, {
        category: 'connector-health',
        severity: 'attention',
        subject: `${agedOwedBills} owed bill${agedOwedBills === 1 ? '' : 's'} un-placed past ${OWED_BILL_GRACE_DAYS} days`,
        body: {
          aged_owed_bills: true,
          count: agedOwedBills,
          grace_days: OWED_BILL_GRACE_DAYS,
        },
      })
    }
  }

  return {
    pendingConflictsScanned: scanRows.length,
    alertsDispatched: dispatched,
    skippedExisting: skipped,
    pendingConflictsTruncated: truncated,
    agedOwedBills,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function findFirstDiff(
  manual: Record<string, unknown>,
  sync: Record<string, unknown>,
): FieldDiff | null {
  // Iterate the union of keys in a stable order. We prefer keys present
  // in the manual snapshot first (developer-authored is the canonical
  // source per data-model.md §Sync-vs-manual provenance), then any
  // sync-only keys.
  const seen = new Set<string>()
  const order: string[] = []
  for (const k of Object.keys(manual)) {
    seen.add(k)
    order.push(k)
  }
  for (const k of Object.keys(sync)) {
    if (!seen.has(k)) order.push(k)
  }
  for (const k of order) {
    const m = manual[k]
    const s = sync[k]
    if (!deepEqual(m, s)) {
      return { field: humanizeField(k), manual: format(m), sync: format(s) }
    }
  }
  return null
}

/*
 * Order-insensitive structural equality. JSON.stringify is NOT
 * canonical equality: postgres jsonb returns keys in whichever order
 * the storage layer pleases, so `{a:1,b:2}` and `{b:2,a:1}` would
 * compare as different under stringify and produce false-positive
 * "divergence" inbox items. Recursive deep-equal with key-sorting
 * removes that footgun.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bArr = b as unknown[]
    if (a.length !== bArr.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], bArr[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false
    if (!deepEqual(aObj[k], bObj[k])) return false
  }
  return true
}

function format(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function humanizeField(k: string): string {
  // costOwningUnit / cost_owning_unit → "Cost owning unit"
  const spaced = k
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

async function buildSubject(
  db: PostgresJsDatabase<typeof schema>,
  r: SyncConflictRow,
): Promise<string> {
  if (r.target_table === 'project') {
    const rows = await db.execute<{ display_name: string; code: string }>(sql`
      SELECT display_name, code FROM project WHERE id = ${r.target_pk}::uuid LIMIT 1
    `)
    const proj = rows[0]
    if (proj) {
      return `${r.connector_id} reports conflict on project ${proj.display_name}`
    }
  }
  return `${r.connector_id} reports a conflict on ${r.target_table}`
}
