/*
 * Went-silent detector (ADR-0005 decision 4) — RE-ANCHORED on the real signal.
 *
 * OLD heuristic (telemetry absence) could not distinguish "broke while working"
 * from "stopped working": the server's only evidence of work IS the telemetry, so
 * its absence is ambiguous and fired on every overnight / between-tasks / idle
 * gap (a false-positive machine that trained users to ignore the bell).
 *
 * REPLACED with the unambiguous, server-observable symptom of the actual
 * disaster: a LIVE instance whose durable OAuth emit credential is being REJECTED
 * at /bearer (401), recorded by the bearer endpoint as a `bearer-auth-failed`
 * instance_attestation_health row. A 401 means the credential failed and OTLP
 * export has silently stopped — NOT that the dev is idle. This is the only
 * server-side signal that separates the two cases. (Client-side, /tokenscope:status
 * + the loud emit helper catch it too; this is the server-side backstop.)
 *
 * Per failure EPISODE: one alert per instance while a health row is open; a
 * resolve doesn't re-arm it (created_at >= detected_at dedup). Auto-resolves when
 * the credential works again (the health row resolves on a successful mint), so a
 * recovered instance's alert — and any stale telemetry-absence alert from the old
 * heuristic — self-clears.
 *
 * Routing: the OWNING teammate (recipientTeammateIdHint) — they re-enrol/restart.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { dispatchInbox, type InboxCategory } from '../notifications/dispatch'
import { BEARER_AUTH_FAILED } from '../db/instance-health'

export interface WentSilentResult {
  instancesFailing: number
  alertsDispatched: number
  skippedExisting: number
  autoResolved: number
}

// Kept as the inbox category (no UI/dispatch churn); the subject now states the
// real cause (credential rejected) rather than the old "telemetry went quiet".
const WENT_SILENT_CATEGORY = 'went-silent' as InboxCategory

interface FailingInstanceRow extends Record<string, unknown> {
  instance_id: string
  teammate_id: string
  teammate_email: string
  teammate_display_name: string | null
  raw_project_code: string | null
  detected_at: string
}

export async function runWentSilent(
  db: PostgresJsDatabase<typeof schema>,
  opts?: { now?: Date },
): Promise<WentSilentResult> {
  const now = opts?.now ?? new Date()

  // 1. Auto-resolve: any open went-silent alert whose instance NO LONGER has an
  //    open bearer-auth-failed signal (the credential recovered, or it was a
  //    stale alert from the retired telemetry-absence heuristic) is resolved.
  const resolved = await db.execute<{ id: string }>(sql`
    UPDATE inbox_item ii
       SET ack_state = 'resolved', ack_at = ${now.toISOString()}::timestamptz
     WHERE ii.category = ${WENT_SILENT_CATEGORY}
       AND ii.related_entity_kind = 'instance'
       AND ii.ack_state IN ('unread', 'read', 'acknowledged')
       AND NOT EXISTS (
         SELECT 1 FROM instance_attestation_health h
          WHERE h.instance_id = ii.related_entity_id
            AND h.status = ${BEARER_AUTH_FAILED}
            AND h.resolved_at IS NULL
       )
    RETURNING ii.id::text AS id
  `)
  const autoResolved = [...resolved].length

  // 2. Live instances with an OPEN bearer-auth-failed signal + an active teammate.
  //    (E2 parity: a teammate revoked after enrol is SUPPOSED to be rejected.)
  const rows = await db.execute<FailingInstanceRow>(sql`
    SELECT ia.instance_id::text                  AS instance_id,
           ia.teammate_id::text                  AS teammate_id,
           t.email                               AS teammate_email,
           t.display_name                        AS teammate_display_name,
           ia.raw_project_code                   AS raw_project_code,
           to_char(MAX(h.detected_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS detected_at
      FROM instance_attestation_health h
      JOIN instance_attestation ia ON ia.instance_id = h.instance_id
      JOIN teammate t ON t.id = ia.teammate_id
     WHERE h.status = ${BEARER_AUTH_FAILED}
       AND h.resolved_at IS NULL
       AND ia.ts_actual_end IS NULL
       AND NOT (t.revoked_at IS NOT NULL AND t.revoked_at > ia.ts_start)
     GROUP BY ia.instance_id, ia.teammate_id, t.email, t.display_name, ia.raw_project_code
  `)

  let alertsDispatched = 0
  let skippedExisting = 0

  for (const r of rows) {
    // Per-episode dedup: skip if an alert (ANY ack_state) already exists for this
    // instance created at/after the failure was detected. A resolve doesn't
    // re-arm; only a fresh failure (later detected_at) raises a new alert.
    const existing = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM inbox_item
       WHERE category = ${WENT_SILENT_CATEGORY}
         AND related_entity_kind = 'instance'
         AND related_entity_id = ${r.instance_id}::uuid
         AND created_at >= ${r.detected_at}::timestamptz
       LIMIT 1
    `)
    if (existing.length > 0) {
      skippedExisting += 1
      continue
    }

    const who = r.teammate_display_name?.trim() || r.teammate_email
    const projectSuffix = r.raw_project_code ? ` (${r.raw_project_code})` : ''

    const dispatched = await dispatchInbox(db, {
      category: WENT_SILENT_CATEGORY,
      severity: 'attention',
      subject: `TokenScope emission stopped for ${who}${projectSuffix} — emit credential rejected`,
      body: {
        instanceId: r.instance_id,
        teammate: who,
        detectedAt: r.detected_at,
        reason: 'bearer-auth-failed',
        hint: 'Your device emit credential was rejected (401) at /bearer, so telemetry stopped. Run /tokenscope:status; if NOT EMITTING, re-provision emit via the tokenscope-setup MCP prompt.',
      },
      relatedEntityKind: 'instance',
      relatedEntityId: r.instance_id,
      recipientTeammateIdHint: r.teammate_id,
    })
    if (dispatched.length > 0) {
      alertsDispatched += 1
    }
  }

  return {
    instancesFailing: rows.length,
    alertsDispatched,
    skippedExisting,
    autoResolved,
  }
}
