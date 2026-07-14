/*
 * privileged-identity-cleanup — retroactively apply the directory-exclusion
 * policy (directory_exclusion_pattern, mig 0083) to teammate rows that were
 * provisioned BEFORE a pattern was added. A privileged/service account
 * (Rob's `-cld@…onmicrosoft.com`) should never have been a teammate; this
 * worker finds such rows and, for the provably-inert ones, retires them.
 *
 * SAFETY — this worker CAN deactivate teammates and revoke ownerships, so it is
 * deliberately conservative (adversarial-review hardened):
 *
 *  - REPORT by default. A plain run mutates NOTHING: it counts + audits the
 *    would-affect set. Destructive apply requires opts.apply === true (the
 *    signed HMAC worker body), so it is cron/CLI/HMAC-only — NOT on the admin
 *    one-click "Run now" surface (see shared/workers/ui-triggerable.ts).
 *  - HARD CAP. If a run would clean more than `cap.maxAbs` rows OR more than
 *    `cap.maxPct` of active teammates, it ABORTS and mutates nothing — the
 *    primary defense against a fat-fingered pattern (e.g. `*@example.com`)
 *    mass-deactivating the company. Raise the cap explicitly for a real bulk
 *    cleanup.
 *  - TIGHT inertness gate. "Never emitted" is NOT enough (finance/PMs/owners/
 *    admins never emit). A row is auto-cleaned ONLY when it is excluded-shaped
 *    AND role 'developer' AND not a region_leader (by oid) AND has no
 *    instance_attestation AND no attribution_record AND no live oauth_token AND
 *    no active allocation. Anything else → flagged for an admin, never touched.
 *  - FAIL-OPEN. No patterns configured ⇒ nothing matches ⇒ nothing cleaned.
 *
 * Framing mirrors region-reenrichment's "only touch never-live rows" contract,
 * but stricter because the action (deactivate + de-own) is heavier than a move.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { getDirectoryUserByOid, type DirectoryUser } from '../azure/directory'
import { isExcludedUpn, loadDirectoryExclusionPatterns } from '../utils/directory-exclusions'

type Db = PostgresJsDatabase<typeof schema>

export interface PrivilegedIdentityCleanupResult {
  mode: 'report' | 'apply'
  /** Active real-oid teammates examined. */
  considered: number
  /** Rows whose directory UPN matches an exclusion pattern. */
  excluded: number
  /** Excluded AND inert-and-safe → would be (report) / were (apply) cleaned. */
  candidates: number
  /** Excluded but NOT inert/safe (emitting, elevated role, leader, …) → admin. */
  flagged: number
  /** Rows actually deactivated + member-assignments closed (apply mode, non-aborted).
   *  Candidates never hold an active ownership/PM role (those are flagged), so
   *  this never strips standing — only inert developer rows. */
  cleaned: number
  /** Cap tripped: candidates exceeded the limit → nothing mutated this run. */
  aborted: boolean
  /** Stopped at the per-run scan budget before exhausting the population. */
  saturated: boolean
  errors: number
}

interface Cap {
  maxAbs: number
  maxPct: number
}

interface CandidateRow {
  id: string
  entra_oid: string
  email: string
  upn: string | null
}

export async function runPrivilegedIdentityCleanup(
  db: Db,
  opts?: {
    apply?: boolean
    cap?: Partial<Cap>
    lookupByOid?: (oid: string) => Promise<DirectoryUser | null>
    limit?: number
  },
): Promise<PrivilegedIdentityCleanupResult> {
  const mode = opts?.apply ? 'apply' : 'report'
  const lookupByOid = opts?.lookupByOid ?? getDirectoryUserByOid
  const limit = opts?.limit ?? 20_000
  const PAGE = 500
  const cap: Cap = { maxAbs: opts?.cap?.maxAbs ?? 50, maxPct: opts?.cap?.maxPct ?? 0.1 }
  const result: PrivilegedIdentityCleanupResult = {
    mode,
    considered: 0,
    excluded: 0,
    candidates: 0,
    flagged: 0,
    cleaned: 0,
    aborted: false,
    saturated: false,
    errors: 0,
  }

  const patterns = await loadDirectoryExclusionPatterns(db)
  if (patterns.length === 0) return result // fail-open: no policy → no cleanup

  const candidates: CandidateRow[] = []
  let cursor = ''
  scan: while (result.considered < limit) {
    const rows = await db.execute<{ id: string; entra_oid: string; email: string }>(sql`
      SELECT id::text AS id, entra_oid, email FROM teammate
      WHERE is_active = TRUE AND NOT provisional
        AND entra_oid NOT LIKE 'bill:%' AND entra_oid NOT LIKE 'provisional:%'
        AND id::text > ${cursor}
      ORDER BY id
      LIMIT ${PAGE}
    `)
    const page = [...rows]
    if (page.length === 0) break
    cursor = page[page.length - 1]!.id

    for (const row of page) {
      if (result.considered >= limit) {
        result.saturated = true
        break scan
      }
      result.considered++
      try {
        const dir = await lookupByOid(row.entra_oid)
        if (!dir || !isExcludedUpn(dir.upn, patterns)) continue
        result.excluded++

        // Tight inertness + safety gate — one query. "Never emitted" is NOT
        // enough (finance/PMs/owners never emit), so also block on any standing:
        // an ACTIVE cost-centre ownership or an open MANAGER (PM) assignment
        // means a human should re-home that responsibility before the account
        // is retired — flag, don't auto-deactivate. (An open plain-MEMBER
        // assignment is inert billing/attribution and is safe to close.)
        const safety = [
          ...(await db.execute<{
            role: string
            is_leader: boolean
            has_instance: boolean
            has_attribution: boolean
            has_live_token: boolean
            has_allocation: boolean
            has_active_ownership: boolean
            has_pm_assignment: boolean
          }>(sql`
            SELECT t.role,
              EXISTS(SELECT 1 FROM region_leader rl WHERE rl.leader_oid = t.entra_oid AND rl.revoked_at IS NULL) AS is_leader,
              EXISTS(SELECT 1 FROM instance_attestation ia WHERE ia.teammate_id = t.id) AS has_instance,
              EXISTS(SELECT 1 FROM attribution_record ar WHERE ar.teammate_id = t.id) AS has_attribution,
              EXISTS(SELECT 1 FROM oauth_token ot WHERE ot.teammate_id = t.id AND ot.revoked_at IS NULL) AS has_live_token,
              EXISTS(SELECT 1 FROM allocation al WHERE al.teammate_id = t.id AND upper_inf(al.effective)) AS has_allocation,
              EXISTS(SELECT 1 FROM cou_owner co WHERE co.teammate_id = t.id AND co.revoked_at IS NULL) AS has_active_ownership,
              EXISTS(SELECT 1 FROM project_assignment pa WHERE pa.teammate_id = t.id AND pa.role = 'manager' AND upper_inf(pa.effective)) AS has_pm_assignment
            FROM teammate t WHERE t.id = ${row.id}::uuid
          `)),
        ][0]
        const safe =
          safety != null &&
          safety.role === 'developer' &&
          !safety.is_leader &&
          !safety.has_instance &&
          !safety.has_attribution &&
          !safety.has_live_token &&
          !safety.has_allocation &&
          !safety.has_active_ownership &&
          !safety.has_pm_assignment
        if (!safe) {
          result.flagged++
          await recordAuditEvent(db, {
            eventType: 'teammate-excluded-flagged',
            actorSystem: 'privileged-identity-cleanup-worker',
            subjectKind: 'teammate',
            subjectId: row.id,
            payload: {
              oid: row.entra_oid,
              upn: dir.upn,
              email: row.email,
              reason: safety == null ? 'row-vanished' : 'not-inert',
              role: safety?.role ?? null,
            },
          })
          continue
        }
        result.candidates++
        candidates.push({ id: row.id, entra_oid: row.entra_oid, email: row.email, upn: dir.upn })
      } catch {
        result.errors++ // per-row isolation
      }
    }
  }

  if (mode === 'report' || candidates.length === 0) {
    await recordAuditEvent(db, {
      eventType: 'privileged-identity-cleanup-report',
      actorSystem: 'privileged-identity-cleanup-worker',
      subjectKind: 'platform',
      payload: { mode, considered: result.considered, excluded: result.excluded, candidates: result.candidates, flagged: result.flagged },
    })
    return result
  }

  // APPLY: cap check BEFORE any mutation. Abort the whole run if the blast
  // radius exceeds the limit — mutate nothing, leave a loud audit trail. Two
  // independent triggers: an absolute count (maxAbs) catches a big org, and a
  // PROPORTION of the company (maxPct) catches a small/mid org where a
  // fat-fingered pattern matches a large fraction (e.g. all 9 of a 9-person
  // org). No absolute floor on the proportion trigger — a floor created a dead
  // zone where 1–9 matches never aborted regardless of fraction. Small
  // legitimate runs pass a wider cap explicitly (opts.cap).
  const activeRows = [
    ...(await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM teammate WHERE is_active = TRUE AND NOT provisional`)),
  ][0]
  const activeCount = Number(activeRows?.n ?? '0')
  const overAbs = candidates.length > cap.maxAbs
  const overPct = activeCount > 0 && candidates.length / activeCount > cap.maxPct
  if (overAbs || overPct) {
    result.aborted = true
    await recordAuditEvent(db, {
      eventType: 'privileged-identity-cleanup-aborted',
      actorSystem: 'privileged-identity-cleanup-worker',
      subjectKind: 'platform',
      payload: { candidates: candidates.length, maxAbs: cap.maxAbs, maxPct: cap.maxPct, activeCount, reason: overAbs ? 'abs-cap' : 'pct-cap' },
    })
    return result
  }

  for (const c of candidates) {
    try {
      // All three mutations for one candidate are ATOMIC — a mid-candidate
      // failure must not leave a row de-owned/unassigned but still is_active
      // (a re-run wouldn't recognise it as a clean candidate to fix).
      let revokedOwner = 0
      let closedAssignments = 0
      await db.transaction(async (sp) => {
        revokedOwner = [
          ...(await sp.execute<{ id: string }>(sql`
            UPDATE cou_owner SET revoked_at = now()
            WHERE teammate_id = ${c.id}::uuid AND revoked_at IS NULL RETURNING id::text AS id
          `)),
        ].length
        closedAssignments = [
          ...(await sp.execute<{ id: string }>(sql`
            UPDATE project_assignment SET effective = tstzrange(lower(effective), now())
            WHERE teammate_id = ${c.id}::uuid AND upper_inf(effective) RETURNING id::text AS id
          `)),
        ].length
        await sp.execute(sql`UPDATE teammate SET is_active = FALSE WHERE id = ${c.id}::uuid`)
      })
      result.cleaned++
      await recordAuditEvent(db, {
        eventType: 'teammate-excluded-cleaned',
        actorSystem: 'privileged-identity-cleanup-worker',
        subjectKind: 'teammate',
        subjectId: c.id,
        payload: { oid: c.entra_oid, upn: c.upn, email: c.email, revoked_owner: revokedOwner, closed_assignments: closedAssignments },
      })
    } catch {
      result.errors++
    }
  }

  return result
}
