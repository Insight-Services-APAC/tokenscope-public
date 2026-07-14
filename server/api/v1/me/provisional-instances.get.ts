/*
 * GET /api/v1/me/provisional-instances — the provisional devices that claimed
 * THE AUTHENTICATED USER'S email, offered for explicit confirmation (emit-on-
 * install, slice 5; docs/design/emit-on-install-provisional-attribution.md
 * §Flows 3).
 *
 * Owner-scoping here is BY EMAIL MATCH, not by teammate_id: a provisional
 * instance is bound to a provisional SHADOW teammate (entra_oid='provisional:…'),
 * not to the signed-in real teammate, so the usual teammate_id predicate would
 * find nothing. We deliberately query the platform pool (NOT withRequestRls): the
 * shadow teammate sits in a default region/org placement, so RLS would hide the
 * row. The `claimed_email = <session email>` predicate IS the live gate — it
 * returns ONLY instances that claimed the caller's own email and leaks NOTHING
 * about any other email (no existence info, no peer rows).
 *
 * Per row we return just enough for the user to recognise + decide:
 *   instance_id, tool, device_hint (a non-reversible prefix of the hashed
 *   device-binding so multiple devices are distinguishable), first_seen
 *   (ts_start), last_seen (MAX attribution_record.ts_event), and the provisional
 *   spend-to-date this device has accrued under the claim.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireAuth } from '../../../auth/rbac'
import { getDb } from '../../../db'

interface ProvisionalRow extends Record<string, unknown> {
  instance_id: string
  tool: string
  device_binding_hash: string | null
  first_seen: string
  last_seen: string | null
  spend_usd: string
}

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const claimedEmail = session.email.trim().toLowerCase()

  const db = getDb()
  const rows = await db.execute<ProvisionalRow>(sql`
    SELECT
      ia.instance_id::text                                    AS instance_id,
      ia.tool                                                 AS tool,
      ia.notes->>'device_binding_hash'                        AS device_binding_hash,
      ia.ts_start::text                                       AS first_seen,
      (SELECT MAX(ar.ts_event)::text
         FROM attribution_record ar
        WHERE ar.instance_id = ia.instance_id)                AS last_seen,
      COALESCE((SELECT SUM(ar.cost_usd)
         FROM attribution_record ar
        WHERE ar.instance_id = ia.instance_id), 0)::text      AS spend_usd
    FROM instance_attestation ia
    WHERE ia.identity_state = 'provisional'
      AND ia.ts_actual_end IS NULL
      AND lower(ia.claimed_email) = ${claimedEmail}
    ORDER BY ia.ts_start DESC
  `)

  return {
    provisional_instances: [...rows].map((r) => ({
      instance_id: r.instance_id,
      tool: r.tool,
      // A short, non-reversible hint so a user can tell their devices apart
      // without exposing the full hashed binding.
      device_hint: r.device_binding_hash ? r.device_binding_hash.slice(0, 12) : null,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      provisional_spend_usd: Number(r.spend_usd).toFixed(2),
    })),
  }
})
