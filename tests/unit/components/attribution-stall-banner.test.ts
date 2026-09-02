// @vitest-environment happy-dom
/*
 * UiAttributionStallBanner — the §A6.2 degradation banner: shown iff the
 * server's attribution-stall signal rides the payload, hidden (auto-clearing)
 * on null/absent, and the message is the design's exact shape.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AttributionStallBanner from '../../../app/components/ui/AttributionStallBanner.vue'

const SINCE = '2026-08-19T09:41:00.000Z'

describe('UiAttributionStallBanner', () => {
  it('renders the design\'s message shape around the local-rendered instant', () => {
    const w = mount(AttributionStallBanner, { props: { stall: { since: SINCE } } })
    const banner = w.find('[data-testid="attribution-stall-banner"]')
    expect(banner.exists()).toBe(true)
    // The instant renders in the viewer's zone (clock-and-day-boundary.md), so
    // pin the frame around it rather than a zone-dependent literal.
    expect(banner.text()).toMatch(
      /^Attribution has not landed data since .+ — recent spend may be missing from these figures\.$/,
    )
    expect(banner.text()).toContain(new Date(SINCE).toLocaleString())
    // Announced to assistive tech without stealing focus.
    expect(banner.attributes('role')).toBe('status')
  })

  it('renders NOTHING on null — the banner auto-clears with the signal', () => {
    const w = mount(AttributionStallBanner, { props: { stall: null } })
    expect(w.find('[data-testid="attribution-stall-banner"]').exists()).toBe(false)
  })

  it('renders NOTHING when the prop is absent (a payload without the leg)', () => {
    const w = mount(AttributionStallBanner)
    expect(w.find('[data-testid="attribution-stall-banner"]').exists()).toBe(false)
  })
})
