/*
 * copilot-rate-plan — effective-dated Copilot seat price / included allowance
 * (ADR-0011 D9, design §5.3). FORECAST/SHOWBACK input ONLY:
 *
 *   - `resolveCopilotRatePlan` is the ONE place that answers "what were the
 *     seat price and included allowance for THIS enterprise, for THIS period"
 *     — every forecast/showback consumer (the copilot-bill flat-seat showback
 *     writer today; any future forecast surface) calls this instead of
 *     reading `provider_enterprise.flat_seat_price_usd` /
 *     `included_allowance_usd` directly, so a later plan change can never
 *     silently re-cost an already-written historical month.
 *   - It NEVER feeds `copilot_pool_bill.license_net_usd` / `overage_net_usd`
 *     — those are read straight off the enterprise billing usage report
 *     (server/workers/copilot-pool-bill.ts) and stay bill-anchored regardless
 *     of what any rate plan says.
 *
 * BACKWARD COMPATIBILITY (deprecating the scalar fields safely): the scalar
 * `provider_enterprise.flat_seat_price_usd` / `included_allowance_usd`
 * columns remain fully readable/writable via the existing enterprise
 * GET/POST/PATCH routes — no existing API client breaks. `resolveCopilotRatePlan`
 * prefers a `copilot_rate_plan` row covering the queried period; when NONE
 * exists (a brand-new enterprise before any dated plan is created, or a
 * genuine gap) it falls back to the CURRENT scalar values, reproducing
 * today's exact (period-blind) behaviour. Migration 0106 backfills an
 * open-ended plan for every pre-existing enterprise, so the fallback is a
 * defensive safety net, not the common path, from day one.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type * as schema from '../../drizzle/schema'
import { recordAuditEvent } from '../db/audit'
import { translatePgConstraintError } from '../utils/pg-constraint-error'

type Db = PostgresJsDatabase<typeof schema>
type SqlRunner = Pick<Db, 'execute'>
type Tx = PostgresJsDatabase<Record<string, unknown>>

export interface ResolvedCopilotRatePlan {
  flatSeatPriceUsd: number | null
  includedAllowanceUsd: number | null
  /** 'rate-plan' = an effective-dated row covered the period; 'scalar-fallback'
   *  = no row covered it, so the CURRENT provider_enterprise scalar columns
   *  were used (the pre-Workstream-C, period-blind behaviour). */
  source: 'rate-plan' | 'scalar-fallback'
  /** The resolved copilot_rate_plan row id, or null on a scalar-fallback. */
  ratePlanId: string | null
}

/** Accept 'YYYY-MM' or 'YYYY-MM-01' and return a UTC midnight-of-1st timestamp
 *  string — the point-in-time key a rate plan's `effective` range is tested
 *  against (mirrors resolveRateCard's `effective @> eventTs` pattern). */
function periodMonthTimestamp(periodMonth: string): string {
  const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(periodMonth)
  if (!m) throw new Error(`copilot-rate-plan: periodMonth must be YYYY-MM or YYYY-MM-01, got '${periodMonth}'`)
  return `${m[1]}-${m[2]}-01T00:00:00.000Z`
}

/**
 * Resolve the Copilot rate plan in force for `periodMonth` (the period BEING
 * COMPUTED — a showback write for June always resolves June's plan, no matter
 * when it runs or what plan is live "now"). Never throws on absence — the
 * scalar-fallback path always returns SOMETHING (possibly null/null, matching
 * today's behaviour for an enterprise with no Copilot billing configured).
 */
export async function resolveCopilotRatePlan(
  db: SqlRunner,
  args: { providerEnterpriseId: string; periodMonth: string },
): Promise<ResolvedCopilotRatePlan> {
  const ts = periodMonthTimestamp(args.periodMonth)
  const rows = await db.execute<{
    id: string
    flat_seat_price_usd: string | null
    included_allowance_usd: string | null
  }>(sql`
    SELECT id::text AS id, flat_seat_price_usd::text AS flat_seat_price_usd,
           included_allowance_usd::text AS included_allowance_usd
    FROM copilot_rate_plan
    WHERE provider_enterprise_id = ${args.providerEnterpriseId}::uuid
      AND retired_at IS NULL
      AND effective @> ${ts}::timestamptz
    ORDER BY created_at DESC
    LIMIT 1
  `)
  const plan = rows[0]
  if (plan) {
    return {
      flatSeatPriceUsd: plan.flat_seat_price_usd != null ? Number(plan.flat_seat_price_usd) : null,
      includedAllowanceUsd: plan.included_allowance_usd != null ? Number(plan.included_allowance_usd) : null,
      source: 'rate-plan',
      ratePlanId: plan.id,
    }
  }

  const fallback = await db.execute<{
    flat_seat_price_usd: string | null
    included_allowance_usd: string | null
  }>(sql`
    SELECT flat_seat_price_usd::text AS flat_seat_price_usd, included_allowance_usd::text AS included_allowance_usd
    FROM provider_enterprise WHERE id = ${args.providerEnterpriseId}::uuid
  `)
  const f = fallback[0]
  return {
    flatSeatPriceUsd: f?.flat_seat_price_usd != null ? Number(f.flat_seat_price_usd) : null,
    includedAllowanceUsd: f?.included_allowance_usd != null ? Number(f.included_allowance_usd) : null,
    source: 'scalar-fallback',
    ratePlanId: null,
  }
}

export interface CopilotRatePlanRow {
  id: string
  providerEnterpriseId: string
  validFrom: string
  validTo: string | null
  flatSeatPriceUsd: number | null
  includedAllowanceUsd: number | null
  notes: string | null
  createdBy: string | null
  createdAt: string
  retiredAt: string | null
}

interface RawPlanRow extends Record<string, unknown> {
  id: string
  provider_enterprise_id: string
  valid_from: string
  valid_to: string | null
  flat_seat_price_usd: string | null
  included_allowance_usd: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  retired_at: string | null
}

function toRow(r: RawPlanRow): CopilotRatePlanRow {
  return {
    id: r.id,
    providerEnterpriseId: r.provider_enterprise_id,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    flatSeatPriceUsd: r.flat_seat_price_usd != null ? Number(r.flat_seat_price_usd) : null,
    includedAllowanceUsd: r.included_allowance_usd != null ? Number(r.included_allowance_usd) : null,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
  }
}

/** Full effective-dated history for one enterprise, newest-starting first. Includes
 *  retired rows (labelled via `retiredAt`) so the admin history view is a complete audit
 *  trail, not just the live set. */
export async function listCopilotRatePlans(db: SqlRunner, providerEnterpriseId: string): Promise<CopilotRatePlanRow[]> {
  const rows = await db.execute<RawPlanRow>(sql`
    SELECT id::text AS id, provider_enterprise_id::text AS provider_enterprise_id,
           lower(effective)::text AS valid_from, upper(effective)::text AS valid_to,
           flat_seat_price_usd::text AS flat_seat_price_usd, included_allowance_usd::text AS included_allowance_usd,
           notes, created_by::text AS created_by, created_at::text AS created_at, retired_at::text AS retired_at
    FROM copilot_rate_plan
    WHERE provider_enterprise_id = ${providerEnterpriseId}::uuid
    ORDER BY lower(effective) DESC NULLS FIRST, created_at DESC
  `)
  return rows.map(toRow)
}

export class CopilotRatePlanError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid-range',
  ) {
    super(message)
    this.name = 'CopilotRatePlanError'
  }
}

export interface CreateCopilotRatePlanArgs {
  providerEnterpriseId: string
  /** ISO date/timestamp — the plan takes effect from this instant, inclusive. */
  validFrom: string
  /** ISO date/timestamp, exclusive — null = open-ended (in force until superseded). */
  validTo?: string | null
  flatSeatPriceUsd?: number | null
  includedAllowanceUsd?: number | null
  notes?: string | null
  actorTeammateId: string
  ipAddress?: string | null
  userAgent?: string | null
}

export interface CreateCopilotRatePlanResult {
  plan: CopilotRatePlanRow
  /** id of a previously open-ended plan this create auto-truncated to end
   *  exactly at `validFrom`, or null when there was nothing to truncate. */
  truncatedPreviousPlanId: string | null
}

/**
 * Create a new effective-dated rate plan, auditable. If an existing LIVE
 * (non-retired) plan for this enterprise is open-ended (`valid_to IS NULL`)
 * and starts strictly before `validFrom`, it is auto-truncated to end at
 * `validFrom` — the ordinary "the next plan supersedes the current one"
 * workflow, done in the SAME audited write so history stays contiguous
 * without a separate manual step. Any OTHER overlap (e.g. inserting a plan
 * into the middle of history) is rejected by the EXCLUDE constraint and
 * surfaced as a clean 409 — never silently adjusted.
 */
export async function createCopilotRatePlan(
  tx: Tx,
  args: CreateCopilotRatePlanArgs,
): Promise<CreateCopilotRatePlanResult> {
  if (args.validTo != null && new Date(args.validTo).getTime() <= new Date(args.validFrom).getTime()) {
    throw new CopilotRatePlanError('validTo must be after validFrom', 'invalid-range')
  }

  const openEnded = await tx.execute<{ id: string; valid_from: string }>(sql`
    SELECT id::text AS id, lower(effective)::text AS valid_from
    FROM copilot_rate_plan
    WHERE provider_enterprise_id = ${args.providerEnterpriseId}::uuid
      AND retired_at IS NULL
      AND upper(effective) IS NULL
      AND lower(effective) < ${args.validFrom}::timestamptz
    LIMIT 1
  `)
  let truncatedPreviousPlanId: string | null = null
  if (openEnded[0]) {
    await tx.execute(sql`
      UPDATE copilot_rate_plan
      SET effective = tstzrange(lower(effective), ${args.validFrom}::timestamptz)
      WHERE id = ${openEnded[0].id}::uuid
    `)
    truncatedPreviousPlanId = openEnded[0].id
  }

  let created: RawPlanRow | undefined
  try {
    const rows = await tx.execute<RawPlanRow>(sql`
      INSERT INTO copilot_rate_plan
        (provider_enterprise_id, effective, flat_seat_price_usd, included_allowance_usd, notes, created_by)
      VALUES (
        ${args.providerEnterpriseId}::uuid,
        tstzrange(${args.validFrom}::timestamptz, ${args.validTo ?? null}::timestamptz),
        ${args.flatSeatPriceUsd != null ? args.flatSeatPriceUsd.toFixed(6) : null}::numeric,
        ${args.includedAllowanceUsd != null ? args.includedAllowanceUsd.toFixed(6) : null}::numeric,
        ${args.notes ?? null}, ${args.actorTeammateId}::uuid
      )
      RETURNING id::text AS id, provider_enterprise_id::text AS provider_enterprise_id,
                lower(effective)::text AS valid_from, upper(effective)::text AS valid_to,
                flat_seat_price_usd::text AS flat_seat_price_usd, included_allowance_usd::text AS included_allowance_usd,
                notes, created_by::text AS created_by, created_at::text AS created_at, retired_at::text AS retired_at
    `)
    created = rows[0]
  } catch (err: unknown) {
    translatePgConstraintError(err, {
      '23P01': {
        title: 'Copilot rate plan overlaps an existing plan',
        detail: 'The requested effective range overlaps another live rate plan for this enterprise. Retire or adjust the conflicting plan first.',
      },
    })
  }
  if (!created) throw new Error('createCopilotRatePlan: insert returned no row')

  await recordAuditEvent(tx, {
    eventType: 'copilot-rate-plan-created',
    actorTeammateId: args.actorTeammateId,
    subjectKind: 'provider-enterprise',
    subjectId: args.providerEnterpriseId,
    payload: {
      rate_plan_id: created.id,
      valid_from: args.validFrom,
      valid_to: args.validTo ?? null,
      flat_seat_price_usd: args.flatSeatPriceUsd ?? null,
      included_allowance_usd: args.includedAllowanceUsd ?? null,
      notes: args.notes ?? null,
      truncated_previous_plan_id: truncatedPreviousPlanId,
    },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })

  return { plan: toRow(created), truncatedPreviousPlanId }
}

/** Convenience helper: also exported so a `provider_enterprise` create route
 *  can seed the enterprise's FIRST rate plan in the same audited write (an
 *  open-ended plan from the values supplied at creation time), keeping every
 *  enterprise covered from day one exactly like migration 0106's backfill.
 *  Never called on an UPDATE path — see copilot-rate-plan.ts header re:
 *  deliberately NOT keeping the scalar columns and the rate-plan table in
 *  sync on every PATCH (that would need a silent, unaudited write on every
 *  legacy-field edit; instead the legacy PATCH stays scalar-only and the
 *  rate-plan table is managed explicitly going forward). */
export async function seedInitialCopilotRatePlan(
  tx: Tx,
  args: {
    providerEnterpriseId: string
    flatSeatPriceUsd: number | null
    includedAllowanceUsd: number | null
    actorTeammateId: string
    ipAddress?: string | null
    userAgent?: string | null
  },
): Promise<CopilotRatePlanRow | null> {
  if (args.flatSeatPriceUsd == null && args.includedAllowanceUsd == null) return null
  const result = await createCopilotRatePlan(tx, {
    providerEnterpriseId: args.providerEnterpriseId,
    validFrom: '1970-01-01T00:00:00.000Z',
    validTo: null,
    flatSeatPriceUsd: args.flatSeatPriceUsd,
    includedAllowanceUsd: args.includedAllowanceUsd,
    notes: 'Seeded from the enterprise creation form.',
    actorTeammateId: args.actorTeammateId,
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  })
  return result.plan
}
