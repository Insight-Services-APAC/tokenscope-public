/*
 * Pure unit tests for the seven-state GitHub enterprise-org coverage classifier
 * (server/reconciliation/coverage.ts) — no DB, no network. Pins the exact precedence
 * table from docs/design/usage-completeness-and-provider-governance.md §6, including
 * the census-independent/dependent split the design doc itself calls out as an
 * apparent (and resolved) contradiction.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyOrgCoverage,
  summariseEnterpriseCoverage,
  COVERAGE_STATES,
  isNonConnected,
  type OrgCoverageFacts,
  type CoverageState,
} from '../../../server/reconciliation/coverage'

const ENT = 'ent-1'
const OTHER_ENT = 'ent-2'

/** A fully-onboarded, healthy baseline — each test overrides only what it needs. */
function baseFacts(overrides: Partial<OrgCoverageFacts> = {}): OrgCoverageFacts {
  return {
    providerOrgId: 'row-1',
    linkedEnterpriseId: ENT,
    costOwningUnitId: 'cou-1',
    targetEnterpriseId: ENT,
    censusAvailable: true,
    inCensus: true,
    installation: 'active',
    ...overrides,
  }
}

describe('classifyOrgCoverage — the seven states', () => {
  it('connected: current census member, active install, linked + homed', () => {
    expect(classifyOrgCoverage(baseFacts())).toBe('connected')
  })

  it('mislinked: provider_org row belongs to a DIFFERENT enterprise', () => {
    expect(classifyOrgCoverage(baseFacts({ linkedEnterpriseId: OTHER_ENT }))).toBe('mislinked')
  })

  it('coverage-unknown: installation belongs to a different App', () => {
    expect(classifyOrgCoverage(baseFacts({ installation: 'different-app' }))).toBe('coverage-unknown')
  })

  it('coverage-unknown: the installation probe itself failed', () => {
    expect(classifyOrgCoverage(baseFacts({ installation: 'probe-failed' }))).toBe('coverage-unknown')
  })

  it('stale: tracked (provider_org row), but absent from an AVAILABLE census', () => {
    expect(classifyOrgCoverage(baseFacts({ inCensus: false }))).toBe('stale')
  })

  it('not-installed: a current census member, but no installation of this App', () => {
    expect(
      classifyOrgCoverage(baseFacts({ providerOrgId: null, linkedEnterpriseId: null, costOwningUnitId: null, installation: 'not-found' })),
    ).toBe('not-installed')
  })

  it('suspended: installation of this App exists but is suspended', () => {
    expect(classifyOrgCoverage(baseFacts({ installation: 'suspended' }))).toBe('suspended')
  })

  it('not-onboarded: installed, but no provider_org row at all', () => {
    expect(classifyOrgCoverage(baseFacts({ providerOrgId: null, linkedEnterpriseId: null, costOwningUnitId: null }))).toBe(
      'not-onboarded',
    )
  })

  it('not-onboarded: installed + a row exists, but no cost-owning-unit home', () => {
    expect(classifyOrgCoverage(baseFacts({ costOwningUnitId: null }))).toBe('not-onboarded')
  })

  it('not-onboarded: installed + a row exists, but the row carries no enterprise link at all', () => {
    expect(classifyOrgCoverage(baseFacts({ linkedEnterpriseId: null }))).toBe('not-onboarded')
  })

  it('every declared state is reachable and the enumeration is exhaustive (7 states, no more, no less)', () => {
    expect(COVERAGE_STATES).toHaveLength(7)
    expect(new Set(COVERAGE_STATES).size).toBe(7)
  })
})

describe('classifyOrgCoverage — precedence (first match wins)', () => {
  it('mislinked beats coverage-unknown (a bad link is reported even if the App is also wrong)', () => {
    expect(classifyOrgCoverage(baseFacts({ linkedEnterpriseId: OTHER_ENT, installation: 'different-app' }))).toBe(
      'mislinked',
    )
  })

  it('mislinked beats stale', () => {
    expect(classifyOrgCoverage(baseFacts({ linkedEnterpriseId: OTHER_ENT, inCensus: false }))).toBe('mislinked')
  })

  it('mislinked beats not-onboarded (no CoU) and suspended', () => {
    expect(
      classifyOrgCoverage(baseFacts({ linkedEnterpriseId: OTHER_ENT, costOwningUnitId: null, installation: 'suspended' })),
    ).toBe('mislinked')
  })

  it('stale beats not-installed/suspended/not-onboarded/connected — unconditional on installation state', () => {
    for (const installation of ['not-found', 'suspended', 'active'] as const) {
      expect(classifyOrgCoverage(baseFacts({ inCensus: false, installation }))).toBe('stale')
    }
  })

  it('stale beats not-onboarded even when the stale row also has no CoU', () => {
    expect(classifyOrgCoverage(baseFacts({ inCensus: false, costOwningUnitId: null }))).toBe('stale')
  })

  it('not-installed beats not-onboarded/connected framing (no install ⇒ never reaches onboarding checks)', () => {
    expect(classifyOrgCoverage(baseFacts({ installation: 'not-found' }))).toBe('not-installed')
  })

  it('suspended beats not-onboarded (a suspended, unhomed org reports suspended, not not-onboarded)', () => {
    expect(classifyOrgCoverage(baseFacts({ installation: 'suspended', costOwningUnitId: null, providerOrgId: null, linkedEnterpriseId: null }))).toBe(
      'suspended',
    )
  })
})

describe('classifyOrgCoverage — census-independent vs census-dependent (the "authoritative fallback")', () => {
  // §6: "mislinked, suspended, not-onboarded, and connected... remain reportable per
  // org" even when the census is down; "stale" and "not-installed" become undecidable.
  it('degraded (no census): a KNOWN org confirmed suspended is still reported suspended, not coverage-unknown', () => {
    expect(classifyOrgCoverage(baseFacts({ censusAvailable: false, inCensus: false, installation: 'suspended' }))).toBe(
      'suspended',
    )
  })

  it('degraded (no census): a KNOWN org confirmed active + onboarded is still reported connected', () => {
    expect(classifyOrgCoverage(baseFacts({ censusAvailable: false, inCensus: false, installation: 'active' }))).toBe(
      'connected',
    )
  })

  it('degraded (no census): a KNOWN org confirmed active but unhomed is still reported not-onboarded', () => {
    expect(
      classifyOrgCoverage(
        baseFacts({ censusAvailable: false, inCensus: false, installation: 'active', costOwningUnitId: null }),
      ),
    ).toBe('not-onboarded')
  })

  it('degraded (no census): mislinked still fires (a pure DB cross-check, no census needed)', () => {
    expect(classifyOrgCoverage(baseFacts({ censusAvailable: false, inCensus: false, linkedEnterpriseId: OTHER_ENT }))).toBe(
      'mislinked',
    )
  })

  it('degraded (no census): a 404 (not-found) is UNDECIDABLE — never guessed as stale or not-installed', () => {
    const result = classifyOrgCoverage(baseFacts({ censusAvailable: false, inCensus: false, installation: 'not-found' }))
    expect(result).toBe('coverage-unknown')
    expect(result).not.toBe('stale')
    expect(result).not.toBe('not-installed')
  })

  it('degraded (no census), no row, not-found install: never fabricates stale (needs a row) or not-installed (needs census)', () => {
    expect(
      classifyOrgCoverage(
        baseFacts({
          censusAvailable: false,
          inCensus: false,
          installation: 'not-found',
          providerOrgId: null,
          linkedEnterpriseId: null,
          costOwningUnitId: null,
        }),
      ),
    ).toBe('coverage-unknown')
  })
})

describe('isNonConnected', () => {
  it('true for every state except connected', () => {
    for (const s of COVERAGE_STATES) {
      expect(isNonConnected(s)).toBe(s !== 'connected')
    }
  })
})

describe('summariseEnterpriseCoverage — denominator is a SEPARATE claim from per-org states', () => {
  it('denominator is null when the census was never obtained (no false "0 of 0")', () => {
    const states: CoverageState[] = []
    const summary = summariseEnterpriseCoverage(states, { censusAvailable: false, censusCapped: false, censusSize: 0 })
    expect(summary.denominator).toBeNull()
    expect(summary.connected).toBe(0)
    // Every state key is present and zeroed — never an absent key rendering as undefined.
    for (const s of COVERAGE_STATES) expect(summary.states[s]).toBe(0)
  })

  it('denominator is null when the census pull hit its pagination cap, even though it "succeeded"', () => {
    const states: CoverageState[] = ['connected', 'connected', 'not-installed']
    const summary = summariseEnterpriseCoverage(states, { censusAvailable: true, censusCapped: true, censusSize: 3 })
    expect(summary.denominator).toBeNull()
    expect(summary.connected).toBe(2)
  })

  it('denominator is the AUTHORITATIVE census size, not the observed-org count, when uncapped', () => {
    // Two connected + one stale (a row the census no longer lists) — censusSize (12)
    // is the enterprise's real org count; the stale straggler must not inflate it.
    const states: CoverageState[] = ['connected', 'connected', 'stale']
    const summary = summariseEnterpriseCoverage(states, { censusAvailable: true, censusCapped: false, censusSize: 12 })
    expect(summary.denominator).toBe(12)
    expect(summary.connected).toBe(2)
    expect(summary.states.stale).toBe(1)
  })

  it('an empty, genuinely-empty enterprise with a WORKING census legitimately reports 0 of 0', () => {
    // The difference from the "no false 0-of-0" test above: censusAvailable is TRUE
    // here (the call actually succeeded and confirmed zero orgs), so 0 is an honest
    // claim, not a fabricated one from absence of signal.
    const summary = summariseEnterpriseCoverage([], { censusAvailable: true, censusCapped: false, censusSize: 0 })
    expect(summary.denominator).toBe(0)
  })

  it('counts every state key, including states with zero members', () => {
    const states: CoverageState[] = ['connected', 'mislinked', 'mislinked']
    const summary = summariseEnterpriseCoverage(states, { censusAvailable: true, censusCapped: false, censusSize: 3 })
    expect(summary.states).toEqual({
      mislinked: 2,
      'coverage-unknown': 0,
      stale: 0,
      'not-installed': 0,
      suspended: 0,
      'not-onboarded': 0,
      connected: 1,
    })
  })
})
