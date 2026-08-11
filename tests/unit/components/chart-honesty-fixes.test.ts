// @vitest-environment happy-dom
/*
 * THE EXTERNAL-REVIEW FIX PASS — the three chart primitives, one defect class:
 * a drawing asserting something the numbers behind it do not support.
 *
 *   - `StackedBars` treated `keyOrder` as a FILTER, so a key present in the rows
 *     but absent from the caller's ordering lost its band with nothing on screen
 *     saying so. Money silently out of a money chart.
 *   - `MonthSpark` drew its endpoint hollow — the shared "still accruing" mark —
 *     UNCONDITIONALLY, so a finished month got a partial marker on a settled day.
 *   - `TrendArea`'s comment claimed the partial day could not pull the axis
 *     maximum. It could, and it should: a scale that excludes a drawn mark draws
 *     it off the canvas. The comment was the thing that was wrong; this pins the
 *     behaviour so the two cannot drift apart again.
 *
 * Each `it` names the revert that turns it red.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StackedBars from '../../../app/components/charts/StackedBars.vue'
import TrendArea from '../../../app/components/charts/TrendArea.vue'
import MonthSpark from '../../../app/components/charts/MonthSpark.vue'

const END = '2026-08-10'

describe('StackedBars — keyOrder RANKS the bands, it does not decide which exist', () => {
  /*
   * RED ON REVERT: restore `if (props.keyOrder?.length) return props.keyOrder`
   * in `keys` and the unnamed key's segment disappears, taking its $9.00 with it.
   */
  it('draws a key the rows carry but keyOrder never named', () => {
    const w = mount(StackedBars, {
      props: {
        rows: [
          { day: END, key: 'opus-5', value: 4 },
          // Present in the series, absent from the caller's order — the project
          // page's real case: a model inside the TRAILING burn window that did
          // not run inside the PAGE window the order was built from.
          { day: END, key: 'sonnet-5', value: 9 },
        ],
        keyOrder: ['opus-5'],
        windowDays: 7,
        endDay: END,
      },
    })
    const titles = w.findAll('title').map((t) => t.text())
    expect(titles.some((t) => t.includes('$9.00'))).toBe(true)
    expect(titles.some((t) => t.includes('$4.00'))).toBe(true)
  })

  it('keeps the named keys FIRST — it is still an ordering', () => {
    const w = mount(StackedBars, {
      props: {
        rows: [
          { day: END, key: 'late', value: 1 },
          { day: END, key: 'ranked', value: 1 },
        ],
        keyOrder: ['ranked'],
        windowDays: 7,
        endDay: END,
      },
    })
    // Segments are emitted in key order, so the named key's tooltip comes first.
    const titles = w.findAll('title').map((t) => t.text())
    expect(titles[0]).toContain('ranked')
    expect(titles[1]).toContain('late')
  })
})

describe('MonthSpark — the endpoint marker is the CALLER\'s claim, never the frame\'s', () => {
  /*
   * RED ON REVERT (r2): restore `props.partial ?? span > n` and the two
   * unstated cases below start asserting a day state again — the second one
   * ("days left in the month") drawing the still-accruing mark on a series that
   * ended at the settled edge, which is the defect. Hardwiring
   * `fill="var(--paper)"` back on breaks the stated-`false` case too.
   */
  it('a stated `false` draws a SOLID endpoint — the series ends on a finished day', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3], span: 3, partial: false } })
    const end = w.find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('false')
    expect(end.attributes('fill')).not.toBe('var(--paper)')
  })

  it('a stated `true` draws the HOLLOW endpoint — the fix removes no honest marker', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3], span: 31, partial: true } })
    const end = w.find('[data-testid="month-spark-endpoint"]')
    expect(end.attributes('data-partial')).toBe('true')
    expect(end.attributes('fill')).toBe('var(--paper)')
  })

  it('UNSTATED draws NO endpoint marker — with days left in the month, the frame used to guess "partial"', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3], span: 31 } })
    expect(w.find('[data-testid="month-spark-endpoint"]').exists()).toBe(false)
    // The line itself is untouched — only the CLAIM about its last day is withheld.
    expect(w.find('[data-testid="month-spark-line"]').exists()).toBe(true)
  })

  it('UNSTATED draws no marker on a complete frame either — silence, not a guess', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3], span: 3 } })
    expect(w.find('[data-testid="month-spark-endpoint"]').exists()).toBe(false)
  })
})

describe('TrendArea — the axis covers EVERYTHING it draws, partial day included', () => {
  /*
   * RED ON REVERT: drop `partial.value?.value ?? 0` from `max` and the partial
   * marker's `cy` goes NEGATIVE — drawn above the plot box, i.e. off the chart.
   * (That is the state the old comment described as the intended one.)
   */
  it('a partial day larger than every settled day still lands INSIDE the box', () => {
    const w = mount(TrendArea, {
      props: {
        series: [
          { day: '2026-08-09', cost_usd: '10.00' },
          { day: '2026-08-10', cost_usd: '400.00' },
        ],
        windowDays: 7,
        endDay: '2026-08-09',
        partialDay: '2026-08-10',
        height: 160,
      },
    })
    const marker = w.find('[data-testid="trend-area-partial"]')
    expect(marker.exists()).toBe(true)
    /*
     * The marker is a vertical TICK now, not a circle — the circle rendered as a
     * stretched ellipse under the SVG's non-uniform scale. Same invariant, read
     * off the tick's own extent: both ends must sit inside the viewBox, so a
     * partial day above every settled day cannot escape the plot.
     */
    const tick = marker.find('line')
    const y1 = Number(tick.attributes('y1'))
    const y2 = Number(tick.attributes('y2'))
    expect(y1).toBeGreaterThanOrEqual(0)
    expect(y2).toBeLessThanOrEqual(160)
  })
})
