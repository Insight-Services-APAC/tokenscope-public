// @vitest-environment node
/*
 * Region absorbs Across — the landing invariant (04-prototype-delta.md §6/§7).
 *
 * THE INVARIANT, STATED POSITIVELY: every (visibility mode × role × cost-centre
 * ownership) combination resolves to EXACTLY ONE landing scope, and — when that
 * scope is Region — exactly one landing WIDTH. None resolves to zero.
 *
 * That is not a stylistic preference. Before the merge, Across-Regions and Regional
 * were separately-granted tabs, and the shell picked the first granted one. Deleting
 * the Across tab without a total mapping strands whoever the remaining rules do not
 * name — most obviously a caller holding `across: false`, who had a Regional tab to
 * fall back to and now must be given a width of the merged one. "Nowhere to go" is a
 * blank page behind a tab that renders, not a 403, so nothing else in the stack
 * would report it.
 *
 * The assertions run over the FULL cross product (every mode × every role literal ×
 * both ownership states = 36), not just the six named personas, so a role that never
 * appears in the persona list still has to land somewhere.
 */
import { describe, it, expect } from 'vitest'
import {
  REPORT_VISIBILITY_MODES,
  REPORT_VISIBILITY_PERSONAS,
  WHO_SEES_WHAT_REGION,
  regionScopeGrant,
  reportGrants,
  grantsToScopes,
  type ReportScopeGrants,
  type RegionScopeGrant,
} from '../../../shared/auth/report-visibility'
import { REPORT_SCOPES, type ReportScope } from '../../../shared/reports/types'
import { ROLES, type Role } from '../../../shared/auth/roles'

/**
 * The shell's own rule, restated here rather than imported: tabs are REPORT_SCOPES
 * filtered by grant, and the landing scope is the first survivor. Keeping a local
 * copy is what makes this a test of the RULE and not of one implementation of it —
 * `/reports/meta` computing `scopes[0]` differently would show up here.
 */
function landingScope(g: ReportScopeGrants): ReportScope | null {
  const tabs: Record<ReportScope, boolean> = {
    region: regionScopeGrant(g).tab,
    'cost-centre': g.costCentre !== false,
    finance: g.finance,
  }
  return REPORT_SCOPES.filter((s) => tabs[s])[0] ?? null
}

const EVERY_CALLER = REPORT_VISIBILITY_MODES.flatMap((mode) =>
  ROLES.flatMap((role: Role) =>
    [true, false].map((ownsCostCentre) => ({ mode, role, ownsCostCentre })),
  ),
)

describe('every (mode × role × ownership) lands on exactly one scope — never zero', () => {
  for (const { mode, role, ownsCostCentre } of EVERY_CALLER) {
    it(`${mode} × ${role} × owns=${ownsCostCentre}`, () => {
      const g = reportGrants(mode, { role, ownsCostCentre })
      const scope = landingScope(g)

      // NEVER ZERO. A caller with no granted scope at all has no reporting area to
      // open, which is the strand this merge could have created.
      expect(scope, `${mode}/${role}/owns=${ownsCostCentre} has NO landing scope`).not.toBeNull()

      // EXACTLY ONE. `landingScope` returns the first, so the real assertion is that
      // the first is well-defined: it must be a scope this caller is actually granted.
      const granted = REPORT_SCOPES.filter((s) =>
        s === 'region'
          ? regionScopeGrant(g).tab
          : s === 'cost-centre'
            ? g.costCentre !== false
            : g.finance,
      )
      expect(granted).toContain(scope)
      expect(granted[0]).toBe(scope)
    })
  }
})

describe('the Region tab always resolves exactly one landing WIDTH', () => {
  for (const { mode, role, ownsCostCentre } of EVERY_CALLER) {
    it(`${mode} × ${role} × owns=${ownsCostCentre}`, () => {
      const rg = regionScopeGrant(reportGrants(mode, { role, ownsCostCentre }))
      if (rg.tab) {
        // One landing, and it is a width this caller may actually be served.
        expect(rg.landing).not.toBeNull()
        expect(['all-regions', 'own-region']).toContain(rg.landing)
        if (rg.landing === 'all-regions') expect(rg.allRegions).toBe(true)
        if (rg.landing === 'own-region') expect(rg.ownRegion).toBe(true)
      } else {
        // No tab ⇒ no landing width, and no width may be served either.
        expect(rg.landing).toBeNull()
        expect(rg.allRegions).toBe(false)
        expect(rg.ownRegion).toBe(false)
      }
    })
  }
})

describe('regionScopeGrant — pinned to the hand-written WHO_SEES_WHAT_REGION matrix', () => {
  for (const mode of REPORT_VISIBILITY_MODES) {
    for (const persona of REPORT_VISIBILITY_PERSONAS) {
      it(`${mode} × ${persona.key} matches the matrix`, () => {
        const got = regionScopeGrant(
          reportGrants(mode, { role: persona.role, ownsCostCentre: persona.ownsCostCentre }),
        )
        expect(got).toEqual(WHO_SEES_WHAT_REGION[mode][persona.key])
      })
    }
  }

  it('the matrix names a landing for EVERY cell — the §7 persona-matrix row', () => {
    for (const mode of REPORT_VISIBILITY_MODES) {
      for (const persona of REPORT_VISIBILITY_PERSONAS) {
        const cell = WHO_SEES_WHAT_REGION[mode][persona.key]
        expect(cell.tab, `${mode}/${persona.key} lost its Region tab`).toBe(true)
        expect(cell.landing, `${mode}/${persona.key} has no landing`).not.toBeNull()
      }
    }
  })
})

/*
 * The §6 grant table, transcribed. Each row is a caller's held grants and the
 * selector those grants buy. The first three are the rows §6 writes out; the last
 * three are the combinations today's role matrix never produces, pinned so the
 * mapping stays TOTAL — the point of the merge is that no held-grant combination is
 * left without an answer.
 */
const SELECTOR_TABLE: Array<{
  name: string
  grants: Pick<ReportScopeGrants, 'across' | 'regional'>
  expected: RegionScopeGrant
}> = [
  {
    name: 'across:true → All regions + every region, lands on All regions',
    grants: { across: true, regional: 'all-regions' },
    expected: { tab: true, allRegions: true, crossRegion: true, ownRegion: true, landing: 'all-regions' },
  },
  {
    name: "across:false, regional:'all-regions' → every region, no All, lands on own region",
    grants: { across: false, regional: 'all-regions' },
    expected: { tab: true, allRegions: false, crossRegion: true, ownRegion: true, landing: 'own-region' },
  },
  {
    name: "across:false, regional:'own-region' → no selector rendered, lands on own region",
    grants: { across: false, regional: 'own-region' },
    expected: { tab: true, allRegions: false, crossRegion: false, ownRegion: true, landing: 'own-region' },
  },
  {
    name: 'regional:false (and no across) → tab absent',
    grants: { across: false, regional: false },
    expected: { tab: false, allRegions: false, crossRegion: false, ownRegion: false, landing: null },
  },
  {
    name: "across:true, regional:'own-region' → All + own region only (unreachable today)",
    grants: { across: true, regional: 'own-region' },
    expected: { tab: true, allRegions: true, crossRegion: false, ownRegion: true, landing: 'all-regions' },
  },
  {
    name: 'across:true, regional:false → All regions only, no single region (unreachable today)',
    grants: { across: true, regional: false },
    expected: { tab: true, allRegions: true, crossRegion: false, ownRegion: false, landing: 'all-regions' },
  },
]

describe('§6 grant table — the selector options ARE the grant', () => {
  for (const row of SELECTOR_TABLE) {
    it(row.name, () => {
      const g: ReportScopeGrants = { ...row.grants, costCentre: false, finance: false }
      expect(regionScopeGrant(g)).toEqual(row.expected)
    })
  }

  it('covers all 6 (across × regional) combinations — the mapping is TOTAL', () => {
    const seen = new Set(
      SELECTOR_TABLE.map((r) => `${r.grants.across}|${String(r.grants.regional)}`),
    )
    expect(seen.size).toBe(6)
  })

  it('no option is offered that the grant does not back', () => {
    for (const row of SELECTOR_TABLE) {
      const g: ReportScopeGrants = { ...row.grants, costCentre: false, finance: false }
      const rg = regionScopeGrant(g)
      // "All regions" IS `across` — never inferred from a regional grant.
      expect(rg.allRegions).toBe(g.across === true)
      // "any region" IS `regional: 'all-regions'` — never inferred from `across`.
      expect(rg.crossRegion).toBe(g.regional === 'all-regions')
      // A caller with `regional: false` is offered no single region, even holding across.
      if (g.regional === false) expect(rg.ownRegion).toBe(false)
    }
  })
})

describe('grantsToScopes — ONE Region line, never a retired Across one', () => {
  it('never names a scope that no longer exists', () => {
    for (const mode of REPORT_VISIBILITY_MODES) {
      for (const persona of REPORT_VISIBILITY_PERSONAS) {
        const scopes = grantsToScopes(
          reportGrants(mode, { role: persona.role, ownsCostCentre: persona.ownsCostCentre }),
        )
        expect(scopes.join(' · ')).not.toMatch(/Across regions|Regional \(/)
        // Exactly one Region line — the tab is one tab.
        expect(scopes.filter((s) => s.startsWith('Region ')).length).toBe(1)
      }
    }
  })

  it('names the WIDTHS the caller holds', () => {
    expect(
      grantsToScopes({
        across: true,
        regional: 'all-regions',
        costCentre: false,
        finance: false,
        teammate: 'people-scope',
        project: 'region-wide',
      }),
    ).toContain('Region (all regions + every region)')
    expect(
      grantsToScopes({
        across: false,
        regional: 'all-regions',
        costCentre: false,
        finance: false,
        teammate: 'people-scope',
        project: 'region-wide',
      }),
    ).toContain('Region (every region)')
    expect(
      grantsToScopes({
        across: false,
        regional: 'own-region',
        costCentre: false,
        finance: false,
        teammate: false,
        project: 'membership',
      }),
    ).toContain('Region (own region)')
    expect(
      grantsToScopes({
        across: false,
        regional: false,
        costCentre: false,
        finance: false,
        teammate: false,
        project: 'membership',
      }),
    ).not.toContain('Region (own region)')
  })
})
