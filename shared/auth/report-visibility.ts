/*
 * report-visibility — the ONE source of truth for the admin-configurable
 * reporting-visibility policy (task #19).
 *
 * Owner intent: keep the comprehensive RBAC; add ONE easy-to-understand knob that
 * an admin sets to loosen who sees which `/reports` SCOPES. Three named modes,
 * default = today's behaviour. READ-ONLY blast radius by construction — this module
 * is consumed only by the reporting read path (server/auth/report-scope.ts and the
 * endpoints under server/api/v1/reports/** + the finance rollups) and by the admin
 * pane preview. It never touches write endpoints, provisioning, or the GUC/RLS layer.
 *
 * `reportGrants(mode, caller)` maps (policy mode × caller) → a per-scope grant object.
 * The regional / cost-centre grants are AUTHORIZATION LEVELS, never region-clamp
 * bypasses: `'own-region'` still routes through the existing region clamp
 * (resolveRegionalScope); only `'all-regions'` widens. `finance` is a simple BOOLEAN —
 * the whole-company `/reports/finance` pack is the only consumer, and it is
 * region-unbounded by design (global finance is a global function), so there is no
 * region-clamp level to express. The static {@link WHO_SEES_WHAT} matrix is the same
 * object the admin pane renders and the unit tests pin `reportGrants` against — so
 * preview and enforcement can never drift.
 */
import { consola } from 'consola'
import type { Role } from './roles'

/** The three named policy modes. Order = display order. */
export const REPORT_VISIBILITY_MODES = [
  'standard',
  'region-admins-see-all',
  'all-admins-see-all',
] as const
export type ReportVisibilityMode = (typeof REPORT_VISIBILITY_MODES)[number]

/** Fail-closed default: any unknown/absent DB value collapses to this (sg-M5/L11). */
export const DEFAULT_REPORT_VISIBILITY_MODE: ReportVisibilityMode = 'standard'

export function isReportVisibilityMode(v: string): v is ReportVisibilityMode {
  return (REPORT_VISIBILITY_MODES as readonly string[]).includes(v)
}

export const REPORT_VISIBILITY_LABELS: Record<ReportVisibilityMode, string> = {
  standard: 'Standard (role-based)',
  'region-admins-see-all': 'Region admins see all',
  'all-admins-see-all': 'All admins see all',
}

export const REPORT_VISIBILITY_DESCRIPTIONS: Record<ReportVisibilityMode, string> = {
  standard:
    'Everyone sees only the reporting scopes their role grants today. Region admins stay bound to their own region; the whole-company and finance packs stay finance-only.',
  'region-admins-see-all':
    'Region admins additionally see every region — the across-regions rollup, the finance pack, all-region regional views, and every cost centre. Managers and developers are unchanged.',
  'all-admins-see-all':
    'As “Region admins see all”, plus any active cost-centre owner gets the same full report set. Managers and developers without ownership are unchanged.',
}

/**
 * Per-scope grant for a caller under a policy mode. Each field is an authorization
 * LEVEL the enforcement layer reads — never a truthy bypass of the region clamp:
 *   - `across`     — may read the whole-company `/reports/across-regions` rollup.
 *   - `regional`   — `'own-region'` (region-clamped, the existing resolver path) |
 *                    `'all-regions'` (cross-region: region selector + honored `?region`) |
 *                    `false` (no regional scope).
 *   - `costCentre` — `'owned-or-subtree'` (the existing owner/subtree predicate) |
 *                    `'all'` (unbounded — every cost centre) | `false` (none).
 *   - `finance`    — `true` (sees the whole-company `/reports/finance` pack) | `false`.
 */
export interface ReportScopeGrants {
  across: boolean
  regional: 'own-region' | 'all-regions' | false
  costCentre: 'owned-or-subtree' | 'all' | false
  finance: boolean
}

/** The full report set a loosened mode grants an elevated caller. */
const FULL_GRANTS: ReportScopeGrants = {
  across: true,
  regional: 'all-regions',
  costCentre: 'all',
  finance: true,
}

/**
 * Today's role-based grants — BYTE-IDENTICAL to meta.get.ts's map for every real
 * persona. The `finance` boolean is the whole-company `/reports/finance` gate:
 * cross-region roles (global-finops / platform-admin) ⇒ `true`, everyone else
 * (incl. a region admin) ⇒ `false`. A region admin reaches finance ONLY via a
 * loosened policy mode (FULL_GRANTS) — the old `'own-region'` finance level lived
 * solely on the retired `/rollups/finance*` surface. Exhaustive over all six role
 * literals incl. the zombie `'finance'` enum member, which gets developer-tier
 * grants (benign; no across/finance — sg-M7).
 */
function standardGrants(role: Role, ownsCostCentre: boolean): ReportScopeGrants {
  const devTier: ReportScopeGrants = {
    across: false,
    regional: 'own-region',
    costCentre: ownsCostCentre ? 'owned-or-subtree' : false,
    finance: false,
  }
  switch (role) {
    case 'developer':
    case 'finance': // zombie enum member — never minted; developer-tier keeps it benign.
      return devTier
    case 'manager':
      return { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false }
    case 'admin':
      return { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false }
    case 'global-finops':
    case 'platform-admin':
      return { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true }
    default: {
      // Unreachable for a valid Role; fail-closed to developer-tier rather than throw.
      consola.error(
        `reportGrants: unrecognised role '${role as string}' — defaulting to developer-tier grants`,
      )
      return devTier
    }
  }
}

/**
 * The one enforcement primitive: (mode × caller) → per-scope grants. Exhaustive over
 * the mode literal; the `default` branch fails CLOSED to standard grants + logs
 * (sg-M5), so an unknown DB mode is never permissive and never throws.
 */
export function reportGrants(
  mode: ReportVisibilityMode,
  caller: { role: Role; ownsCostCentre: boolean },
): ReportScopeGrants {
  const { role, ownsCostCentre } = caller
  switch (mode) {
    case 'standard':
      return standardGrants(role, ownsCostCentre)
    case 'region-admins-see-all':
      // A region `admin` additionally gets the full report set; everyone else standard.
      return role === 'admin' ? { ...FULL_GRANTS } : standardGrants(role, ownsCostCentre)
    case 'all-admins-see-all':
      // Region admins AND any active cost-centre owner (any role) get the full set.
      return role === 'admin' || ownsCostCentre ? { ...FULL_GRANTS } : standardGrants(role, ownsCostCentre)
    default: {
      consola.error(
        `reportGrants: unrecognised mode '${mode as string}' — defaulting to standard grants`,
      )
      return standardGrants(role, ownsCostCentre)
    }
  }
}

/**
 * The six personas the WHO-SEES-WHAT matrix (and the RBAC-matrix tests) enumerate.
 * `cost-centre-owner` is a plain developer WITH an active cou_owner row — ownership is
 * a relationship, not a role (mig 0048).
 */
export const REPORT_VISIBILITY_PERSONAS = [
  { key: 'developer', label: 'Developer', role: 'developer', ownsCostCentre: false },
  { key: 'manager', label: 'Manager', role: 'manager', ownsCostCentre: false },
  { key: 'admin', label: 'Region admin', role: 'admin', ownsCostCentre: false },
  { key: 'cost-centre-owner', label: 'Cost-centre owner', role: 'developer', ownsCostCentre: true },
  { key: 'global-finops', label: 'Global finance', role: 'global-finops', ownsCostCentre: false },
  { key: 'platform-admin', label: 'Platform admin', role: 'platform-admin', ownsCostCentre: false },
] as const satisfies readonly { key: string; label: string; role: Role; ownsCostCentre: boolean }[]

export type ReportVisibilityPersonaKey = (typeof REPORT_VISIBILITY_PERSONAS)[number]['key']

/**
 * The static (mode × persona → grants) matrix — the SAME object the admin pane
 * renders as its who-sees-what preview and the unit tests assert `reportGrants`
 * against. A hand-written literal (independent of `reportGrants`) so the assertion is
 * a real pin, not a tautology: change the semantics without updating this table and
 * the matrix test fails.
 */
export const WHO_SEES_WHAT: Record<
  ReportVisibilityMode,
  Record<ReportVisibilityPersonaKey, ReportScopeGrants>
> = {
  standard: {
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    admin: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    'cost-centre-owner': { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
  },
  'region-admins-see-all': {
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    admin: { across: true, regional: 'all-regions', costCentre: 'all', finance: true },
    'cost-centre-owner': { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
  },
  'all-admins-see-all': {
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false },
    admin: { across: true, regional: 'all-regions', costCentre: 'all', finance: true },
    'cost-centre-owner': { across: true, regional: 'all-regions', costCentre: 'all', finance: true },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true },
  },
}
