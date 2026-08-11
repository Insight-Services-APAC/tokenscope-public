// @vitest-environment happy-dom
/*
 * CoverageMarker — the GitHub enterprise-org coverage marker (requirement 5,
 * Workstream D `meta.coverage`). Pins:
 *  - not applicable (no GitHub enterprise registered) → renders nothing;
 *  - a known denominator → an honest "N of M" read, never a fabricated ratio;
 *  - an UNKNOWN/STALE denominator → an explicit amber marker, NEVER a bare
 *    omission that could read as "fully covered" (requirement 9: "unknown
 *    coverage no ratio").
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CoverageMarker from '../../../app/components/reporting/CoverageMarker.vue'
import type { ReportCoverageMeta } from '#shared/reports/types'

describe('CoverageMarker', () => {
  it('renders nothing when not applicable (no GitHub enterprise registered)', () => {
    const notApplicable: ReportCoverageMeta = {
      applicable: false,
      denominator: null,
      connected: 0,
      nonConnected: 0,
      stale: false,
    }
    const w = mount(CoverageMarker, { props: { coverage: notApplicable } })
    expect(w.find('[data-testid="coverage-marker"]').exists()).toBe(false)
  })

  it('renders nothing when coverage is absent (undefined/null prop)', () => {
    const w = mount(CoverageMarker, { props: { coverage: null } })
    expect(w.find('[data-testid="coverage-marker"]').exists()).toBe(false)
  })

  it('a KNOWN denominator renders an honest "N of M" — never a fabricated ratio', () => {
    const known: ReportCoverageMeta = {
      applicable: true,
      denominator: 15,
      connected: 12,
      nonConnected: 3,
      stale: false,
    }
    const w = mount(CoverageMarker, { props: { coverage: known } })
    const marker = w.find('[data-testid="coverage-marker"]')
    expect(marker.exists()).toBe(true)
    expect(marker.attributes('data-known')).toBe('true')
    expect(marker.text()).toContain('12')
    expect(marker.text()).toContain('15')
  })

  it('an UNKNOWN denominator (census unavailable) never claims a ratio', () => {
    const unknown: ReportCoverageMeta = {
      applicable: true,
      denominator: null,
      connected: 4,
      nonConnected: 1,
      stale: false,
    }
    const w = mount(CoverageMarker, { props: { coverage: unknown } })
    const marker = w.find('[data-testid="coverage-marker"]')
    expect(marker.attributes('data-known')).toBe('false')
    expect(marker.text()).not.toMatch(/\d+\s*of\s*\d+/)
    expect(marker.text().toLowerCase()).toContain('unknown')
  })

  it('a STALE census never claims complete — names staleness, not a fabricated ratio', () => {
    const stale: ReportCoverageMeta = {
      applicable: true,
      denominator: null,
      connected: 4,
      nonConnected: 1,
      stale: true,
    }
    const w = mount(CoverageMarker, { props: { coverage: stale } })
    const marker = w.find('[data-testid="coverage-marker"]')
    expect(marker.attributes('data-known')).toBe('false')
    expect(marker.text()).not.toMatch(/\d+\s*of\s*\d+/)
    expect(marker.text().toLowerCase()).toContain('stale')
  })
})
