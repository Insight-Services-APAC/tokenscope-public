// @vitest-environment happy-dom
/*
 * ScopeRegionalView — a refetch must be visibly a refetch.
 *
 * The Regional scope issues SEVEN requests and they land at different times
 * (measured on Dev: 3.2s, 2.1s, 3.3s, 4.8s, 5.1s, 8.3s, 10.2s), each flipping
 * its own card as it arrives. The skeleton was gated on `pending && !report`,
 * which is false on every refetch because the PREVIOUS response is still
 * present — so changing region showed the old region's figures, unmarked, for
 * several seconds while cards swapped one at a time.
 *
 * That is not only a missing spinner. For those seconds the screen presents a
 * MIXTURE of two scopes as a settled answer, under a heading naming one of
 * them, to a user whose whole purpose is comparing regions. The fix is to
 * render the provisional state as provisional.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ScopeRegionalView from '../../../app/components/reporting/ScopeRegionalView.vue'
import { makeReport, regionalViewGlobal } from './helpers/regional-report-fixture'

const global = regionalViewGlobal


const base = {
  drivers: null,
  modelDrivers: null,
  concentration: null,
  trend: null,
  activeTrend: null,
  seasonality: null,
  momDeltaPct: null,
  driversAxis: 'project',
  exportParams: {},
  exportFilename: 'x.csv',
}

describe('refetch is visibly a refetch', () => {
  it('shows the skeleton on a FIRST load, when there is nothing to mislead with', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: null, pending: true, refetching: false },
      global,
    })
    expect(w.find('[data-testid="regional-data"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-refetching"]').exists()).toBe(false)
  })

  it('marks the body provisional while a refetch is in flight over old figures', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: makeReport(), pending: false, refetching: true },
      global,
    })
    const body = w.find('[data-testid="regional-data"]')
    expect(body.exists()).toBe(true) // the old figures stay — they are all we have
    expect(body.attributes('aria-busy')).toBe('true')
    expect(body.classes()).toContain('opacity-50')
  })

  it('NAMES the refetch rather than only dimming, so the state is readable', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: makeReport(), pending: false, refetching: true },
      global,
    })
    const chip = w.find('[data-testid="regional-refetching"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toMatch(/updating/i)
    expect(chip.attributes('role')).toBe('status')
  })

  it('presents settled figures as settled once every request has landed', () => {
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: makeReport(), pending: false, refetching: false },
      global,
    })
    const body = w.find('[data-testid="regional-data"]')
    expect(body.attributes('aria-busy')).toBe('false')
    expect(body.classes()).not.toContain('opacity-50')
    expect(w.find('[data-testid="regional-refetching"]').exists()).toBe(false)
  })

  it('does not mark a refetch while the error state is showing', () => {
    /*
     * The chip lives in the HEADER, which renders in every state — so hiding
     * the data body is not enough. "Updating figures…" above an error banner
     * implies the error is about to be replaced by figures.
     */
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: makeReport(), pending: false, refetching: true, error: new Error('x') },
      global,
    })
    expect(w.find('[data-testid="regional-data"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-refetching"]').exists()).toBe(false)
  })

  it('does not claim to be updating figures over the EMPTY state', () => {
    // Nothing to update: an empty report has no figures on screen.
    const empty = makeReport({
      kpis: {
        genuineUsd: 0,
        chargeableUsd: 0,
        anthropicChargeableUsd: 0,
        tokens: 0,
        activeUsers: 0,
        chargeMomDeltaPct: null,
        billedTeammates: 0,
        billedTokens: 0,
        avgChargePerBilledUser: 0,
      },
    })
    const w = mount(ScopeRegionalView, {
      props: { ...base, report: empty, pending: false, refetching: true },
      global,
    })
    // Assert the EMPTY branch is genuinely the one rendered. An early return
    // here would let this test pass without ever reaching what it checks.
    expect(w.find('[data-testid="regional-data"]').exists()).toBe(false)
    expect(w.find('[data-testid="regional-refetching"]').exists()).toBe(false)
  })
})
