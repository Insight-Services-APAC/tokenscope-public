// @vitest-environment node
/*
 * report-visibility (mig 0129) — the ONE source of truth for report-ACCESS
 * vocabulary. Replaces the retired three-mode `reportGrants` matrix test.
 *
 * Pins `baselineGrants` against WHO_SEES_WHAT_BASELINE and `effectiveReportGrants`
 * against WHO_SEES_WHAT_ELEVATED (the SAME shape the admin pane can render), so
 * preview and enforcement can never drift; proves the non-elevated roles
 * (developer/manager/admin/cost-centre-owner) are BYTE-IDENTICAL to the retired
 * standard grants (no-change-for-non-elevated-roles proof); proves totality and
 * monotonicity over the full (role × ownership × permission-subset) space; the
 * zombie `finance` role, the unknown-role fail-closed default; and the
 * migration-0129 CHECK literals against REPORT_ACCESS_PERMISSIONS (0084-style).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPORT_ACCESS_PERMISSIONS,
  REPORT_VISIBILITY_PERSONAS,
  WHO_SEES_WHAT_BASELINE,
  WHO_SEES_WHAT_ELEVATED,
  baselineGrants,
  effectiveReportGrants,
  isReportAccessPermission,
  type ReportAccessPermission,
  type ReportScopeGrants,
} from '../../../shared/auth/report-visibility'
import { ROLES, type Role } from '../../../shared/auth/roles'

describe('baselineGrants — pinned to WHO_SEES_WHAT_BASELINE (6 personas)', () => {
  for (const persona of REPORT_VISIBILITY_PERSONAS) {
    it(`${persona.key} matches the baseline table`, () => {
      const got = baselineGrants(persona.role, persona.ownsCostCentre)
      expect(got).toEqual(WHO_SEES_WHAT_BASELINE[persona.key])
    })
  }
})

describe('baselineGrants — byte-identical to the retired standard grants for non-elevated roles', () => {
  it('developer (no ownership): no across, no finance, no cost-centre', () => {
    expect(baselineGrants('developer', false)).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: false,
      finance: false,
      teammate: false,
      project: 'membership',
    } satisfies ReportScopeGrants)
  })

  it('manager: own-region + owned-or-subtree, unconditionally', () => {
    expect(baselineGrants('manager', false)).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: 'owned-or-subtree',
      finance: false,
      teammate: 'people-scope',
      project: 'member-in-scope',
    } satisfies ReportScopeGrants)
  })

  it('admin: identical shape to manager', () => {
    expect(baselineGrants('admin', false)).toEqual(baselineGrants('manager', false))
  })

  it('cost-centre-owner (developer + active ownership): same elevation as manager/admin', () => {
    expect(baselineGrants('developer', true)).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: 'owned-or-subtree',
      finance: false,
      teammate: 'people-scope',
      project: 'member-in-scope',
    } satisfies ReportScopeGrants)
  })

  it('global-finops / platform-admin WITHOUT ownership: region-bound, not cross-region — the behaviour change from the retired role-based grant', () => {
    // Under the retired policy these two roles were UNCONDITIONALLY cross-region
    // (across:true, regional:'all-regions', finance:true) even under 'standard'.
    // The grants model requires an explicit 'operational' grant for that now.
    expect(baselineGrants('global-finops', false)).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: false,
      finance: false,
      teammate: false,
      project: 'membership',
    } satisfies ReportScopeGrants)
    expect(baselineGrants('platform-admin', false)).toEqual(baselineGrants('global-finops', false))
  })

  it('global-finops / platform-admin WITH ownership: cost-centre visible via ownership only, still not cross-region', () => {
    expect(baselineGrants('global-finops', true)).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: 'owned-or-subtree',
      finance: false,
      teammate: 'people-scope',
      project: 'member-in-scope',
    } satisfies ReportScopeGrants)
  })
})

describe('effectiveReportGrants — pinned to WHO_SEES_WHAT_ELEVATED (both permissions, 6 personas)', () => {
  for (const persona of REPORT_VISIBILITY_PERSONAS) {
    it(`${persona.key} matches the elevated table`, () => {
      const got = effectiveReportGrants({
        role: persona.role,
        ownsCostCentre: persona.ownsCostCentre,
        permissions: ['operational', 'finance'],
      })
      expect(got).toEqual(WHO_SEES_WHAT_ELEVATED[persona.key])
    })
  }

  it('every persona lands on the SAME full grant object when both permissions are held', () => {
    const values = REPORT_VISIBILITY_PERSONAS.map((p) => WHO_SEES_WHAT_ELEVATED[p.key])
    for (const v of values) expect(v).toEqual(values[0])
  })
})

describe('effectiveReportGrants — single-permission overlays for developer (no ownership)', () => {
  it("operational-only ⇒ across + all-regions + all BUs, finance stays false", () => {
    const g = effectiveReportGrants({ role: 'developer', ownsCostCentre: false, permissions: ['operational'] })
    expect(g.across).toBe(true)
    expect(g.regional).toBe('all-regions')
    expect(g.costCentre).toBe('all')
    expect(g.finance).toBe(false)
  })

  it("finance-only ⇒ finance true, but regional stays 'own-region', costCentre false, teammate false", () => {
    const g = effectiveReportGrants({ role: 'developer', ownsCostCentre: false, permissions: ['finance'] })
    expect(g.finance).toBe(true)
    expect(g.across).toBe(false)
    expect(g.regional).toBe('own-region')
    expect(g.costCentre).toBe(false)
    expect(g.teammate).toBe(false)
  })

  it('no permissions ⇒ exactly the baseline', () => {
    expect(effectiveReportGrants({ role: 'developer', ownsCostCentre: false, permissions: [] })).toEqual(
      baselineGrants('developer', false),
    )
  })
})

/*
 * ── Union totality & monotonicity ─────────────────────────────────────────
 * Every (role × ownership × permission-subset) — 6 × 2 × 4 = 48 — must yield a
 * VALID ReportScopeGrants, and adding a permission must never NARROW any field.
 * Rank tables mirror the module's own ordering, stated independently here
 * (an INDEPENDENT statement, not an import of the internal ranking) so this is
 * a real pin on the union's monotonicity contract, not a tautology.
 */
const REGIONAL_RANK: Record<string, number> = { false: 0, 'own-region': 1, 'all-regions': 2 }
const COST_CENTRE_RANK: Record<string, number> = { false: 0, 'owned-or-subtree': 1, all: 2 }
const TEAMMATE_RANK: Record<string, number> = { false: 0, 'people-scope': 1 }
const PROJECT_RANK: Record<string, number> = { false: 0, membership: 1, 'member-in-scope': 2, 'region-wide': 3 }

function isValidGrants(g: ReportScopeGrants): boolean {
  return (
    typeof g.across === 'boolean' &&
    String(g.regional) in REGIONAL_RANK &&
    String(g.costCentre) in COST_CENTRE_RANK &&
    typeof g.finance === 'boolean' &&
    String(g.teammate) in TEAMMATE_RANK &&
    String(g.project) in PROJECT_RANK
  )
}

/** `b` is field-wise ≥ `a` on every field — never narrower. */
function widensOrEqual(a: ReportScopeGrants, b: ReportScopeGrants): boolean {
  return (
    (a.across ? b.across : true) &&
    REGIONAL_RANK[String(b.regional)]! >= REGIONAL_RANK[String(a.regional)]! &&
    COST_CENTRE_RANK[String(b.costCentre)]! >= COST_CENTRE_RANK[String(a.costCentre)]! &&
    (a.finance ? b.finance : true) &&
    TEAMMATE_RANK[String(b.teammate)]! >= TEAMMATE_RANK[String(a.teammate)]! &&
    PROJECT_RANK[String(b.project)]! >= PROJECT_RANK[String(a.project)]!
  )
}

const PERMISSION_SUBSETS: ReportAccessPermission[][] = [
  [],
  ['operational'],
  ['finance'],
  ['operational', 'finance'],
]

describe('effectiveReportGrants — totality + monotonicity over role × ownership × permission-subset', () => {
  for (const role of ROLES) {
    for (const ownsCostCentre of [true, false]) {
      const baseline = effectiveReportGrants({ role, ownsCostCentre, permissions: [] })
      for (const permissions of PERMISSION_SUBSETS) {
        it(`${role} × owns=${ownsCostCentre} × [${permissions.join(',')}] is a valid, non-narrowing grant`, () => {
          const g = effectiveReportGrants({ role, ownsCostCentre, permissions })
          expect(isValidGrants(g), `${JSON.stringify(g)} is not a valid ReportScopeGrants`).toBe(true)
          expect(
            widensOrEqual(baseline, g),
            `adding permissions ${JSON.stringify(permissions)} narrowed a field vs the baseline`,
          ).toBe(true)
        })
      }
      it(`${role} × owns=${ownsCostCentre}: holding BOTH permissions is ≥ holding either alone`, () => {
        const both = effectiveReportGrants({ role, ownsCostCentre, permissions: ['operational', 'finance'] })
        const operationalOnly = effectiveReportGrants({ role, ownsCostCentre, permissions: ['operational'] })
        const financeOnly = effectiveReportGrants({ role, ownsCostCentre, permissions: ['finance'] })
        expect(widensOrEqual(operationalOnly, both)).toBe(true)
        expect(widensOrEqual(financeOnly, both)).toBe(true)
      })
    }
  }
})

describe('sg-M7 zombie finance role', () => {
  it("the enum member 'finance' is benign (developer-tier baseline: no across, no finance) and still elevatable", () => {
    const base = baselineGrants('finance' as Role, false)
    expect(base.across).toBe(false)
    expect(base.finance).toBe(false)
    expect(base.regional).toBe('own-region')

    const elevated = effectiveReportGrants({ role: 'finance' as Role, ownsCostCentre: false, permissions: ['operational', 'finance'] })
    expect(elevated).toEqual(WHO_SEES_WHAT_ELEVATED.developer)
  })
})

describe('fail-closed on an unrecognised role', () => {
  it('an unknown role collapses to developer-tier baseline grants (never throws, never permissive)', () => {
    const garbage = baselineGrants('made-up-role' as Role, false)
    expect(garbage).toEqual(baselineGrants('developer', false))
    expect(garbage.across).toBe(false)
    expect(garbage.finance).toBe(false)
  })
})

describe('isReportAccessPermission', () => {
  it('accepts exactly the two known literals', () => {
    for (const p of REPORT_ACCESS_PERMISSIONS) expect(isReportAccessPermission(p)).toBe(true)
    expect(isReportAccessPermission('bogus')).toBe(false)
    expect(isReportAccessPermission('')).toBe(false)
  })
})

describe('migration 0129 CHECK literals pinned to REPORT_ACCESS_PERMISSIONS (0084-style)', () => {
  const migration = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle/migrations/0129_report_access_grant.sql'),
    'utf8',
  )

  it('the permission CHECK lists exactly the two module literals', () => {
    const m = migration.match(/permission\s+text\s+NOT NULL\s+CHECK \(permission IN \(([^)]*)\)\)/i)
    expect(m, 'permission CHECK not found in 0129').toBeTruthy()
    const literals = m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(literals).toEqual([...REPORT_ACCESS_PERMISSIONS])
    for (const lit of literals) expect(isReportAccessPermission(lit)).toBe(true)
  })

  it('the revoke-shape CHECK requires the actor in the revoked arm (an actorless revocation is unrepresentable)', () => {
    expect(migration).toMatch(/CONSTRAINT report_access_grant_revoke_shape CHECK/i)
    // Both arms, verbatim: active rows carry neither field; revoked rows carry
    // BOTH — tighter than cou_owner's shape, whose revoked arm does not bind
    // the actor despite its comment saying it does.
    expect(migration).toMatch(
      /\(revoked_at IS NULL AND revoked_by IS NULL\)\s*OR \(revoked_at IS NOT NULL AND revoked_by IS NOT NULL\)/,
    )
  })

  it('the migration DROPs report_visibility_setting in the same change', () => {
    expect(migration).toMatch(/DROP TABLE report_visibility_setting;/)
  })
})
