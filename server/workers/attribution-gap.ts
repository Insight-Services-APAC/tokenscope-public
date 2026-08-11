/*
 * attribution-gap worker — the PER-INSTANCE "minting bearers but not
 * attributing" detector.
 *
 * WHY THIS EXISTS (the 2026-07-24 dead-zone outage). A single instance stopped
 * being attributed 30 days after enrolment while it was still emitting: the
 * joiner's selection predicate used enrolment age as a liveness proxy, so an
 * open instance past the age cap matched no clause. Its exports were accepted by
 * the Azure DCE (HTTP 204) and never joined. Every existing alarm was blind:
 *
 *   - went-silent      → fires only on an OPEN bearer-auth-failed row. The
 *                        credential was fine; /bearer returned 200 all along.
 *   - read-path-health → gates on FLEET-wide signals (a zero-write streak across
 *                        the whole reader, MAX(last_bearer_at) over every
 *                        instance). One starved instance never moves either, so
 *                        it could not fire — and cannot fire for the NEXT
 *                        selection-predicate bug either.
 *   - mitigation-query → only ENDED instances with zero attribution ever. This
 *                        one was open and had months of records.
 *
 * So the outage class "one instance is alive and emitting, and its spend is
 * going nowhere" had NO detector. This is it. It is deliberately about the gap
 * between two facts we already store, not about any particular cause — a future
 * bug anywhere between ingest and attribution_record surfaces the same way.
 *
 * SIGNAL: last_bearer_at (the emit/write side — stamped on every /bearer mint,
 * which necessarily precedes every export) versus MAX(attribution_record.ts_event)
 * (the read/join side). A healthy instance keeps these within minutes of each
 * other. A starved one has a growing gap while the bearer side stays fresh.
 *
 * FALSE-POSITIVE DISCIPLINE — the reason this is narrower than it could be:
 *   1. A bearer mint does NOT imply spend. The plugin's SessionStart hook and
 *      /tokenscope:status both mint without emitting, so "launched Claude Code
 *      and typed nothing" legitimately produces a mint with no attribution. That
 *      is why the gap threshold is DAYS, not minutes.
 *   2. We require the instance to have attributed BEFORE (MAX(ts_event) NOT
 *      NULL). This is the REGRESSION shape — it worked, then stopped — and it
 *      excludes a fresh enrolment that has simply never spent yet, which is
 *      indistinguishable from a broken one at this layer.
 *   3. Every gate the joiner itself applies is re-applied (ts_purged,
 *      attestation_state, E2 teammate revocation), so an instance the joiner is
 *      CORRECTLY ignoring is never reported as a victim.
 *
 * Never auto-remediates. It raises a per-instance health row + one admin inbox
 * item, and auto-resolves both when the gap closes.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox } from '../notifications/dispatch'

/** Any drizzle/postgres-js connection — findAttributionGaps issues raw SQL only. */
type AnyDb = PostgresJsDatabase<Record<string, never>> | PostgresJsDatabase<typeof schema> | PostgresJsDatabase<Record<string, unknown>>

/** instance_attestation_health.status for this signal. */
export const ATTRIBUTION_GAP = 'attribution-gap'

/*
 * How stale attribution may fall behind the last bearer mint before it counts as
 * a gap. Days, not hours: a mint proves the CLI ran, not that it spent (see
 * false-positive discipline above), and a developer can plausibly launch without
 * spending for a day or two. 72h still detects a dead zone in three days rather
 * than the nineteen it actually took.
 */
const DEFAULT_GAP_HOURS = 72

/*
 * How recently the instance must have minted to count as ALIVE. An instance
 * nobody has used for a week is idle, not starved — its attribution being stale
 * is correct, not a defect.
 */
const DEFAULT_LIVE_HOURS = 24

export interface AttributionGapInstance {
  instanceId: string
  teammateId: string | null
  email: string | null
  lastBearerAt: string
  lastAttributedAt: string | null
  gapHours: number
}

export interface AttributionGapResult {
  scanned: number
  gapsFound: number
  alertsDispatched: number
  skippedExisting: number
  autoResolved: number
  instances: AttributionGapInstance[]
}

/**
 * Instances that are demonstrably alive (recent bearer mint) but whose
 * attribution has fallen days behind. Exported so the admin surface and the
 * worker share ONE predicate — an operator-facing list that disagreed with the
 * alerting predicate would be worse than no list.
 *
 * `regionId` MUST default to null/omitted, never be narrowed unconditionally:
 * the worker (runAttributionGap) calls this with no regionId at all, and
 * anything that forced a region here would re-create the exact
 * silent-attribution outage this detector exists to catch — see the header.
 * The admin diagnostics route is the only caller that ever passes one, and
 * only for a region-scoped `admin` session.
 */
export async function findAttributionGaps(
  // Deliberately schema-agnostic: this runs raw SQL only, and it must be
  // callable BOTH from the worker (typed schema) and from the admin diagnostics
  // route (RLS-scoped connection, generic schema) — the two sharing one
  // predicate is the point.
  db: AnyDb,
  opts: { gapHours?: number; liveHours?: number; limit?: number; regionId?: string | null } = {},
): Promise<AttributionGapInstance[]> {
  const gapHours = Number.isFinite(opts.gapHours) && (opts.gapHours as number) > 0 ? (opts.gapHours as number) : DEFAULT_GAP_HOURS
  const liveHours = Number.isFinite(opts.liveHours) && (opts.liveHours as number) > 0 ? (opts.liveHours as number) : DEFAULT_LIVE_HOURS
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? (opts.limit as number) : 200
  const regionId = opts.regionId ?? null
  const regionClause = regionId ? sql`AND sa.region_id = ${regionId}::uuid` : sql``

  const rows = await db.execute<{
    instance_id: string
    teammate_id: string | null
    email: string | null
    last_bearer_at: string
    last_attributed_at: string | null
    gap_hours: string
  }>(sql`
    SELECT sa.instance_id::text                                    AS instance_id,
           sa.teammate_id::text                                    AS teammate_id,
           t.email                                                 AS email,
           sa.last_bearer_at::text                                 AS last_bearer_at,
           MAX(ar.ts_event)::text                                  AS last_attributed_at,
           (EXTRACT(EPOCH FROM (sa.last_bearer_at - MAX(ar.ts_event))) / 3600)::numeric(12,2)::text AS gap_hours
      FROM instance_attestation sa
      LEFT JOIN teammate t ON t.id = sa.teammate_id
      JOIN attribution_record ar ON ar.instance_id = sa.instance_id
     WHERE sa.ts_purged IS NULL
       AND sa.ts_actual_end IS NULL                       -- open: a closed instance is expected to go quiet
       AND sa.attestation_state IN ('attested', 'unassigned')
       ${regionClause}
       -- E2 (ADR-0005): an instance whose teammate was revoked after enrolment is
       -- CORRECTLY not attributed. Mirror the joiner's own gate so we never
       -- report a victim that is really a policy outcome.
       AND NOT EXISTS (
         SELECT 1 FROM teammate tr
          WHERE tr.id = sa.teammate_id AND tr.revoked_at IS NOT NULL AND tr.revoked_at > sa.ts_start
       )
       -- ALIVE: minting right now.
       AND sa.last_bearer_at >= NOW() - (${liveHours} * INTERVAL '1 hour')
     GROUP BY sa.instance_id, sa.teammate_id, t.email, sa.last_bearer_at
     -- STARVED: the join side has fallen days behind the emit side. The INNER
     -- JOIN above already requires it to have attributed before (the regression
     -- shape) — a never-attributed instance is not distinguishable here from one
     -- that has simply never spent.
    HAVING sa.last_bearer_at - MAX(ar.ts_event) > (${gapHours} * INTERVAL '1 hour')
     ORDER BY sa.last_bearer_at - MAX(ar.ts_event) DESC
     LIMIT ${limit}
  `)

  return [...rows].map((r) => ({
    instanceId: r.instance_id,
    teammateId: r.teammate_id,
    email: r.email,
    lastBearerAt: r.last_bearer_at,
    lastAttributedAt: r.last_attributed_at,
    gapHours: Number(r.gap_hours),
  }))
}

/**
 * Scan for attribution gaps, raise a health row + admin inbox item per affected
 * instance, and auto-resolve instances whose gap has closed.
 */
export async function runAttributionGap(
  db: PostgresJsDatabase<typeof schema>,
  opts: { gapHours?: number; liveHours?: number; now?: Date } = {},
): Promise<AttributionGapResult> {
  const now = opts.now ?? new Date()
  const instances = await findAttributionGaps(db, opts)
  const affected = new Set(instances.map((i) => i.instanceId))

  // ── Auto-resolve first ────────────────────────────────────────────────────
  // Any open signal for an instance NOT in the current gap set has recovered:
  // either the joiner caught up or the instance went idle. Done before
  // dispatching so a recovered-then-relapsed instance gets a fresh episode.
  // Exclusion built as an explicit NOT IN list (sql.join), not `<> ALL($1::uuid[])`:
  // a JS array does not bind as a Postgres array in that position through drizzle.
  const stillAffected = [...affected]
  const notAffected = stillAffected.length
    ? sql`AND instance_id NOT IN (${sql.join(stillAffected.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const resolvedHealth = await db.execute<{ id: string }>(sql`
    UPDATE instance_attestation_health
       SET resolved_at = ${now.toISOString()}::timestamptz
     WHERE status = ${ATTRIBUTION_GAP}
       AND resolved_at IS NULL
       ${notAffected}
    RETURNING id::text AS id
  `)
  const resolvedInbox = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item
       SET ack_state = 'resolved', ack_at = ${now.toISOString()}::timestamptz
     WHERE category = ${ATTRIBUTION_GAP}
       AND related_entity_kind = 'instance'
       AND ack_state IN ('unread', 'read', 'acknowledged')
       ${stillAffected.length ? sql`AND related_entity_id NOT IN (${sql.join(stillAffected.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
    RETURNING id::text AS id
  `)
  const autoResolved = [...resolvedHealth].length + [...resolvedInbox].length

  let alertsDispatched = 0
  let skippedExisting = 0

  for (const inst of instances) {
    // Health row: idempotent per episode (partial unique index pattern, mirrors
    // recordBearerAuthFailed).
    await db.execute(sql`
      INSERT INTO instance_attestation_health (instance_id, status, payload)
      SELECT ${inst.instanceId}::uuid, ${ATTRIBUTION_GAP},
             ${JSON.stringify({ detectedBy: 'attribution-gap', gapHours: inst.gapHours, lastAttributedAt: inst.lastAttributedAt })}::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM instance_attestation_health
          WHERE instance_id = ${inst.instanceId}::uuid AND status = ${ATTRIBUTION_GAP} AND resolved_at IS NULL
       )
      ON CONFLICT DO NOTHING
    `)

    // One open inbox item per instance per episode.
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM inbox_item
       WHERE category = ${ATTRIBUTION_GAP}
         AND related_entity_kind = 'instance'
         AND related_entity_id = ${inst.instanceId}::uuid
         AND ack_state IN ('unread', 'read', 'acknowledged')
       LIMIT 1
    `)
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const days = Math.floor(inst.gapHours / 24)
    const dispatched = await dispatchInbox(db, {
      category: ATTRIBUTION_GAP,
      // Explicit, though dispatch's defaultSeverity already maps this category to
      // 'urgent' — stated here so the page-worthiness is legible at the call site
      // rather than only in the dispatcher's switch. (Equivalent-mutant by design:
      // removing it changes nothing, which is the point.)
      severity: 'urgent',
      subject: `Device is emitting but its spend is not being attributed (${days}d behind)`,
      body: {
        instance_id: inst.instanceId,
        teammate: inst.email,
        teammate_id: inst.teammateId,
        last_bearer_at: inst.lastBearerAt,
        last_attributed_at: inst.lastAttributedAt,
        gap_hours: inst.gapHours,
        summary:
          'This device minted an ingest credential recently (so it is running and exporting) but its most recent attributed spend is days older. Emission auth is healthy; the loss is between ingest and attribution_record.',
        hint:
          'Go to Admin → Diagnostics → Attribution gaps. Press "Diagnose" on the device FIRST: it reports whether its telemetry is in ingest at all for the window, which is what separates a joiner fault (ours — recoverable by re-reading) from a client fault (theirs — nothing to re-read, check the reported plugin/CLI versions). If it is ours, use the re-read control on the same card; the runbook is docs/development/joiner-dead-zone-recovery.md. Azure accepting an export (HTTP 204) does NOT mean it was attributed.',
        detectedAt: now.toISOString(),
      },
      relatedEntityKind: 'instance',
      relatedEntityId: inst.instanceId,
    })
    if (dispatched.length > 0) alertsDispatched += 1
  }

  return {
    scanned: instances.length,
    gapsFound: instances.length,
    alertsDispatched,
    skippedExisting,
    autoResolved,
    instances,
  }
}
