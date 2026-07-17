// @vitest-environment node
/*
 * report-visibility policy — the ONE source of truth (shared/auth/report-visibility.ts).
 *
 * Pins reportGrants against the static WHO-SEES-WHAT matrix (the SAME object the admin
 * pane renders), so preview and enforcement can never drift; the finance zombie role,
 * the garbage-mode fail-closed, and the revoked-owner (ownsCostCentre=false) cases; and
 * the migration-0087 CHECK literals against REPORT_VISIBILITY_MODES (0084-style — the DB
 * enum and the TS module can never diverge).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPORT_VISIBILITY_MODES,
  REPORT_VISIBILITY_PERSONAS,
  WHO_SEES_WHAT,
  reportGrants,
  isReportVisibilityMode,
  type ReportScopeGrants,
} from '../../../shared/auth/report-visibility'
import type { Role } from '../../../shared/auth/roles'

describe('reportGrants — pinned to the WHO-SEES-WHAT matrix (3 modes × 6 personas)', () => {
  for (const mode of REPORT_VISIBILITY_MODES) {
    for (const persona of REPORT_VISIBILITY_PERSONAS) {
      it(`${mode} × ${persona.key} matches the matrix`, () => {
        const got = reportGrants(mode, { role: persona.role, ownsCostCentre: persona.ownsCostCentre })
        expect(got).toEqual(WHO_SEES_WHAT[mode][persona.key])
      })
    }
  }
})

describe('reportGrants — standard-mode is byte-identical to meta.get.ts (real personas)', () => {
  it('cross-region roles get across + finance; a region admin gets NO finance under standard', () => {
    expect(reportGrants('standard', { role: 'global-finops', ownsCostCentre: false })).toEqual({
      across: true,
      regional: 'all-regions',
      costCentre: 'owned-or-subtree',
      finance: true,
    } satisfies ReportScopeGrants)
    // A region admin sees finance ONLY via a loosened mode — never under standard.
    expect(reportGrants('standard', { role: 'admin', ownsCostCentre: false }).finance).toBe(false)
    expect(reportGrants('standard', { role: 'admin', ownsCostCentre: false }).across).toBe(false)
  })

  it('a plain developer (no ownership) gets no cost-centre, no across, no finance', () => {
    expect(reportGrants('standard', { role: 'developer', ownsCostCentre: false })).toEqual({
      across: false,
      regional: 'own-region',
      costCentre: false,
      finance: false,
    } satisfies ReportScopeGrants)
  })
})

describe('reportGrants — sg-M7 zombie finance role', () => {
  it("the enum member 'finance' is benign (developer-tier: no across, no finance) in every mode", () => {
    for (const mode of REPORT_VISIBILITY_MODES) {
      const g = reportGrants(mode, { role: 'finance' as Role, ownsCostCentre: false })
      expect(g.across).toBe(false)
      expect(g.finance).toBe(false)
      expect(g.regional).toBe('own-region')
    }
  })
})

describe('reportGrants — sg-M5 fail-closed on garbage mode', () => {
  it('an unknown mode collapses to standard grants (never throws, never permissive)', () => {
    const garbage = reportGrants('made-up-mode' as never, { role: 'admin', ownsCostCentre: false })
    expect(garbage).toEqual(reportGrants('standard', { role: 'admin', ownsCostCentre: false }))
    // A region admin under garbage must NOT get across / finance (fail-closed to standard).
    expect(garbage.across).toBe(false)
    expect(garbage.finance).toBe(false)
  })
})

describe('reportGrants — sg-L10 revoked/expired ownership grants nothing', () => {
  it('ownsCostCentre=false yields no elevation even under all-admins-see-all', () => {
    // A revoked cou_owner row resolves to ownsCostCentre=false at the call site, so the
    // matrix treats it as a plain developer — no full report set.
    const g = reportGrants('all-admins-see-all', { role: 'developer', ownsCostCentre: false })
    expect(g).toEqual({ across: false, regional: 'own-region', costCentre: false, finance: false })
  })

  it('an ACTIVE owner (ownsCostCentre=true) IS elevated under all-admins-see-all', () => {
    const g = reportGrants('all-admins-see-all', { role: 'developer', ownsCostCentre: true })
    expect(g).toEqual({ across: true, regional: 'all-regions', costCentre: 'all', finance: true })
  })
})

describe('migration 0087 CHECK literals pinned to REPORT_VISIBILITY_MODES (0084-style)', () => {
  const migration = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle/migrations/0087_report_visibility_setting.sql'),
    'utf8',
  )

  it('the mode CHECK lists exactly the three module literals', () => {
    const m = migration.match(/mode\s+TEXT\s+NOT NULL\s+CHECK \(mode IN \(([^)]*)\)\)/i)
    expect(m, 'mode CHECK not found in 0087').toBeTruthy()
    const literals = m![1]!.split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    expect(literals).toEqual([...REPORT_VISIBILITY_MODES])
    for (const lit of literals) expect(isReportVisibilityMode(lit)).toBe(true)
  })

  it("the key is pinned to 'policy' (single logical row) and no row is seeded", () => {
    expect(migration).toMatch(/key\s+TEXT\s+PRIMARY KEY\s+DEFAULT 'policy'\s+CHECK \(key = 'policy'\)/i)
    expect(migration).not.toMatch(/INSERT\s+INTO\s+report_visibility_setting/i)
  })
})
