// @vitest-environment happy-dom
/*
 * ReportBand — the header that says which window a group of cards answers over.
 *
 * The component holds no figure and computes nothing, so there is exactly one
 * thing it can get wrong and one thing it must never do: it must render the
 * strings it was handed, and it must not render a note that was not handed to it
 * (the rolling band's "does not sum into July" is FALSE whenever the two bands
 * share a window, so an always-on note would be a lie in range mode).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ReportBand from '../../../app/components/reporting/ReportBand.vue'

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

describe('ReportBand', () => {
  it('states the window and the basis, and wraps its cards', () => {
    const w = mount(ReportBand, {
      props: { windowLabel: 'Last 60 days', basis: 'rolling · daily', note: 'does not sum into July' },
      slots: { default: '<p data-testid="child">a card</p>' },
    })
    expect(norm(w.find('[data-testid="report-band-window"]').text())).toBe('Last 60 days')
    expect(norm(w.find('[data-testid="report-band-basis"]').text())).toBe('rolling · daily')
    expect(norm(w.find('[data-testid="report-band-note"]').text())).toBe('does not sum into July')
    expect(w.find('[data-testid="child"]').exists()).toBe(true)
  })

  it('renders NO note when the caller passes none', () => {
    /*
     * The caller (band-labels.rollingBandNote) returns null in the two cases
     * where the sentence would be false — a custom range shared by both bands,
     * and an unparseable month. The component must be capable of showing nothing,
     * or that decision never reaches the screen.
     */
    const w = mount(ReportBand, {
      props: { windowLabel: 'July 2026', basis: 'attributed usage · APAC · month to date' },
    })
    expect(w.find('[data-testid="report-band-note"]').exists()).toBe(false)
    expect(norm(w.text())).not.toContain('does not sum into')
  })

  it('renders NO header at all when the caller passes no window label', () => {
    /*
     * The period band at the whole-company width passes none: its hero already
     * opens with "August 2026 · $5,741.89 · attributed usage · the whole company
     * · month to date · day 3 of 31", so a header above it stated the same
     * window one line earlier without the figure.
     *
     * The BAND must survive the header going — tests assert card membership
     * through its `data-testid`, and the slot content is the whole point.
     */
    const w = mount(ReportBand, { slots: { default: '<p data-testid="child">a card</p>' } })
    expect(w.find('[data-testid="report-band-window"]').exists()).toBe(false)
    expect(w.find('[data-testid="report-band-basis"]').exists()).toBe(false)
    expect(w.find('[data-testid="report-band-note"]').exists()).toBe(false)
    expect(w.find('[data-testid="child"]').exists()).toBe(true)
  })

  it('a basis or note without a window label renders nothing — never a headerless caveat', () => {
    // The basis and the note only mean anything under the window they qualify.
    // Rendering them alone would leave a floating "rolling · daily" over cards
    // with no stated window, which is worse than the duplication being removed.
    const w = mount(ReportBand, { props: { basis: 'rolling · daily', note: 'does not sum into July' } })
    expect(w.find('[data-testid="report-band-basis"]').exists()).toBe(false)
    expect(w.find('[data-testid="report-band-note"]').exists()).toBe(false)
  })

  it('publishes no money figure of its own', () => {
    /*
     * The prototype's band header carries a total; ours deliberately does not.
     * The hero INSIDE the period band already publishes it, and one fact gets one
     * home — a second copy in the chrome is a second thing to keep in step.
     * There is no prop through which a caller could add one.
     */
    const w = mount(ReportBand, {
      props: { windowLabel: 'July 2026', basis: 'attributed usage · APAC · month to date' },
    })
    expect(w.text()).not.toMatch(/\$/)
  })
})
