// @vitest-environment happy-dom
/*
 * F2 — the hero tiles (S3, S4). T7–T13.
 *
 * Every figure appears once, and the row reads as designed at every width. What
 * each block pins, and the revert that turns it red, is stated on the describe.
 *
 *  T7  the spark spans the month, ON DAY 1 — the case the old parity gate never
 *      captured, because it only ever shot 1600px mid-month.
 *  T8  one grid rule, three files, no breakpoint.
 *  T9  the stretch dead space: the spark slot is reserved and does not bottom-pin.
 *  T10 the sub-badge register the pace pill moved into.
 *  T12 the stacked chart's height is CSS pixels, not a viewBox ratio.
 *  T13 a reason-typed remainder stays in the bars and leaves the legend.
 *
 * (T10's placement and T11's single-delta contract are asserted on the page
 * itself, in project-hero-presentation.test.ts — the pill and the delta are the
 * page's decisions; this file pins the affordances they use.)
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import MonthSpark from '../../../app/components/charts/MonthSpark.vue'
import ScopeKpiTile from '../../../app/components/reporting/ScopeKpiTile.vue'
import StackedBars from '../../../app/components/charts/StackedBars.vue'

/*
 * The x-extent assertions are RELATIVE to the viewBox, read off the rendered
 * svg rather than pinned to MonthSpark's `VB_W`. They used to hardcode 100, so
 * widening the viewBox — which is what stopped the spark scaling non-uniformly
 * and drawing its endpoint as an ellipse — broke two tests that were not about
 * the constant at all. The invariant is "4 days into a 30-day month", whatever
 * the viewBox happens to be.
 */
function vbWidth(w: { find: (s: string) => { attributes: (a: string) => string | undefined } }): number {
  return Number(w.find('[data-testid="month-spark"]').attributes('viewBox')!.split(' ')[2])
}


const ROOT = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

// ── T7 · the spark spans the whole month, always ─────────────────────────────
/*
 * REVERT: reinstate any floor (the shipped `SPARK_MIN_DAYS = 7`, or the
 * prototype's old `< 3`) and the day-1 case draws nothing — every assertion in
 * this block that counts a mark goes red.
 */
describe('MonthSpark — no floor, and the frame is the month (T7)', () => {
  it('DAY 1: one point and thirty dots, never prose', () => {
    const w = mount(MonthSpark, { props: { data: [12.5], span: 31, partial: true } })
    expect(w.findAll('[data-testid="month-spark-dot"]')).toHaveLength(30)
    expect(w.find('[data-testid="month-spark-endpoint"]').exists()).toBe(true)
    expect(w.text()).toBe('')
  })

  it('day 5 of 31: a short line, and twenty-six days still ahead', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3, 4, 5], span: 31 } })
    expect(w.findAll('[data-testid="month-spark-dot"]')).toHaveLength(26)
    expect(w.find('[data-testid="month-spark-line"]').attributes('points')!.split(' ')).toHaveLength(5)
  })

  /*
   * THE DEFECT THIS FILE MISSED. Every assertion above either omits `partial` or
   * checks the endpoint's position, so nothing pinned what the LINE does with a
   * still-filling day — and the line ran straight through it, plunging to the
   * floor each UTC morning while the hero chart on the same page did not.
   * Clock doc D4: the partial day is excluded from trend lines. The endpoint
   * still marks it, detached, which is what "still accruing" should look like.
   *
   * REVERT: map all of `props.data` into `points` and both cases below go red.
   */
  it('a still-filling day is NOT in the line — it is the detached endpoint', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3, 4, 5], span: 31, partial: true } })
    const pts = w.find('[data-testid="month-spark-line"]').attributes('points')!.trim().split(' ')
    expect(pts).toHaveLength(4)
    // …and the endpoint sits where the fifth day is, so nothing is hidden.
    expect(Number(w.find('[data-testid="month-spark-endpoint"]').attributes('cx')))
      .toBeCloseTo((4 / 30) * vbWidth(w), 1)
  })

  it('a SETTLED last day stays in the line', () => {
    const w = mount(MonthSpark, { props: { data: [1, 2, 3, 4, 5], span: 31, partial: false } })
    expect(w.find('[data-testid="month-spark-line"]').attributes('points')!.trim().split(' '))
      .toHaveLength(5)
  })

  it('the x-extent is the MONTH, so a row of tiles shares one time axis', () => {
    // Day 5 of 31: the fifth point sits at 4/30 of the width, NOT at the end.
    const w = mount(MonthSpark, { props: { data: [1, 2, 3, 4, 5], span: 31, partial: true } })
    const lastX = Number(w.find('[data-testid="month-spark-endpoint"]').attributes('cx'))
    expect(lastX).toBeCloseTo((4 / 30) * vbWidth(w), 1)
    // The last DOT closes the month at the right-hand edge.
    const dots = w.findAll('[data-testid="month-spark-dot"]')
    expect(Number(dots[dots.length - 1]!.attributes('cx'))).toBeCloseTo(vbWidth(w), 1)
  })

  it('the last point is HOLLOW when the CALLER says today is still filling', () => {
    const end = mount(MonthSpark, { props: { data: [1, 2, 3], span: 31, partial: true } }).find(
      '[data-testid="month-spark-endpoint"]',
    )
    expect(end.attributes('fill')).toBe('var(--paper)')
    expect(end.attributes('stroke')).toBeTruthy()
  })

  it('a completed month, and a range with no month ahead, draw NO dots', () => {
    const full = mount(MonthSpark, { props: { data: [1, 2, 3], span: 3 } })
    expect(full.findAll('[data-testid="month-spark-dot"]')).toHaveLength(0)
    const range = mount(MonthSpark, { props: { data: [1, 2, 3] } })
    expect(range.findAll('[data-testid="month-spark-dot"]')).toHaveLength(0)
  })

  /*
   * The two honesty rules the retired ECharts sparkline carried, moved here with
   * the drawing. REVERT either (spline the line; range the y-axis to the data's
   * own min) and one of these goes red.
   */
  it('draws STRAIGHT segments between real points — no invented shape', () => {
    const w = mount(MonthSpark, { props: { data: [1, 9, 2], span: 31 } })
    expect(w.find('[data-testid="month-spark-line"]').exists()).toBe(true)
    // A polyline has no curve commands at all; a path would.
    expect(w.html()).not.toContain('<path')
  })

  it('has a ZERO baseline, so the drawn height means something', () => {
    // A flat non-zero series must NOT fill the box: with a zero floor its line
    // sits at the top only because the peak IS the value, and a 0 lands on the
    // baseline — the same y the "still to come" dots use.
    const w = mount(MonthSpark, { props: { data: [0, 5], span: 4 } })
    const pts = w.find('[data-testid="month-spark-line"]').attributes('points')!.split(' ')
    expect(pts[0]!.split(',')[1]).toBe('26.0') // 0 → the baseline
    expect(pts[1]!.split(',')[1]).toBe('2.0') // the peak → the top
    expect(w.find('[data-testid="month-spark-dot"]').attributes('cy')).toBe('26')
  })
})

// ── T8 · one grid rule, three files, no breakpoint ───────────────────────────
/*
 * A STATIC gate, because this defect is invisible to a jsdom mount: happy-dom
 * applies no stylesheet, so a breakpoint ladder and an auto-fit render
 * identically in a test and differently in the owner's browser. That asymmetry
 * is exactly how S3 shipped — and why the parity capture at 1600px, above every
 * breakpoint, could not tell the fix from the bug either.
 *
 * REVERT: put `md:grid-cols-2 xl:grid-cols-4` back on any of the three rows, or
 * add a media query to `.kpi-row`, and this goes red.
 */
describe('the hero rows share ONE grid rule and have no breakpoint (T8)', () => {
  const ROWS = [
    'app/components/reporting/ScopeHero.vue',
    'app/components/me/MeHeroTiles.vue',
    'app/pages/projects/[code].vue',
  ] as const

  it.each(ROWS)('%s uses the shared .kpi-row', (rel) => {
    expect(read(rel)).toContain('class="kpi-row"')
  })

  /*
   * A four-up behind a breakpoint IS the bug: `xl` is 1280px, so every window
   * narrower than that silently got a different layout. Scoped to `-4` because
   * these files carry other, legitimate two-up rows (the cards below the hero).
   */
  it.each(ROWS)('%s seats no four-up behind a breakpoint', (rel) => {
    const hits = read(rel).match(/\b(?:sm|md|lg|xl|2xl):grid-cols-4/g) ?? []
    expect({ file: rel, hits }).toEqual({ file: rel, hits: [] })
  })

  it('the rule is defined ONCE, auto-fits, and carries no media query', () => {
    const css = read('app/assets/css/main.css')
    expect(css.match(/^\.kpi-row\s*\{/gm)).toHaveLength(1)
    const rule = css.slice(css.indexOf('.kpi-row {'), css.indexOf('}', css.indexOf('.kpi-row {')))
    expect(rule).toContain('repeat(auto-fit, minmax(168px, 1fr))')
    expect(rule).not.toContain('@media')
  })
})

// ── T9 / T10 · the tile's own affordances ────────────────────────────────────
/*
 * REVERT: put `mt-auto` back on the spark slot (the spark bottom-pins again and
 * the dead space returns), or drop the reserved slot (a spark-less row goes
 * ragged), or move the sub-badge back beside the label — one of these goes red.
 */
describe('ScopeKpiTile — the spark slot and the sub-badge (T9, T10)', () => {
  const base = { label: 'Spend vs budget', value: '$400.00' }

  it('does NOT bottom-pin the spark — that gap WAS the dead space (D9)', () => {
    const w = mount(ScopeKpiTile, { props: { ...base, spark: [1, 2, 3], sparkSpan: 31 } })
    const slot = w.find('[data-testid="month-spark"]').element.parentElement!
    expect(slot.className).not.toContain('mt-auto')
  })

  it('reserves the slot even with NO days in it, so the row keeps one shape', () => {
    const w = mount(ScopeKpiTile, { props: { ...base, spark: [], sparkSpan: 31 } })
    expect(w.find('[data-testid="month-spark"]').exists()).toBe(true)
    expect(w.find('[data-testid="month-spark-endpoint"]').exists()).toBe(false)
    expect(w.text()).not.toContain('not enough days yet')
  })

  it('stays SILENT for a tile that was never meant to carry one', () => {
    const w = mount(ScopeKpiTile, { props: base })
    expect(w.find('[data-testid="month-spark"]').exists()).toBe(false)
  })

  it('renders the sub-badge INSIDE the sub line, not beside the label (D10)', () => {
    const w = mount(ScopeKpiTile, {
      props: { ...base, sub: '40% of $1,000.00' },
      slots: { 'sub-badge': '<span data-testid="pill">Healthy</span>' },
    })
    const pill = w.find('[data-testid="pill"]').element
    expect(pill.parentElement!.textContent).toContain('40% of $1,000.00')
    // …and the label row is a sibling of that line, never its parent.
    expect(pill.parentElement!.textContent).not.toContain('Spend vs budget')
  })
})

// ── T12 / T13 · the stacked chart ────────────────────────────────────────────
const BURN_ROWS = [
  { day: '2026-08-01', key: 'claude-fable-5', value: 40 },
  { day: '2026-08-02', key: 'claude-fable-5', value: 60 },
  { day: '2026-08-02', key: 'Copilot day-grain money', value: 25 },
]
const mountBars = (props: Record<string, unknown> = {}) =>
  mount(StackedBars, {
    props: {
      rows: BURN_ROWS,
      keyOrder: ['claude-fable-5', 'Copilot day-grain money'],
      windowDays: 2,
      endDay: '2026-08-02',
      ...props,
    },
  })

/*
 * REVERT: drop the explicit CSS height (or `preserveAspectRatio="none"`) and the
 * SVG goes back to being sized by `containerWidth × height/720` — a `height`
 * prop that is really an aspect ratio, which drew Daily burn at roughly twice
 * the prototype's 150px on the project page and by a different amount at every
 * other width.
 */
describe('ChartsStackedBars — height is CSS pixels, not a viewBox ratio (T12)', () => {
  it('takes its height in px and stretches horizontally', () => {
    const svg = mountBars({ height: 150 }).find('svg')
    expect(svg.attributes('style')).toContain('height: 150px')
    expect(svg.attributes('preserveAspectRatio')).toBe('none')
    expect(svg.attributes('viewBox')).toBe('0 0 720 150')
  })

  it('holds no TEXT inside the stretched box — the day labels are HTML', () => {
    const w = mountBars({ height: 150 })
    expect(w.find('svg').html()).not.toContain('<text')
    const labels = w.find('[data-testid="stacked-bars-x-labels"]')
    expect(labels.exists()).toBe(true)
    expect(labels.text()).toContain('08-01')
  })
})

/*
 * REVERT: pass no `remainderKeys` and "Copilot day-grain money" reappears in the
 * model legend with a dot beside "claude-fable-5", where it reads as a model
 * name. The conservation half of this block is the guard on the fix: the money
 * must stay in the bars.
 */
describe('ChartsStackedBars — a reason-typed remainder leaves the legend (T13)', () => {
  const remainder = { remainderKeys: ['Copilot day-grain money'] }

  it('names only real categories in the legend', () => {
    const legend = mountBars(remainder).findAll('.text-\\[10px\\]').map((n) => n.text())
    expect(legend.some((t) => t.includes('claude-fable-5'))).toBe(true)
    const w = mountBars(remainder)
    const note = w.find('[data-testid="stacked-bars-remainder-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Copilot day-grain money')
    expect(note.text()).toContain('$25.00')
  })

  it('KEEPS the money in the bars — it moved register, not lane', () => {
    const w = mountBars(remainder)
    const titles = w.findAll('title').map((n) => n.text())
    expect(titles.some((t) => t.includes('Copilot day-grain money') && t.includes('$25.00'))).toBe(true)
  })

  it('renders no remainder footer when there is nothing to name', () => {
    expect(mountBars().find('[data-testid="stacked-bars-remainder-note"]').exists()).toBe(false)
  })
})
