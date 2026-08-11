// @vitest-environment happy-dom
/*
 * DateRangeControl — the calendar-period control for Across / Regional / Cost-centre.
 * Presets: This month · Last month · This quarter · Custom (no rolling day-windows).
 * Guards: "Last month" writes ?month (month mode, MoM eligible); "This quarter" writes
 * the quarter-to-date range; "Custom" OPENS the editor WITHOUT re-windowing (F8); the
 * span cap shows an inline message (L5). useReportState is a Nuxt auto-import (a bare
 * global at runtime), so we stub it.
 *
 * ── MIGRATED BY F1 (clock-rot-audit.md §F-a) ────────────────────────────────
 * This file used to re-implement `lastCompleteMonth` / `currentMonth` /
 * `quarterStart` BYTE-FOR-BYTE from the component, both reading `new Date()` —
 * a clock-derived test certifying a clock-derived control. Its own comment
 * ("Simulate the page left open past UTC midnight") records that the SUBJECT is
 * clock drift, which is precisely the thing a clock-derived expectation cannot
 * pin.
 *
 * The clock is now stubbed at a fixed instant, so the expected months are
 * literals and the assertions state figures rather than tautologies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import DateRangeControl from '../../../app/components/reporting/DateRangeControl.vue'
import { stubServerClock } from '../../helpers/server-clock'

function makeRs() {
  return { month: ref<string | null>(null), from: ref<string | null>(null), to: ref<string | null>(null), patch: vi.fn() }
}
let rs: ReturnType<typeof makeRs>
let clock: ReturnType<typeof stubServerClock>

/*
 * A pinned server clock: 15 August 2026, mid-month and mid-quarter, so every
 * preset below is unambiguous and none of them expires.
 *   today          2026-08-15   (still filling)
 *   settledThrough 2026-08-14   (the last complete day)
 */
const TODAY = '2026-08-15'
const SETTLED = '2026-08-14'
const LAST_COMPLETE_MONTH = '2026-07'
const CURRENT_MONTH = '2026-08'
const QUARTER_START = '2026-07-01'

beforeEach(() => {
  rs = makeRs()
  vi.stubGlobal('useReportState', () => rs)
  clock = stubServerClock(`${TODAY}T09:14:00Z`)
})

describe('DateRangeControl', () => {
  it('clicking "Custom" OPENS the editor without re-windowing the report (F8)', async () => {
    const w = mount(DateRangeControl)
    expect(w.find('[data-testid="date-range-editor"]').exists()).toBe(false)
    await w.find('[data-testid="date-range-custom"]').trigger('click')
    expect(w.find('[data-testid="date-range-editor"]').exists()).toBe(true)
    expect(rs.patch).not.toHaveBeenCalled()
  })

  it('"This month" clears month + range in one patch (→ the scope default)', async () => {
    rs.month.value = '2026-05'
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-month"]').trigger('click')
    expect(rs.patch).toHaveBeenCalledWith({ month: null, from: null, to: null })
  })

  it('"Last month" selects the last COMPLETE month via ?month (so MoM still works)', async () => {
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-lastMonth"]').trigger('click')
    expect(rs.patch).toHaveBeenCalledWith({ month: LAST_COMPLETE_MONTH, from: null, to: null })
    // month mode (no range) → the scope keeps forecast/MoM eligibility.
    const arg = rs.patch.mock.calls[0]![0] as { month: string }
    expect(arg.month).toMatch(/^\d{4}-\d{2}$/)
  })

  it('"This quarter" runs to the SETTLED edge, not to today, clearing ?month', async () => {
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-quarter"]').trigger('click')
    expect(rs.patch).toHaveBeenCalledTimes(1)
    expect(rs.patch).toHaveBeenCalledWith({ month: null, from: QUARTER_START, to: SETTLED })
    // The distinction F1 exists for: a quarter-to-date window that ran to TODAY
    // would ask the report for a day the pollers have not finished covering, and
    // its final point would come back padded to zero.
    const arg = rs.patch.mock.calls[0]![0] as { to: string }
    expect(arg.to).not.toBe(TODAY)
  })

  it('BEFORE the clock lands, the date-bearing presets refuse rather than guess', async () => {
    // The whole defect in one assertion: a control that answers "what month is
    // it" on its own can request and LABEL a period the server is not serving.
    clock = stubServerClock(null)
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-lastMonth"]').trigger('click')
    await w.find('[data-testid="date-range-quarter"]').trigger('click')
    expect(rs.patch).not.toHaveBeenCalled()
    expect(w.find('[data-testid="date-range-lastMonth"]').attributes('disabled')).toBeDefined()
  })

  it('the presets come alive when the clock lands, with the server\'s months', async () => {
    clock = stubServerClock(null)
    const w = mount(DateRangeControl)
    clock.value.value = { now: `${TODAY}T09:14:00Z`, today: TODAY, settledThrough: SETTLED }
    await w.vm.$nextTick()
    await w.find('[data-testid="date-range-lastMonth"]').trigger('click')
    expect(rs.patch).toHaveBeenCalledWith({ month: LAST_COMPLETE_MONTH, from: null, to: null })
  })

  it('an over-cap custom span shows an inline error and does not patch (L5)', async () => {
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-custom"]').trigger('click')
    await w.find('[data-testid="date-range-from"]').setValue('2000-01-01')
    await w.find('[data-testid="date-range-to"]').setValue('2100-01-01')
    expect(w.find('[data-testid="date-range-invalid"]').exists()).toBe(true)
    expect(w.find('[data-testid="date-range-invalid"]').text()).toMatch(/at most 400 days/)
    expect(rs.patch).not.toHaveBeenCalled()
  })

  it('a valid custom range applies from/to and clears ?month', async () => {
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-custom"]').trigger('click')
    await w.find('[data-testid="date-range-from"]').setValue('2026-06-01')
    await w.find('[data-testid="date-range-to"]').setValue('2026-06-15')
    expect(rs.patch).toHaveBeenCalledWith({ from: '2026-06-01', to: '2026-06-15', month: null })
  })

  it('a `?month=<current month>` deep-link reads as "This month" — no editor auto-open (#6)', () => {
    rs.month.value = CURRENT_MONTH
    const w = mount(DateRangeControl)
    // "This month" is the active pill; the custom editor is NOT auto-opened (it used to
    // classify ?month=current as 'custom' and open the editor seeded with a 30-day range).
    expect(w.find('[data-testid="date-range-month"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="date-range-custom"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-testid="date-range-editor"]').exists()).toBe(false)
  })

  it('"This quarter" pill stays active when stored `to` is not today — from-only match (#8)', () => {
    // Simulate the page left open past UTC midnight: `from` still equals the quarter start
    // but the stored `to` is a stale earlier day (no longer the edge). The pill must stay lit.
    rs.from.value = QUARTER_START
    rs.to.value = '2000-06-15' // a stale `to`, deliberately != today
    const w = mount(DateRangeControl)
    expect(w.find('[data-testid="date-range-quarter"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="date-range-custom"]').attributes('aria-pressed')).toBe('false')
  })
})
