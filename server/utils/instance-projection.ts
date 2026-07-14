/*
 * Shared per-instance projection (ADR-0005 decision 3 — device visibility).
 *
 * GET /api/v1/me/instances (owner-scoped) and GET /api/v1/admin/instances
 * (region-scoped) compute the SAME per-instance fields:
 *
 *   - last_emission  — MAX(attribution_record.ts_event) for the instance
 *   - spend_usd_mtd  — SUM(cost_usd) this calendar month for the instance
 *   - revoked        — ts_actual_end IS NOT NULL
 *   - silent         — active (not revoked) but no emission in >24h (the
 *                      "went-silent" anomaly surfaced per-row)
 *
 * The two endpoints differ ONLY in their scoping predicate (teammate_id vs
 * region_id) and the admin variant's extra owning-teammate columns. Both alias
 * `instance_attestation` as `ia`, so the metric subqueries compose into either
 * query as a shared fragment, and the row→DTO projection is a single function —
 * keeping the silent-window rule and spend formatting in one place so the dev
 * and admin views can't drift.
 */
import { sql, type SQL } from 'drizzle-orm'

/** Active instance with no emission in this many hours counts as "silent". */
export const SILENT_AFTER_HOURS = 24

/**
 * The per-instance metric columns (last_emission, spend_usd_mtd), as a SQL
 * fragment selecting against the `ia` alias of instance_attestation. `monthStartIso`
 * bounds the MTD spend sum. Embed verbatim in either endpoint's SELECT list.
 */
export function instanceMetricColumns(monthStartIso: string): SQL {
  return sql`
    (SELECT MAX(ar.ts_event)::text
       FROM attribution_record ar
      WHERE ar.instance_id = ia.instance_id)                   AS last_emission,
    COALESCE((SELECT SUM(ar.cost_usd)
       FROM attribution_record ar
      WHERE ar.instance_id = ia.instance_id
        AND ar.ts_event >= ${monthStartIso}::timestamptz), 0)::text AS spend_usd_mtd
  `
}

/** The raw row fields both endpoints' metric/identity columns produce. */
export interface InstanceMetricRow {
  instance_id: string
  tool: string
  raw_project_code: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
}

/** The projected per-instance shape (revoked/silent derived, spend formatted). */
export interface ProjectedInstance {
  instance_id: string
  tool: string
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  silent: boolean
}

/**
 * Project a raw instance row to the shared DTO: derive revoked/silent and format
 * spend. `silentCutoffMs` is the epoch-ms threshold below which the last emission
 * counts as silent (now - SILENT_AFTER_HOURS). A never-emitted active instance is
 * silent — that IS the signal worth surfacing.
 */
export function projectInstanceRow(r: InstanceMetricRow, silentCutoffMs: number): ProjectedInstance {
  const revoked = r.ts_actual_end !== null
  const lastMs = r.last_emission ? new Date(r.last_emission).getTime() : null
  const silent = !revoked && (lastMs === null || lastMs < silentCutoffMs)
  return {
    instance_id: r.instance_id,
    tool: r.tool,
    project: r.raw_project_code,
    ts_start: r.ts_start,
    ts_actual_end: r.ts_actual_end,
    last_emission: r.last_emission,
    spend_usd_mtd: Number(r.spend_usd_mtd).toFixed(2),
    revoked,
    silent,
  }
}

/**
 * Compute the month-start ISO + silent-cutoff epoch-ms both endpoints derive from
 * the same `now`. Returned together so the two views stay in lockstep.
 */
export function instanceProjectionWindow(now: Date): {
  monthStartIso: string
  silentCutoffMs: number
} {
  const monthStartIso = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString()
  const silentCutoffMs = now.getTime() - SILENT_AFTER_HOURS * 60 * 60_000
  return { monthStartIso, silentCutoffMs }
}
