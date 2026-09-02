// @vitest-environment happy-dom
/*
 * UiFreshness — the dot obeys the ONE thresholds module and the fabricated
 * default is DEAD (ops-alerting §A6.1).
 *
 * MUTATIONS these pin (each verified red before landing):
 *  - restore the old `withDefaults(..., { minutes: 12 })` → the no-prop test
 *    goes red (a green dot and "Updated 12 min ago" appear from nothing);
 *  - hardcode the dot green → the aging/stale/unknown tests go red;
 *  - swap a threshold bound → the tier tests go red (bounds themselves are
 *    pinned in tests/unit/shared/freshness-tier.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Freshness from '../../../app/components/ui/Freshness.vue'

function dot(w: ReturnType<typeof mount>) {
  return w.find('[data-testid="freshness-dot"]')
}

describe('UiFreshness — tier colours from the shared module', () => {
  it('fresh (≤ 60 min): green dot, "Updated N min ago"', () => {
    const w = mount(Freshness, { props: { minutes: 12 } })
    expect(dot(w).classes()).toContain('bg-rag-green')
    expect(w.text()).toBe('Updated 12 min ago')
  })

  it('aging (≤ 6 h): amber dot', () => {
    const w = mount(Freshness, { props: { minutes: 120 } })
    expect(dot(w).classes()).toContain('bg-rag-amber')
    expect(dot(w).classes()).not.toContain('bg-rag-green')
    expect(w.text()).toBe('Updated 120 min ago')
  })

  it('stale (> 6 h): red dot', () => {
    const w = mount(Freshness, { props: { minutes: 500 } })
    expect(dot(w).classes()).toContain('bg-rag-red')
    expect(dot(w).classes()).not.toContain('bg-rag-green')
  })

  it('the tier boundary is the shared module\'s (60 green, 61 amber)', () => {
    expect(dot(mount(Freshness, { props: { minutes: 60 } })).classes()).toContain('bg-rag-green')
    expect(dot(mount(Freshness, { props: { minutes: 61 } })).classes()).toContain('bg-rag-amber')
  })
})

describe('UiFreshness — the unknown state (§A6.1: absent is NEVER green)', () => {
  it('NO minutes prop: neutral dot + "freshness unknown" — the minutes:12 default is dead', () => {
    const w = mount(Freshness)
    expect(w.text()).toBe('freshness unknown')
    expect(w.text()).not.toContain('Updated')
    expect(dot(w).classes()).toContain('bg-cloud')
    expect(dot(w).classes()).not.toContain('bg-rag-green')
  })

  it('minutes: null renders the same honest unknown', () => {
    const w = mount(Freshness, { props: { minutes: null } })
    expect(w.text()).toBe('freshness unknown')
    expect(dot(w).classes()).toContain('bg-cloud')
    expect(dot(w).classes()).not.toContain('bg-rag-green')
  })

  it('minutes: 0 IS a value — green, not unknown (a just-landed event)', () => {
    const w = mount(Freshness, { props: { minutes: 0 } })
    expect(w.text()).toBe('Updated 0 min ago')
    expect(dot(w).classes()).toContain('bg-rag-green')
  })
})
