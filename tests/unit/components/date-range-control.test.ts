// @vitest-environment happy-dom
/*
 * DateRangeControl — the calendar-period control for Across / Regional / Cost-centre.
 * Presets: This month · Last month · This quarter · Custom (no rolling day-windows).
 * Guards: "Last month" writes ?month (month mode, MoM eligible); "This quarter" writes
 * the quarter-to-date range; "Custom" OPENS the editor WITHOUT re-windowing (F8); the
 * span cap shows an inline message (L5). useReportState is a Nuxt auto-import (a bare
 * global at runtime), so we stub it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import DateRangeControl from '../../../app/components/reporting/DateRangeControl.vue'

function makeRs() {
  return { month: ref<string | null>(null), from: ref<string | null>(null), to: ref<string | null>(null), patch: vi.fn() }
}
let rs: ReturnType<typeof makeRs>
beforeEach(() => {
  rs = makeRs()
  vi.stubGlobal('useReportState', () => rs)
})

/** The component's own "last complete month" (day 0 of this month = last of prior). */
function lastCompleteMonth(): string {
  const n = new Date()
  const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 0))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
/** The component's own "current month". */
function currentMonth(): string {
  const n = new Date()
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}`
}
/** The component's own quarter-start `YYYY-MM-01` (Jan/Apr/Jul/Oct). */
function quarterStart(): string {
  const n = new Date()
  const qStartMonth = Math.floor(n.getUTCMonth() / 3) * 3
  return `${n.getUTCFullYear()}-${String(qStartMonth + 1).padStart(2, '0')}-01`
}

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
    expect(rs.patch).toHaveBeenCalledWith({ month: lastCompleteMonth(), from: null, to: null })
    // month mode (no range) → the scope keeps forecast/MoM eligibility.
    const arg = rs.patch.mock.calls[0]![0] as { month: string }
    expect(arg.month).toMatch(/^\d{4}-\d{2}$/)
  })

  it('"This quarter" applies the quarter-to-date range (quarter start → today), clearing ?month', async () => {
    const w = mount(DateRangeControl)
    await w.find('[data-testid="date-range-quarter"]').trigger('click')
    expect(rs.patch).toHaveBeenCalledTimes(1)
    const arg = rs.patch.mock.calls[0]![0] as { month: null; from: string; to: string }
    expect(arg.month).toBeNull()
    expect(arg.from).toMatch(/^\d{4}-(01|04|07|10)-01$/) // a quarter-start month, day 01
    expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(arg.from < arg.to).toBe(true)
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
    rs.month.value = currentMonth()
    const w = mount(DateRangeControl)
    // "This month" is the active pill; the custom editor is NOT auto-opened (it used to
    // classify ?month=current as 'custom' and open the editor seeded with a 30-day range).
    expect(w.find('[data-testid="date-range-month"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="date-range-custom"]').attributes('aria-pressed')).toBe('false')
    expect(w.find('[data-testid="date-range-editor"]').exists()).toBe(false)
  })

  it('"This quarter" pill stays active when stored `to` is not today — from-only match (#8)', () => {
    // Simulate the page left open past UTC midnight: `from` still equals the quarter start
    // but the stored `to` is a stale earlier day (no longer today). The pill must stay lit.
    rs.from.value = quarterStart()
    rs.to.value = '2000-06-15' // a stale `to`, deliberately != today
    const w = mount(DateRangeControl)
    expect(w.find('[data-testid="date-range-quarter"]').attributes('aria-pressed')).toBe('true')
    expect(w.find('[data-testid="date-range-custom"]').attributes('aria-pressed')).toBe('false')
  })
})
