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
 *   - `teammate`   — `'people-scope'` (may open a NAMED individual's reports-depth
 *                    drill, `/reporting/teammate/{id}`) | `false`. See
 *                    {@link peopleScopeGrant}.
 *   - `project`    — the WIDEST project admission the caller holds:
 *                    `'region-wide'` | `'member-in-scope'` | `'membership'` |
 *                    `false`. See {@link projectDepthGrant}.
 */
export interface ReportScopeGrants {
  across: boolean
  regional: 'own-region' | 'all-regions' | false
  costCentre: 'owned-or-subtree' | 'all' | false
  finance: boolean
  /**
   * May this caller open the reports-depth view of a NAMED individual
   * (`/reporting/teammate/{id}`, `GET /api/v1/reports/teammate/{id}` — developer
   * pages build D31/D38)?
   *
   * `'people-scope'` is a GRANT LEVEL, never an admission: holding it is the
   * FIRST conjunct of {@link teammateDrillAdmission}, which still requires the
   * emit-time homing evidence and `is_active` (D34). It is deliberately NOT a
   * region-wide level: the grant model cannot express
   * region-leader-sees-whole-region today (annex E1 :850-867 — recorded open
   * owner decision 2), so this column documents CC-subtree/self, widening only
   * for roles whose REGIONAL grant already says all-regions.
   */
  teammate: 'people-scope' | false
  /**
   * How this caller reaches a PROJECT page, at its widest:
   *   - `'membership'`      — only by being a member (the `me/*` path everyone
   *                           has). No reports depth.
   *   - `'member-in-scope'` — plus every project with ≥1 member inside their
   *                           cost-centre people-scope (annex :563-574).
   *   - `'region-wide'`     — plus every project their regional width covers.
   *   - `false`             — nothing at all. NOT produced by today's matrix;
   *                           carried for TOTALITY, the same discipline
   *                           {@link regionScopeGrant} follows, so a future mode
   *                           that denies project depth outright has a value to
   *                           say so with instead of overloading `'membership'`.
   *
   * Like `teammate`, a LEVEL and not an admission: the reports-side project
   * endpoint still resolves the caller's own scope per request.
   */
  project: 'membership' | 'member-in-scope' | 'region-wide' | false
}

/**
 * Does this caller hold a PEOPLE scope — the grant that makes a named
 * individual's drill reachable at all (D38)?
 *
 * A cost-centre grant carries one by construction: the CC subtree IS a roster,
 * and every cost-centre surface already names the people in it (the over-cap
 * card, the people hero). A cross-region grant carries the wider one.
 *
 * A plain `regional: 'own-region'` does NOT. That width resolves through
 * `resolveRegionalScope`, which clamps a developer to their OWN org subtree —
 * a reporting width, not a governance grant over named individuals. Deriving
 * `teammate` from it would hand every developer the audited, refusal-gated
 * per-person view, which is the opposite of "manager-facing depth is
 * contribution against budgets only".
 */
function peopleScopeGrant(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre'>,
): 'people-scope' | false {
  if (g.costCentre !== false) return 'people-scope'
  if (g.regional === 'all-regions' || g.across) return 'people-scope'
  return false
}

/**
 * The WIDEST project admission a caller holds (D37/D38). Membership is the floor
 * because it is not a grant at all — `me/projects/{code}` gates on current
 * `project_assignment` and knows nothing about `reportGrants`, which is exactly
 * why D37 refuses to add a third admission arm there.
 */
function projectDepthGrant(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre'>,
): 'membership' | 'member-in-scope' | 'region-wide' {
  if (g.regional === 'all-regions' || g.across) return 'region-wide'
  if (g.costCentre !== false) return 'member-in-scope'
  return 'membership'
}

/**
 * Derive the two W4 columns from the four scope grants, in ONE place, so
 * {@link standardGrants} and {@link FULL_GRANTS} cannot state them differently.
 * {@link WHO_SEES_WHAT} stays a hand-written literal (see its own comment) — the
 * point of that table is to be an INDEPENDENT statement, so it is not derived
 * from this.
 */
function withDrillGrants(
  g: Pick<ReportScopeGrants, 'across' | 'regional' | 'costCentre' | 'finance'>,
): ReportScopeGrants {
  return { ...g, teammate: peopleScopeGrant(g), project: projectDepthGrant(g) }
}

/** The full report set a loosened mode grants an elevated caller. */
const FULL_GRANTS: ReportScopeGrants = withDrillGrants({
  across: true,
  regional: 'all-regions',
  costCentre: 'all',
  finance: true,
})

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
  const devTier: ReportScopeGrants = withDrillGrants({
    across: false,
    regional: 'own-region',
    costCentre: ownsCostCentre ? 'owned-or-subtree' : false,
    finance: false,
  })
  switch (role) {
    case 'developer':
    case 'finance': // zombie enum member — never minted; developer-tier keeps it benign.
      return devTier
    case 'manager':
      return withDrillGrants({ across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false })
    case 'admin':
      return withDrillGrants({ across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false })
    case 'global-finops':
    case 'platform-admin':
      return withDrillGrants({ across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true })
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

/*
 * ── The Region scope: what the selector offers ───────────────────────────────
 *
 * `across` and `regional` are still the two grants a caller HOLDS — this adds no
 * authorization concept. What changed is the surface: Across-Regions stopped
 * being a tab of its own and became the FIRST OPTION of the Region tab's region
 * selector ("All regions"). So the question every consumer now asks is not "which
 * of two tabs?" but "which options does this caller's selector carry, and which
 * one does a bare `?scope=region` land on?".
 *
 * `regionScopeGrant` is the one answer. The tab, the landing region, the option
 * list and the endpoint's own 403 all read it, so the selector a caller SEES and
 * the widths the endpoint SERVES cannot drift: the options ARE the grant.
 *
 * TOTALITY IS THE POINT. It is a pure function over the 2 × 3 = 6 (across ×
 * regional) states, and every one of them names exactly one landing — including
 * the three that today's role matrix never produces. The failure this replaces is
 * a caller holding `across: false` with nowhere to go once the Across tab is
 * gone; a mapping with a hole is how that comes back.
 */
export interface RegionScopeGrant {
  /** Is the Region tab present at all? `false` ⇒ the caller lands on another scope. */
  tab: boolean
  /** May the caller pick "All regions" — the unclamped, whole-company answer? */
  allRegions: boolean
  /** May the caller pick a region OTHER than their own (the honoured `?region=`)? */
  crossRegion: boolean
  /** May the caller read a single region at all (their own, at minimum)? */
  ownRegion: boolean
  /** Where a bare `?scope=region` lands. Exactly one value whenever `tab` is true. */
  landing: 'all-regions' | 'own-region' | null
}

/**
 * (grants a caller holds) → (what their Region selector offers, and where they land).
 *
 * Each option is backed by a grant the caller actually holds, and nothing else:
 * "All regions" IS `across`, "any region" IS `regional === 'all-regions'`, "own
 * region" IS `regional !== false`. A caller with `regional: false` is therefore
 * offered no single region even when `across` lets them read the whole company —
 * inventing a per-region option out of a whole-company grant would be a grant this
 * module made up rather than one the policy issued.
 *
 * Landing prefers the widest option the caller holds, which is what "Region
 * absorbs Across" means for the person who used to open on Across-Regions: they
 * still open on the whole-company answer, now as the selector's first option.
 */
export function regionScopeGrant(g: ReportScopeGrants): RegionScopeGrant {
  const allRegions = g.across === true
  const crossRegion = g.regional === 'all-regions'
  const ownRegion = g.regional !== false
  const tab = allRegions || ownRegion
  return {
    tab,
    allRegions,
    crossRegion,
    ownRegion,
    landing: !tab ? null : allRegions ? 'all-regions' : 'own-region',
  }
}

/**
 * Render the per-scope grant object (the ENFORCEMENT type) as the human scope
 * list a surface shows. Lifted out of server/api/v1/admin/report-visibility.get.ts
 * so the policy pane and the diagnostics probe name the scopes with the SAME
 * words — a second copy of this wording is a second vocabulary, and the whole
 * point of showing resolved grants is that they are the ones in force.
 *
 * ONE Region line, not two. Across-Regions is no longer a scope a caller is
 * granted separately; it is the "All regions" option of the Region selector, so
 * the pane names the selector the caller would actually see rather than listing a
 * tab that no longer exists.
 */
export function grantsToScopes(g: ReportScopeGrants): string[] {
  const out: string[] = []
  const rg = regionScopeGrant(g)
  if (rg.allRegions && rg.crossRegion) out.push('Region (all regions + every region)')
  else if (rg.allRegions) out.push('Region (all regions)')
  else if (rg.crossRegion) out.push('Region (every region)')
  else if (rg.ownRegion) out.push('Region (own region)')
  if (g.costCentre === 'all') out.push('Cost centres (all)')
  else if (g.costCentre === 'owned-or-subtree') out.push('Cost centres (owned)')
  if (g.finance) out.push('Finance (whole company)')
  /*
   * The two DRILL columns (D38). They render from this ONE function so the admin
   * preview and the diagnostics probe name them in the same words as every other
   * scope — the annex's explicit instruction was that the named-row/drill rules
   * must leave code comments and enter the design record AND the matrix, not stay
   * a second RBAC path visible only to whoever reads the handler (:557-561).
   *
   * Read defensively: a caller passing a pre-W4 grant literal (older tests, a
   * cached payload) simply gets no line, never a wrong one.
   */
  if (g.teammate === 'people-scope') out.push('Teammate drill (people in your scope)')
  if (g.project === 'region-wide') out.push('Projects (region-wide)')
  else if (g.project === 'member-in-scope') out.push('Projects (members in your scope)')
  else if (g.project === 'membership') out.push('Projects (own memberships only)')
  return out
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
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false, teammate: false, project: 'membership' },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    admin: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    'cost-centre-owner': { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
  },
  'region-admins-see-all': {
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false, teammate: false, project: 'membership' },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    admin: { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'cost-centre-owner': { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
  },
  'all-admins-see-all': {
    developer: { across: false, regional: 'own-region', costCentre: false, finance: false, teammate: false, project: 'membership' },
    manager: { across: false, regional: 'own-region', costCentre: 'owned-or-subtree', finance: false, teammate: 'people-scope', project: 'member-in-scope' },
    admin: { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'cost-centre-owner': { across: true, regional: 'all-regions', costCentre: 'all', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'global-finops': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
    'platform-admin': { across: true, regional: 'all-regions', costCentre: 'owned-or-subtree', finance: true, teammate: 'people-scope', project: 'region-wide' },
  },
}

/*
 * The §7 persona matrix's Region rows — one row per (mode × persona), replacing
 * the separate `across` and `regional` rows, and carrying the selector-visibility
 * column §6's grant table calls for.
 *
 * HAND-WRITTEN, exactly like {@link WHO_SEES_WHAT} and for the same reason: the
 * test asserts `regionScopeGrant(reportGrants(mode, persona))` equals this table,
 * so the table has to be an independent statement of the intent. Deriving it would
 * make the assertion `f(x) === f(x)` — a tautology that passes through any change
 * to `f`, including one that strands a persona with no landing at all.
 *
 * Read the `landing` column as the acceptance criterion it encodes: EVERY cell
 * names exactly one landing, and none names null. A persona whose Region tab
 * disappeared would show `tab: false, landing: null` here, visible in the diff.
 */
export const WHO_SEES_WHAT_REGION: Record<
  ReportVisibilityMode,
  Record<ReportVisibilityPersonaKey, RegionScopeGrant>
> = {
  standard: {
    developer: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    manager: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    admin: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    'cost-centre-owner': { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    'global-finops': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'platform-admin': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  },
  'region-admins-see-all': {
    developer: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    manager: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    admin: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'cost-centre-owner': { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    'global-finops': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'platform-admin': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  },
  'all-admins-see-all': {
    developer: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    manager: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
    admin: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'cost-centre-owner': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'global-finops': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
    'platform-admin': { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  },
}

/*
 * ── THE DRILL CONTRACT'S TWO RULES (developer pages build D38) ───────────────
 *
 * NAMING A ROW AND OPENING A DRILL ARE DIFFERENT QUESTIONS. Conflating them was
 * a round-1 HIGH on the build design (r1-H4) because the conflation is a
 * membership bypass in one direction and a dead link in the other: a project
 * MEMBER may see their team-mates NAMED on the project page and hold no reports
 * grant at all, so "named ⇒ drillable" would hand a per-person governance view
 * to anyone who joins a project. The prototype pins that persona at 403
 * (`prototype.html:780-785`).
 *
 * So there are two exported rules and they are never one:
 *   1. {@link namedContributionRow} — may this subject be NAMED in a row, or
 *      must they fold into the aggregate remainder (annex :521-526, C3)?
 *   2. {@link teammateDrillAdmission} — may this viewer OPEN this subject's
 *      reports-depth page (D34's emit-time conjunction, ALWAYS)?
 *
 * A name can be NAMED by rule 1 and PLAIN TEXT by rule 2. That is the drill
 * contract working, not a bug: a named row is not automatically a door.
 *
 * BOTH ARE PURE. They take RESOLVED FACTS, never a database handle, because the
 * SAME rule has to run in two places — the server (facts from SQL) and the
 * client (facts from the payload it was served). A second, client-side copy of
 * either rule is precisely the "second, unproven RBAC path" the annex warns
 * about (:557-561).
 */

/**
 * The viewer, as the two rules see them.
 *
 * `Pick<…, 'teammate'>` and not the whole grant object, deliberately: these
 * rules read exactly one column, and narrowing the input is what lets the CLIENT
 * consume them from a `/reports/meta` payload that carries only the two drill
 * columns — instead of shipping the full policy object to the browser, or
 * casting a partial one into the full shape at every call site.
 */
export interface DrillViewer {
  grants: Pick<ReportScopeGrants, 'teammate'>
}

/** The subject of a NAMED row, as resolved facts. */
export interface NamedRowSubject {
  /** `null` for an aggregate/remainder row — a row with no subject to name. */
  id: string | null
  /**
   * Is the subject inside the viewer's PEOPLE scope (own cost-centre subtree,
   * own region at an all-regions width)? Resolved by the caller: server-side
   * from the scope predicate, client-side from the payload the server served.
   */
  inPeopleScope: boolean
  /** The subject IS the viewer. Always nameable (annex :521-526 names self). */
  isSelf: boolean
}

/** Where the row sits: the project whose table is being rendered, if any. */
export interface NamedRowProjectContext {
  /**
   * The VIEWER holds current membership of this project. Membership names
   * team-mates on the member-depth team table with no grants model involved —
   * which is why it names but never drills.
   */
  viewerIsMember: boolean
}

/**
 * ROW-NAMING (rule 1). Name the subject iff they are in the viewer's
 * people-scope, or the viewer is a member of the project the row belongs to, or
 * the subject is the viewer; else the row folds into the ONE aggregate
 * remainder so the table still foots to the whole-project total (C3, annex
 * :399/:521-526).
 *
 * Consumed by the project reports-depth named rows (D37) and by the admin
 * preview. It says NOTHING about whether the resulting name is a link — that is
 * {@link teammateDrillAdmission}, and only that.
 */
export function namedContributionRow(
  viewer: DrillViewer,
  subject: NamedRowSubject,
  projectCtx: NamedRowProjectContext,
): boolean {
  // An unidentified subject cannot be named at all — there is no name to print
  // and no id to key on; it IS the remainder.
  if (subject.id == null) return false
  if (subject.isSelf) return true
  if (projectCtx.viewerIsMember) return true
  return viewer.grants.teammate === 'people-scope' && subject.inPeopleScope
}

/** The subject of a DRILL, as resolved facts — D34's two conjuncts, separated. */
export interface DrillSubject {
  /** `null` when the row names no target id (`__null_*` keys, folded rows). */
  id: string | null
  /**
   * CONJUNCT 1 — EMIT-TIME HOMING: ≥1 in-window `v_complete_usage` row for this
   * subject ALREADY inside the viewer's scope predicate (annex :902-909).
   *
   * NOT "the subject is currently placed in my scope": §A homes point-in-time,
   * so current-placement gating makes moved-OUT teammates dead rows in the very
   * table that named them, and lets moved-IN teammates leak history earned
   * somewhere the viewer cannot see.
   *
   * Server-side this is the EXISTS the endpoint runs. Client-side the row's own
   * presence in a scope-clamped report IS the evidence — that row was computed
   * over exactly this predicate and window.
   */
  hasInScopeWindowRow: boolean
  /**
   * CONJUNCT 2 — `teammate.is_active` (drizzle/schema/identity.ts:86), a
   * SEPARATE conjunct and never folded into conjunct 1. `teammate.revoked_at`
   * is a session anchor, not a deactivation flag (`identity.ts:94-98`), and
   * plays no part here.
   */
  isActive: boolean | undefined
  /**
   * CONJUNCT 3 — `teammate.provisional` (drizzle/schema/identity.ts:80-86): a
   * SHADOW teammate minted by the unauthenticated enrol path, whose email is a
   * CLAIM nobody has yet authenticated (mig 0057).
   *
   * A shadow is `is_active = true`, so the first two conjuncts admit it. That
   * published an audited, named-person governance page under an UNCONFIRMED
   * identity: anyone able to enrol could claim `victim@corp.example`, emit, and
   * have the estate's own reporting surface attribute their figures to the
   * victim by name (r3-H2). The claim is not evidence, so the page it would
   * headline does not exist yet — this is a REFUSAL, not a redaction.
   *
   * REQUIRED, deliberately: the two rules take resolved facts, and a security
   * conjunct with a default is a conjunct a new call site can forget. The
   * client-side helper {@link teammateDrillTarget} supplies the default its own
   * surfaces are entitled to; the RULE never assumes.
   */
  isProvisional: boolean | undefined
}

/**
 * The scope FRAME the drill is opened from — the `?src=` token (D16/D30) and
 * whether it resolved against a grant the VIEWER actually holds.
 *
 * `src` selects which of the caller's own grants frames the view; it NEVER
 * authorises (D33). A `src` naming a scope the caller does not hold is a 403,
 * not a fallback — which is what `held: false` expresses here.
 */
export interface DrillScopeFrame {
  src: string | null
  held: boolean
}

/** The resolved reporting window the drill carries (D16). */
export interface DrillWindow {
  from: string
  to: string
}

export type TeammateDrillRefusal =
  | 'no-teammate-grant'
  | 'no-scope-frame'
  | 'unidentified-subject'
  | 'provisional-subject'
  | 'no-in-scope-row'
  | 'inactive-subject'
  | 'no-window'

export type TeammateDrillDecision =
  | { admit: true }
  | { admit: false; reason: TeammateDrillRefusal }

/**
 * DRILL ADMISSION (rule 2) — D34's conjunction, ALWAYS, in one place.
 *
 * `grants.teammate === 'people-scope'` ∧ the `src` frame is one the viewer holds
 * ∧ the subject is identified ∧ the subject's identity is CONFIRMED (not a
 * provisional shadow) ∧ ≥1 in-window row already inside that scope
 * ∧ `subject.is_active`.
 *
 * PROJECT MEMBERSHIP NEVER OPENS THE DRILL. It is absent from the conjunction on
 * purpose: no `src` token can express a membership frame, so a membership arm
 * here could not carry the C14 entry predicate anyway — it would open a page
 * with no scope to compute over, which is the bare `teammate_id` C14 exists to
 * forbid.
 *
 * The refusal REASON is returned rather than a bare boolean so the endpoint's
 * 403 and the client's plain-text fallback are driven by the same statement, and
 * so a test can pin WHICH conjunct failed (T31 isolates `is_active`).
 */
export function teammateDrillAdmission(
  viewer: DrillViewer,
  subject: DrillSubject,
  scopePredicate: DrillScopeFrame,
  window: DrillWindow | null,
): TeammateDrillDecision {
  if (viewer.grants.teammate !== 'people-scope') return { admit: false, reason: 'no-teammate-grant' }
  if (!scopePredicate.src || !scopePredicate.held) return { admit: false, reason: 'no-scope-frame' }
  if (window == null) return { admit: false, reason: 'no-window' }
  if (subject.id == null) return { admit: false, reason: 'unidentified-subject' }
  // Identity EXISTENCE and identity CONFIRMATION are adjacent conjuncts: an
  // unconfirmed claimed identity is no more a publishable subject than none.
  //
  // BOTH read UNKNOWN AS DISQUALIFYING (r7-H1). `isProvisional` admits only on
  // an explicit `false`, and `isActive` only on an explicit `true`, so a caller
  // that cannot state a fact — a row from a payload that predates it, an
  // identity lookup that returned nothing — is refused rather than admitted by
  // the shape of its own absence. This is the rule; `teammateDrillTarget` is
  // its client mirror, and neither may soften it.
  if (subject.isProvisional !== false) return { admit: false, reason: 'provisional-subject' }
  if (!subject.hasInScopeWindowRow) return { admit: false, reason: 'no-in-scope-row' }
  if (subject.isActive !== true) return { admit: false, reason: 'inactive-subject' }
  return { admit: true }
}
