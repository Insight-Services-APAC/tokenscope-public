// @vitest-environment happy-dom
/*
 * InfoDot — the (i) carrier of the dashboard-prose ruling (developer pages
 * build D12; owner 2026-08-04, prototype `info()` :210-212): explanatory
 * prose opens on demand, the card body carries data.
 *
 * MUTATIONS these pin:
 *  - drop the focus/hover open → the open tests go red;
 *  - drop the Escape handler → the escape test goes red;
 *  - render the prose inline instead of behind the popover → the
 *    closed-by-default test goes red;
 *  - make `label` optional/unbound → the aria-label test goes red.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InfoDot from '../../../app/components/ui/InfoDot.vue'

const PROSE = 'Median and p90 are computed over the OTel arm only.'

function mountDot() {
  return mount(InfoDot, {
    props: { label: 'About session economics' },
    slots: { default: PROSE },
    attachTo: document.body,
  })
}

describe('InfoDot — closed by default, prose behind the popover', () => {
  it('renders a keyboard-reachable BUTTON with the required aria-label', () => {
    const w = mountDot()
    const trigger = w.find('[data-testid="info-dot-trigger"]')
    expect(trigger.element.tagName).toBe('BUTTON')
    expect(trigger.attributes('type')).toBe('button')
    expect(trigger.attributes('aria-label')).toBe('About session economics')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('the prose is NOT visible until the dot is engaged', () => {
    const w = mountDot()
    const pop = w.find('[data-testid="info-dot-popover"]')
    // v-show: in the DOM (real text in the a11y tree once open) but hidden.
    expect(pop.isVisible()).toBe(false)
  })
})

describe('InfoDot — opens on hover and on focus (prototype :141-143)', () => {
  it('mouseenter opens, mouseleave closes', async () => {
    const w = mountDot()
    await w.find('[data-testid="info-dot"]').trigger('mouseenter')
    const pop = w.find('[data-testid="info-dot-popover"]')
    expect(pop.isVisible()).toBe(true)
    expect(pop.text()).toContain(PROSE)
    expect(w.find('[data-testid="info-dot-trigger"]').attributes('aria-expanded')).toBe('true')
    await w.find('[data-testid="info-dot"]').trigger('mouseleave')
    expect(pop.isVisible()).toBe(false)
  })

  it('focus opens (keyboard-reachable, no pointer needed)', async () => {
    const w = mountDot()
    await w.find('[data-testid="info-dot"]').trigger('focusin')
    expect(w.find('[data-testid="info-dot-popover"]').isVisible()).toBe(true)
  })

  it('focus leaving the component closes it', async () => {
    const w = mountDot()
    await w.find('[data-testid="info-dot"]').trigger('focusin')
    // relatedTarget outside the root (document.body) — focus genuinely left.
    await w.find('[data-testid="info-dot"]').trigger('focusout', { relatedTarget: document.body })
    expect(w.find('[data-testid="info-dot-popover"]').isVisible()).toBe(false)
  })
})

describe('InfoDot — Escape closes (D12 keyboard contract)', () => {
  it('Escape closes an open popover', async () => {
    const w = mountDot()
    await w.find('[data-testid="info-dot"]').trigger('focusin')
    expect(w.find('[data-testid="info-dot-popover"]').isVisible()).toBe(true)
    await w.find('[data-testid="info-dot"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-testid="info-dot-popover"]').isVisible()).toBe(false)
  })

  it('other keys do NOT close it', async () => {
    const w = mountDot()
    await w.find('[data-testid="info-dot"]').trigger('focusin')
    await w.find('[data-testid="info-dot"]').trigger('keydown', { key: 'Enter' })
    expect(w.find('[data-testid="info-dot-popover"]').isVisible()).toBe(true)
  })
})
