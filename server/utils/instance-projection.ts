/*
 * Shared per-instance projection (ADR-0005 decision 3 — device visibility).
 *
 * GET /api/v1/me/instances (owner-scoped) and GET /api/v1/admin/instances
 * (region-scoped) compute the SAME per-instance fields:
 *
 *   - last_emission  — MAX(attribution_record.ts_event) for the instance
 *   - spend_usd_mtd  — SUM(cost_usd) this calendar month for the instance
 *   - revoked        — ts_actual_end IS NOT NULL
 *   - state          — one of five, decided HERE and nowhere else (#592):
 *       revoked      the device was revoked
 *       cannot-send  the server is rejecting its credential (the open
 *                    bearer-auth-failed row the inbox alert also reads)
 *       sending      usage in the last 24 hours
 *       idle         no usage for 24 hours to 30 days, or connected in the
 *                    last 30 days and no usage yet
 *       not-in-use   no usage for over 30 days, or connected over 30 days ago
 *                    and never any usage
 *     Only cannot-send is a fault. Absence of usage cannot tell "broke while
 *     working" from "stopped working", which is why went-silent.ts stopped
 *     alerting on it and why idle and not-in-use warn nobody.
 *
 * The two endpoints differ ONLY in their scoping predicate (teammate_id vs
 * region_id) and the admin variant's extra owning-teammate columns. Both alias
 * `instance_attestation` as `ia`, so the metric subqueries compose into either
 * query as a shared fragment, and the row→DTO projection is a single function —
 * keeping the state rule and spend formatting in one place so the dev
 * and admin views can't drift.
 */
import { sql, type SQL } from 'drizzle-orm'
import { openBearerFailureExists } from '../db/instance-health'
import { INSTANCE_STATES, type InstanceState } from '../../shared/schemas/device-name'

/** Active instance with no emission in this many hours is no longer "sending". */
export const SILENT_AFTER_HOURS = 24

/** No usage for this many days (or none ever on an older enrolment): "not in use". */
export const NOT_IN_USE_AFTER_DAYS = 30

export { INSTANCE_STATES, type InstanceState }

/**
 * The per-instance metric columns (last_emission, spend_usd_mtd), as a SQL
 * fragment selecting against the `ia` alias of instance_attestation. `monthStartIso`
 * bounds the MTD spend sum. Embed verbatim in either endpoint's SELECT list.
 *
 * #619: `last_emission` looks in the not-in-use window first and reads the whole
 * history only when that finds nothing. `attribution_record` is partitioned by
 * month on `ts_event`, so the bounded MAX reads one or two partitions where the
 * unbounded one read every partition the device ever wrote to. COALESCE
 * evaluates its second argument only when the first is NULL, and a device with
 * a row in the window has its latest row there, so the value is the same either
 * way.
 *
 * Index (migrations 0173, 0174): `attribution_record_instance_ts` on
 * (instance_id, ts_event) INCLUDE (cost_usd). The latest row is then one probe
 * per partition, and the month's spend a range scan over the device's rows of
 * the month, where both used to find the device's rows through an index with
 * no ts_event. (Index-only where the visibility map allows; with RLS on, the
 * policies' columns still need the table.)
 */
export function instanceMetricColumns(w: { monthStartIso: string; notInUseCutoffMs: number }): SQL {
  const recentIso = new Date(w.notInUseCutoffMs).toISOString()
  return sql`
    COALESCE(
      (SELECT MAX(ar.ts_event)
         FROM attribution_record ar
        WHERE ar.instance_id = ia.instance_id
          AND ar.ts_event >= ${recentIso}::timestamptz),
      (SELECT MAX(ar.ts_event)
         FROM attribution_record ar
        WHERE ar.instance_id = ia.instance_id)
    )::text                                                     AS last_emission,
    COALESCE((SELECT SUM(ar.cost_usd)
       FROM attribution_record ar
      WHERE ar.instance_id = ia.instance_id
        AND ar.ts_event >= ${w.monthStartIso}::timestamptz), 0)::text AS spend_usd_mtd,
    ${openBearerFailureExists(sql`ia.instance_id`)}             AS cannot_send
  `
}

/**
 * The SQL twin of `projectInstanceRow`'s `state` (against the `ia` alias). The
 * two must agree, or a status filter would list rows whose badge says something
 * else; the admin route test pins that row for row.
 */
export function instanceStatePredicate(
  state: InstanceState,
  w: { silentCutoffMs: number; notInUseCutoffMs: number },
): SQL {
  const silentIso = new Date(w.silentCutoffMs).toISOString()
  const notInUseIso = new Date(w.notInUseCutoffMs).toISOString()
  const live = sql`ia.ts_actual_end IS NULL`
  const failing = openBearerFailureExists(sql`ia.instance_id`)
  const usedSince = (iso: string) => sql`EXISTS (
    SELECT 1 FROM attribution_record ar
     WHERE ar.instance_id = ia.instance_id
       AND ar.ts_event >= ${iso}::timestamptz)`
  const everUsed = sql`EXISTS (SELECT 1 FROM attribution_record ar WHERE ar.instance_id = ia.instance_id)`
  const healthy = sql`${live} AND NOT ${failing}`
  // Not used within 30 days, and either it was used before that or it was
  // connected before that. A device connected yesterday with no usage yet is idle.
  const notInUse = sql`(NOT ${usedSince(notInUseIso)} AND (${everUsed} OR ia.ts_start < ${notInUseIso}::timestamptz))`
  switch (state) {
    case 'revoked':
      return sql`(ia.ts_actual_end IS NOT NULL)`
    case 'cannot-send':
      return sql`(${live} AND ${failing})`
    case 'sending':
      return sql`(${healthy} AND ${usedSince(silentIso)})`
    case 'not-in-use':
      return sql`(${healthy} AND ${notInUse})`
    case 'idle':
      return sql`(${healthy} AND NOT ${usedSince(silentIso)} AND NOT ${notInUse})`
  }
}

/** The raw row fields both endpoints' metric/identity columns produce. */
export interface InstanceMetricRow {
  instance_id: string
  tool: string
  /** Owner-given device name (mig 0171), display only. */
  display_name: string | null
  raw_project_code: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  cannot_send: boolean
}

/** The projected per-instance shape (revoked/state derived, spend formatted). */
export interface ProjectedInstance {
  instance_id: string
  tool: string
  /** Owner-given device name (#576). Display only; NULL = no name set. */
  display_name: string | null
  project: string | null
  ts_start: string
  ts_actual_end: string | null
  last_emission: string | null
  spend_usd_mtd: string
  revoked: boolean
  state: InstanceState
}

/**
 * Project a raw instance row to the shared DTO: derive revoked/state and format
 * spend. The two cutoffs are epoch-ms from {@link instanceProjectionWindow}.
 */
export function projectInstanceRow(
  r: InstanceMetricRow,
  w: { silentCutoffMs: number; notInUseCutoffMs: number },
): ProjectedInstance {
  const revoked = r.ts_actual_end !== null
  return {
    instance_id: r.instance_id,
    tool: r.tool,
    display_name: r.display_name,
    project: r.raw_project_code,
    ts_start: r.ts_start,
    ts_actual_end: r.ts_actual_end,
    last_emission: r.last_emission,
    spend_usd_mtd: Number(r.spend_usd_mtd).toFixed(2),
    revoked,
    state: instanceState(r, w),
  }
}

function instanceState(
  r: Pick<InstanceMetricRow, 'ts_actual_end' | 'ts_start' | 'last_emission' | 'cannot_send'>,
  w: { silentCutoffMs: number; notInUseCutoffMs: number },
): InstanceState {
  if (r.ts_actual_end !== null) return 'revoked'
  if (r.cannot_send) return 'cannot-send'
  const lastMs = r.last_emission ? new Date(r.last_emission).getTime() : null
  if (lastMs !== null && lastMs >= w.silentCutoffMs) return 'sending'
  if (lastMs !== null) return lastMs >= w.notInUseCutoffMs ? 'idle' : 'not-in-use'
  return new Date(r.ts_start).getTime() < w.notInUseCutoffMs ? 'not-in-use' : 'idle'
}

/**
 * Compute the month start and both state cutoffs from one `now` (the request
 * clock), so the two endpoints stay in lockstep.
 */
export function instanceProjectionWindow(now: Date): {
  monthStartIso: string
  silentCutoffMs: number
  notInUseCutoffMs: number
} {
  const monthStartIso = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString()
  const silentCutoffMs = now.getTime() - SILENT_AFTER_HOURS * 60 * 60_000
  const notInUseCutoffMs = now.getTime() - NOT_IN_USE_AFTER_DAYS * 24 * 60 * 60_000
  return { monthStartIso, silentCutoffMs, notInUseCutoffMs }
}
