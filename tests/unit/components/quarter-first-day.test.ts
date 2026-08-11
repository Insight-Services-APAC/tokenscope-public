// @vitest-environment happy-dom
/*
 * "THIS QUARTER" ON THE FIRST UTC DAY OF A QUARTER (external review, HIGH).
 *
 * `currentQuarterRange` built quarter-to-date as `[quarter start, settledThrough]`.
 * On 1 Jan / 1 Apr / 1 Jul / 1 Oct the settled edge is the LAST day of the
 * PREVIOUS quarter, so the preset produced an INVERTED range — `from` after `to`
 * — which `resolveReportRange` rejects with a 400. Four days a year, one click
 * took every report on the page down.
 *
 * There is no honest range on those days: the quarter has begun and nothing in
 * it has settled. So the preset is UNAVAILABLE and says why, which is the same
 * posture the control already takes for a preset whose clock has not landed.
 * Clamping `to` up to `from` would have quoted the still-filling day as a
 * settled window — the F1 defect, wearing a preset.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import DateRangeControl from '../../../app/components/reporting/DateRangeControl.vue'
import { currentQuarterRange } from '../../../app/components/reporting/period-presets'
import { stubServerClock } from '../../helpers/server-clock'

/** The four boundary days, and the settled edge each one really has. */
const BOUNDARIES = [
  { today: '2026-01-01', settled: '2025-12-31' },
  { today: '2026-04-01', settled: '2026-03-31' },
  { today: '2026-07-01', settled: '2026-06-30' },
  { today: '2026-10-01', settled: '2026-09-30' },
]

describe('currentQuarterRange — never an inverted range', () => {
  /*
   * RED ON REVERT: drop the `settledThrough < from` guard and each of these
   * returns `{ from: <quarter start>, to: <previous quarter's last day> }`.
   */
  it.each(BOUNDARIES)('returns null on the first day of a quarter ($today)', ({ today, settled }) => {
    expect(currentQuarterRange(today, settled)).toBeNull()
  })

  it('returns a real range the moment ONE day has settled inside the quarter', () => {
    expect(currentQuarterRange('2026-07-02', '2026-07-01')).toEqual({
      from: '2026-07-01',
      to: '2026-07-01',
    })
  })

  it('is unchanged mid-quarter — the fix narrows nothing else', () => {
    expect(currentQuarterRange('2026-08-15', '2026-08-14')).toEqual({
      from: '2026-07-01',
      to: '2026-08-14',
    })
  })
})

describe('DateRangeControl — the pill is disabled rather than broken', () => {
  let rs: { month: ReturnType<typeof ref>; from: ReturnType<typeof ref>; to: ReturnType<typeof ref>; patch: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    rs = { month: ref(null), from: ref(null), to: ref(null), patch: vi.fn() }
    vi.stubGlobal('useReportState', () => rs)
  })

  it('on 1 July the quarter pill is disabled, explains itself, and writes NOTHING', async () => {
    stubServerClock('2026-07-01T09:14:00Z')
    const w = mount(DateRangeControl)
    const pill = w.find('[data-testid="date-range-quarter"]')
    expect(pill.attributes('disabled')).toBeDefined()
    expect(pill.attributes('title')).toContain('no completed day yet')
    await pill.trigger('click')
    // The defect: an inverted `{ from, to }` patched onto the URL, 400ing the page.
    expect(rs.patch).not.toHaveBeenCalled()
  })

  it('mid-quarter the pill is live and writes the quarter-to-date range', async () => {
    stubServerClock('2026-08-15T09:14:00Z')
    const w = mount(DateRangeControl)
    const pill = w.find('[data-testid="date-range-quarter"]')
    expect(pill.attributes('disabled')).toBeUndefined()
    await pill.trigger('click')
    expect(rs.patch).toHaveBeenCalledWith({ month: null, from: '2026-07-01', to: '2026-08-14' })
  })
})
