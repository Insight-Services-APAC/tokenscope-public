/*
 * report-scope — the per-request enforcement layer for the report-visibility policy
 * (task #19). Reads the admin-configured mode, computes the caller's grants
 * (shared/auth/report-visibility.ts), and gates the report scopes.
 *
 * The security boundary is NOT an import invariant — it is "every report-data
 * endpoint enforces reportGrants" (sg-M6/M8). This module is the shared primitive
 * those endpoints call:
 *   - getReportVisibilityMode — one indexed single-row SELECT, memoised on the
 *     event, degrading to 'standard' when the value is absent / non-enum / the table
 *     is missing (upgrade/rollback safety — sg-L11), never throwing.
 *   - resolveReportGrants     — mode + ACTIVE cost-centre ownership → grants. Used by
 *     the regional / cost-centre endpoints, which thread the grant into their
 *     EXISTING region clamps (the grant is a level, never a bypass).
 *   - requireReportScope      — the hard 403 gate for the all-regions-required scopes
 *     (across + /reports/finance). It AUDITS every deny (sg-M4): those scopes have no
 *     in-query backstop, so the audit IS the forensic record.
 */
import { createError, getRequestIP, getHeader, type H3Event } from 'h3'
import { sql } from 'drizzle-orm'
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { requireAuth, type Session } from '../utils/auth'
import { getDb } from '../db'
import { recordAuditEvent } from '../db/audit'
import {
  reportGrants,
  regionScopeGrant,
  isReportVisibilityMode,
  DEFAULT_REPORT_VISIBILITY_MODE,
  type ReportVisibilityMode,
  type ReportScopeGrants,
} from '../../shared/auth/report-visibility'

type Tx = PostgresJsDatabase<Record<string, unknown>>

/** The three report scopes a caller can be gated on (shared/reports/types.ts). */
export type ReportScopeName = 'region' | 'cost-centre' | 'finance'

/**
 * Which WIDTH of the Region scope is being requested. `all-regions` is the
 * unclamped, whole-company answer — the old `across` scope, now an option of the
 * region selector rather than a tab — and it is gated separately because it is the
 * only Region width with no in-query clamp behind it.
 */
export interface ReportScopeOpts {
  width?: 'all-regions' | 'region'
}

/**
 * True iff this request is asking for an answer that NO query predicate narrows —
 * the whole-company Region width, or the whole-company finance pack. These are the
 * denies that get audited: with no clamp underneath, the audit row is the only
 * record that the attempt happened (sg-M4).
 */
function isUnclampedRequest(scope: ReportScopeName, opts?: ReportScopeOpts): boolean {
  return scope === 'finance' || (scope === 'region' && opts?.width === 'all-regions')
}

const MODE_CTX_KEY = '__tokenscope_report_visibility_mode'

/**
 * The admin-configured mode, memoised on the event. Fail-closed to 'standard' on
 * EVERY unexpected shape — an absent row, a non-enum value, or a MISSING table
 * (migration not yet applied / rolled back). The table-existence guard uses
 * `to_regclass` so a missing relation returns NULL instead of aborting the whole
 * request transaction (sg-L11 — /reports must still 200 as standard).
 */
export async function getReportVisibilityMode(event: H3Event, tx: Tx): Promise<ReportVisibilityMode> {
  if (!event.context) event.context = {} as H3Event['context']
  const cached = event.context[MODE_CTX_KEY] as ReportVisibilityMode | undefined
  if (cached) return cached

  let mode: ReportVisibilityMode = DEFAULT_REPORT_VISIBILITY_MODE
  const [present] = [
    ...(await tx.execute<{ present: boolean }>(sql`
      SELECT to_regclass('report_visibility_setting') IS NOT NULL AS present`)),
  ]
  if (present?.present) {
    const [row] = [
      ...(await tx.execute<{ mode: string | null }>(sql`
        SELECT mode FROM report_visibility_setting WHERE key = 'policy' LIMIT 1`)),
    ]
    const raw = row?.mode
    if (raw && isReportVisibilityMode(raw)) mode = raw
    // else: absent row OR any non-enum value ⇒ 'standard' (never throw, never permissive).
  }

  event.context[MODE_CTX_KEY] = mode
  return mode
}

/**
 * True iff the caller holds an ACTIVE cost-centre ownership row (revoked_at IS NULL,
 * non-retired unit). Byte-identical to the meta.get.ts cou_owner check — a revoked /
 * expired row grants NOTHING (sg-L10).
 */
export async function computeOwnsCostCentre(tx: Tx, teammateId: string): Promise<boolean> {
  const [own] = [
    ...(await tx.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM cou_owner co
      JOIN org_unit ou ON ou.id = co.org_unit_id
      WHERE co.teammate_id = ${teammateId}::uuid
        AND co.revoked_at IS NULL AND ou.retired_at IS NULL`)),
  ]
  return Number(own?.n ?? 0) > 0
}

/** mode + ACTIVE ownership → the caller's per-scope grants. */
export async function resolveReportGrants(
  event: H3Event,
  tx: Tx,
  session: Session,
): Promise<ReportScopeGrants> {
  const mode = await getReportVisibilityMode(event, tx)
  const ownsCostCentre = await computeOwnsCostCentre(tx, session.teammateId)
  return reportGrants(mode, { role: session.role, ownsCostCentre })
}

function scopePermitted(
  scope: ReportScopeName,
  grants: ReportScopeGrants,
  opts?: ReportScopeOpts,
): boolean {
  switch (scope) {
    case 'finance':
      // The whole-company /reports/finance pack — a simple boolean grant.
      return grants.finance === true
    case 'region': {
      /*
       * The SAME function that builds the caller's region selector decides what the
       * endpoint will serve — that is the whole point of "the selector's options ARE
       * the grant". A width the caller cannot pick in the UI is a width the endpoint
       * 403s, and neither can drift from the other, because there is only one of them.
       */
      const rg = regionScopeGrant(grants)
      return opts?.width === 'all-regions' ? rg.allRegions : rg.tab
    }
    case 'cost-centre':
      return grants.costCentre !== false
  }
}

/**
 * The hard 403 gate for a report scope. Used by the `/reports/region*` endpoints
 * (which pass `width` so the whole-company answer is gated on `across` and a single
 * region on `regional`) and the /reports/finance index + drill + export. Returns the
 * resolved session + grants so the caller can proceed without recomputing.
 *
 * Denies on an UNCLAMPED request — the whole-company Region width, or `finance` —
 * are ALWAYS audited (`report-scope-denied`, sg-M4): those answers have no in-query
 * clamp behind them, so the audit is the only record. The write goes on a SEPARATE
 * connection (getDb) so the deny survives the 403's request-transaction rollback.
 * When impersonating (sandbox persona override), the impersonator fields ride along
 * for forensics (sg-H2).
 */
export async function requireReportScope(
  event: H3Event,
  tx: Tx,
  scope: ReportScopeName,
  opts?: ReportScopeOpts,
): Promise<{ session: Session; grants: ReportScopeGrants }> {
  const session = await requireAuth(event)
  const mode = await getReportVisibilityMode(event, tx)
  const ownsCostCentre = await computeOwnsCostCentre(tx, session.teammateId)
  const grants = reportGrants(mode, { role: session.role, ownsCostCentre })

  if (!scopePermitted(scope, grants, opts)) {
    if (isUnclampedRequest(scope, opts)) {
      try {
        await recordAuditEvent(getDb() as unknown as Tx, {
          eventType: 'report-scope-denied',
          actorTeammateId: session.teammateId,
          subjectKind: 'report-scope',
          subjectId: null,
          payload: {
            scope,
            // The WIDTH the deny was for. `scope` alone stopped being enough when
            // across/regional merged: both widths of `region` now arrive under one
            // scope name, and only the unclamped one is the escalation attempt.
            ...(opts?.width ? { width: opts.width } : {}),
            mode,
            role: session.role,
            ownsCostCentre,
            grants,
            ...(session.impersonatorOid ? { impersonatorOid: session.impersonatorOid } : {}),
            ...(session.impersonatorEmail ? { impersonatorEmail: session.impersonatorEmail } : {}),
          },
          ipAddress: getRequestIP(event, { xForwardedFor: true }) ?? null,
          userAgent: getHeader(event, 'user-agent') ?? null,
        })
      } catch (err) {
        // Best-effort forensics: an audit failure must never mask the 403 (the
        // deny still returns below). But for across/finance the audit IS the only
        // record of a denied privilege-escalation attempt — so a write failure is
        // itself a security-critical event ops must be able to alert on. Emit a
        // DISTINCTIVE, stable marker with ids-only structured fields (no PII).
        consola.error('[SECURITY-AUDIT-WRITE-FAILED] report-scope deny-audit write failed', {
          scope,
          // The width rides the marker too: `scope: 'region'` alone no longer says
          // whether the denied answer was the unclamped one.
          ...(opts?.width ? { width: opts.width } : {}),
          actorTeammateId: session.teammateId,
          ...(session.impersonatorOid ? { impersonatorOid: session.impersonatorOid } : {}),
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      data: {
        type: 'https://tokenscope.example.com/errors/forbidden',
        title: 'Forbidden',
        status: 403,
        detail:
          scope === 'region' && opts?.width === 'all-regions'
            ? "Your role does not grant the whole-company ('All regions') width of the 'region' report scope under the current report-visibility policy."
            : `Your role does not grant the '${scope}' report scope under the current report-visibility policy.`,
      },
    })
  }

  return { session, grants }
}
