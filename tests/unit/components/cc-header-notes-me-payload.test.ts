// @vitest-environment happy-dom
/*
 * CcHeaderNotes against ME-PAYLOAD operands — T12 (developer pages build D14).
 *
 * D14 reuses CcHeaderNotes AS-IS on `/usage` and `/projects/[code]`, fed by the
 * D11 payload legs (`providerStates` from `providerStatesForWindow`, `coverage`
 * from `reportCoverageMeta`) instead of re-derived freshness prose. This file
 * pins the chip row against operands in exactly the me-payload shape, so the
 * W2/W3 mounts have a contract to land on and a me-specific FORK of the
 * component can never look necessary:
 *
 *  - mixed provider states → ONE least-settled word;
 *  - all settled → NO chip at all;
 *  - the coverage chip renders INDEPENDENTLY of the settlement word.
 *
 * MUTATIONS these pin:
 *  - forking the component for me pages (different testids/props) → every
 *    find() here goes red;
 *  - aggregate rule → first provider's state: the mixed test goes red (the
 *    payload's FIRST provider is 'settling'; the chip must read 'Estimated');
 *  - folding coverage into the settlement word → the independence test goes red.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CcHeaderNotes from '../../../app/components/reporting/cost-centre/CcHeaderNotes.vue'
import type { ProviderState, ReportCoverageMeta } from '#shared/reports/types'

/**
 * The D11 payload legs as `/me/usage` / `/me/projects/{code}` will carry them:
 * `providerStates` (providerStatesForWindow) + `coverage` (reportCoverageMeta).
 * ORDER IS LOAD-BEARING: the first provider is 'settling', the second
 * 'estimated' — only the least-settled ladder prints 'Estimated'.
 */
const mePayloadMeta: { providerStates: ProviderState[]; coverage: ReportCoverageMeta } = {
  providerStates: [
    { vendor: 'anthropic', state: 'settling', settlesAt: '2026-08-30' },
    { vendor: 'usage', state: 'estimated' },
  ] as ProviderState[],
  coverage: { applicable: true, denominator: null, connected: 2, nonConnected: 0, stale: false },
}

const mePayloadSettled: ProviderState[] = [
  { vendor: 'anthropic', state: 'settled', settlesAt: '2026-06-30' },
  { vendor: 'github', state: 'settled', settlesAt: '2026-07-04' },
  { vendor: 'usage', state: 'settled', settlesAt: '2026-07-04' },
] as ProviderState[]

describe('CcHeaderNotes on me payloads — one least-settled word (T12)', () => {
  it('mixed provider states → exactly ONE chip, on the least-settled state', () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: mePayloadMeta.providerStates, coverage: mePayloadMeta.coverage },
    })
    const triggers = w.findAll('[data-testid="cc-header-notes-trigger"]')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]!.text()).toBe('Estimated')
  })

  it("the popover lists each provider's OWN clock — the me chip row loses no information", () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: mePayloadMeta.providerStates },
    })
    const panel = w.find('[data-testid="cc-header-notes-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.find('[data-testid="cc-notes-settling-anthropic"]').text()).toContain('Settling')
    expect(panel.find('[data-testid="cc-notes-settling-usage"]').text()).toContain('Estimated')
  })

  it('ALL settled → no settlement chip at all (nothing left to caveat)', () => {
    const w = mount(CcHeaderNotes, { props: { providerStates: mePayloadSettled } })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
    expect(w.find('[data-testid="cc-header-notes-trigger"]').exists()).toBe(false)
  })
})

describe('CcHeaderNotes on me payloads — the coverage chip is independent (T12)', () => {
  it('renders the coverage chip even when every settlement clock has settled', () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: mePayloadSettled, coverage: mePayloadMeta.coverage },
    })
    expect(w.find('[data-testid="cc-header-notes"]').exists()).toBe(false)
    expect(w.find('[data-testid="coverage-marker"]').text()).toContain('Coverage unknown')
  })

  it('no coverage leg (older cached payload) → no coverage chip, no crash', () => {
    const w = mount(CcHeaderNotes, {
      props: { providerStates: mePayloadMeta.providerStates, coverage: null },
    })
    expect(w.find('[data-testid="cc-header-notes-trigger"]').text()).toBe('Estimated')
    expect(w.find('[data-testid="coverage-marker"]').exists()).toBe(false)
  })
})
