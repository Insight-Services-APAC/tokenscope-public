// @vitest-environment node
/*
 * `budgetPace` — the basis behind the per-project pill on the dashboard.
 *
 * The pill kept its words, colours and position; only what it COMPUTES changed.
 * It used to be raw percent-of-budget, which has no calendar in it: 90% of a
 * budget on day 28 is a month landing about on plan, 90% on day 5 is a month
 * landing at roughly six times the budget, and raw percent called both of them
 * the same thing. In practice every project on the dashboard read "Healthy",
 * including one sitting at $0.00 of $500 where nothing had happened at all.
 *
 * D8 then split ONE of the words: "Over" used to cover both the fact (spend
 * already past the allocation) and the forecast (on this pace it will be), so
 * the pill could not say which of two things it meant. The fact keeps 'over' /
 * "Over" (red); the forecast is now 'pace-over' / "On pace to exceed" (amber).
 *
 * The truth table below IS the contract. It is a pure function of four numbers
 * precisely so it can be pinned without a component.
 */
import { describe, it, expect } from 'vitest'
import {
  budgetPace,
  budgetPaceKind,
  budgetPaceLabel,
  projectedMonthEnd,
} from '../../../app/composables/useRagState'

/** July: 31 days. Every case names its own day, so no case needs a real clock. */
const DAYS = 31

describe('budgetPace — the two cases raw percent could not tell apart', () => {
  it('90% of the budget on day 5 is On pace to exceed — this pace finishes at ~5.6x', () => {
    // 0.90 x 31/5 = 5.58 of the allocation. A FORECAST — the spend itself is
    // still under the allocation — so since D8 it is 'pace-over', not 'over'.
    expect(budgetPace(450, 500, 5, DAYS)).toBe('pace-over')
  })

  it('90% of the budget on day 28 is NOT on pace to exceed — this pace finishes at ~1.0x', () => {
    /*
     * 0.90 x 31/28 = 0.9964, so the month lands just under the allocation and
     * the row is not over budget. It IS inside the 85-100% band, which is what
     * "Warning" means — the point of the case is that day 5 and day 28 at the
     * same raw percent must not produce the same verdict.
     */
    expect(budgetPace(450, 500, 28, DAYS)).toBe('warning')
    expect(budgetPace(450, 500, 5, DAYS)).not.toBe(budgetPace(450, 500, 28, DAYS))
  })
})

describe('budgetPace — the bands', () => {
  it('already past the allocation is Over regardless of the day', () => {
    /*
     * $600 of $500. The fixture used to be 500/500 — exactly AT the allocation,
     * under a test named "already past" — so it could not reach the case it
     * named, and it only passed because the boundary was `>=`. Tightening the
     * boundary is what exposed it.
     */
    expect(budgetPace(600, 500, 1, DAYS)).toBe('over')
    expect(budgetPace(650, 500, 31, DAYS)).toBe('over')
  })

  it('on this pace finishing past the allocation is On pace to exceed — a forecast, not the fact', () => {
    // Half the budget at the one-third mark projects to 1.5x. Before D8 this
    // returned 'over', the same state as spend ALREADY past the allocation.
    expect(budgetPace(250, 500, 10, 30)).toBe('pace-over')
  })

  it('on this pace finishing at 85-100% is Warning', () => {
    // Exactly 0.85 of the allocation at half the month projects to... 1.7x, so
    // build the boundary from the projection instead: 0.85 x elapsed.
    const elapsed = 15 / 30
    expect(budgetPace(500 * 0.85 * elapsed, 500, 15, 30)).toBe('warning')
    expect(budgetPace(500 * 0.99 * elapsed, 500, 15, 30)).toBe('warning')
  })

  it('on this pace finishing under 85% is Healthy', () => {
    const elapsed = 15 / 30
    expect(budgetPace(500 * 0.84 * elapsed, 500, 15, 30)).toBe('healthy')
    expect(budgetPace(10, 500, 15, 30)).toBe('healthy')
  })

  it('an allocation with nothing spent against it is Not started, never Healthy', () => {
    // The defect that made this function necessary: $0.00 of $500 rendered a
    // green "Healthy", which reads as a verdict on work that has not begun.
    expect(budgetPace(0, 500, 14, DAYS)).toBe('not-started')
    expect(budgetPace(0, 500, 14, DAYS)).not.toBe('healthy')
  })

  it('no allocation is No budget set — there is nothing to be healthy against', () => {
    expect(budgetPace(120, 0, 14, DAYS)).toBe('no-budget')
    // Checked BEFORE the spend branch: a project with no budget and no spend is
    // still "no budget", not "not started".
    expect(budgetPace(0, 0, 14, DAYS)).toBe('no-budget')
  })
})

describe('budgetPace — the calendar', () => {
  it('on the last day the projection degenerates to the actual', () => {
    // Elapsed fraction is 1, so projected == used: 84% on day 31 of 31 is a
    // month that finished at 84%.
    expect(budgetPace(420, 500, 31, 31)).toBe('healthy')
    expect(budgetPace(440, 500, 31, 31)).toBe('warning')
  })

  it('a degenerate calendar extrapolates nothing rather than dividing by zero', () => {
    /*
     * (0 of 0) is the page's pre-fetch default, which renders no rows. It is
     * now caught by the day floor before it ever reaches the arithmetic — zero
     * days elapsed supports no projection, which is the same answer the floor
     * gives days 1 and 2, and a stronger one than the 'healthy' this test used
     * to assert.
     */
    expect(budgetPace(120, 500, 0, 0)).toBe('too-early')
    expect(budgetPace(490, 500, 0, 0)).toBe('too-early')
    /*
     * The clamp underneath it is still load-bearing and still asserted, at a
     * day that gets PAST the floor into the arithmetic. A zero-day month would
     * divide by zero into an "Over" nobody can explain; clamped to 1 of 1 the
     * projection degenerates to the actual, i.e. it extrapolates nothing.
     *
     * Without this second pair the floor would be masking the div-by-zero
     * rather than the clamp preventing it, and deleting the clamp would leave
     * the suite green.
     */
    expect(budgetPace(120, 500, 3, 0)).toBe('healthy')
    expect(budgetPace(490, 500, 3, 0)).toBe('warning')
  })
})

describe('budgetPace — the pill keeps the words and the colours (bar the D8 split)', () => {
  it('maps each state to its word — only the forecast got a new one', () => {
    expect(budgetPaceLabel('healthy')).toBe('Healthy')
    expect(budgetPaceLabel('warning')).toBe('Warning')
    expect(budgetPaceLabel('over')).toBe('Over')
    /*
     * The D8 split (design test 15): the forecast must NOT wear the fact's
     * word. "Over" beside a bucket that is not over reads as money already
     * spent; the forecast says what it is.
     */
    expect(budgetPaceLabel('pace-over')).toBe('On pace to exceed')
    expect(budgetPaceLabel('pace-over')).not.toBe('Over')
    expect(budgetPaceLabel('not-started')).toBe('Not started')
    expect(budgetPaceLabel('no-budget')).toBe('No budget set')
  })

  it('maps each state to its RAG colour — the forecast is amber, the fact red', () => {
    expect(budgetPaceKind('healthy')).toBe('rag-green')
    expect(budgetPaceKind('warning')).toBe('rag-amber')
    expect(budgetPaceKind('over')).toBe('rag-red')
    // A forecast is amber ("act before it becomes a fact"), never the fact's red.
    expect(budgetPaceKind('pace-over')).toBe('rag-amber')
    // Not a RAG state: nothing has happened, so nothing is green, amber or red.
    expect(budgetPaceKind('not-started')).toBe('neutral')
  })

  it('withholds a projection before day 3, but never withholds a FACT', () => {
    /*
     * The floor gates the FORECAST only. Already past the allocation is a fact
     * and must survive it — my first version of the floor returned 'too-early'
     * for an over-budget project on day 1, suppressing something true.
     */
    expect(budgetPace(400, 1000, 1, 31)).toBe('too-early')   // would project ~1240%
    /*
     * Zero and negative days take the floor too. My first version guarded the
     * floor with `daysElapsed > 0`, which let exactly these two fall PAST it
     * into the clamp below — which projects them as day 1. So a missing day
     * (0) returned "Over" while day 1, with strictly more evidence behind it,
     * returned "too early". The case with the least evidence got the most
     * confident answer.
     */
    expect(budgetPace(400, 1000, 0, 31)).toBe('too-early')
    expect(budgetPace(400, 1000, -1, 31)).toBe('too-early')
    /*
     * ...and already-over still survives BOTH, because it is a fact and not a
     * forecast. This is the pair that makes the floor a floor on projections
     * only, rather than a blanket "we know nothing before day 3". Since D8
     * these rows are also where the fact KEEPS the word: 'over', never
     * 'pace-over', however early the day.
     */
    expect(budgetPace(1200, 1000, 0, 31)).toBe('over')
    expect(budgetPace(1200, 1000, -1, 31)).toBe('over')
    expect(budgetPace(1200, 1000, 1, 31)).toBe('over')       // already past it
    /*
     * Day 3: the forecast lands — and lands as the FORECAST state (design
     * test 15). This row and the (1200, …, 0) row above are the pair that must
     * now disagree: same "the month ends badly" conclusion, different
     * evidence, different word.
     */
    expect(budgetPace(400, 1000, 3, 31)).toBe('pace-over')
  })

  it('exactly 100% of the allocation is not "Over"', () => {
    // `budgetPace` used >= 1 while `ragFromPct` twelve lines above used > 1 —
    // two functions in one file disagreeing about the same boundary. Spent is
    // not exceeded, and the copy says "over" and "past". Both boundaries are
    // `> 1`, so neither the fact nor the forecast fires at exactly 1.0.
    expect(budgetPace(500, 500, 31, 31)).not.toBe('over')
    expect(budgetPace(500, 500, 31, 31)).not.toBe('pace-over')
  })
})

describe('projectedMonthEnd — the figure behind the pace-over line', () => {
  it('withholds a projection below the day floor, like the pace it justifies', () => {
    // Same PACE_MIN_DAYS floor as budgetPace's forecast branch — a figure
    // printed where the pill says "Too early" would be the same one-page
    // contradiction the floor exists to prevent.
    expect(projectedMonthEnd(400, 2, 31)).toBeNull()
    expect(projectedMonthEnd(400, 0, 31)).toBeNull()
    expect(projectedMonthEnd(400, -1, 31)).toBeNull()
  })

  it('declines a degenerate calendar rather than extrapolating from it', () => {
    /*
     * budgetPace answers this input (day >= floor, zero-day month) by letting
     * the ACTUAL stand in — "extrapolate nothing". As a dollar figure,
     * "extrapolates nothing" is not a projection at all, so no line: null.
     */
    expect(projectedMonthEnd(120, 3, 0)).toBeNull()
  })

  it('degenerates to the actual on the last day', () => {
    // Elapsed fraction 1: the month has landed, and the projection IS the spend.
    expect(projectedMonthEnd(420, 31, 31)).toBe(420)
    // A day past the month clamps INTO it — degenerate to the actual, never beyond.
    expect(projectedMonthEnd(420, 40, 31)).toBe(420)
  })

  it("is per-bucket: two spends, two projections, neither their sum's (r1-M4, design test 23)", () => {
    /*
     * The page-level monthEndProjection is the PORTFOLIO total. The line under
     * a project's pill must be built from that project's own spend — two
     * different buckets on the same day must land two different figures, and
     * neither may equal the portfolio's.
     */
    const a = projectedMonthEnd(379.83, 3, 31)
    const b = projectedMonthEnd(200, 3, 31)
    const portfolio = projectedMonthEnd(379.83 + 200, 3, 31)
    expect(a).toBeCloseTo(3924.91, 2)
    expect(b).toBeCloseTo(2066.67, 2)
    expect(a).not.toBe(b)
    expect(a).not.toBe(portfolio)
    expect(b).not.toBe(portfolio)
  })

  it("agrees with budgetPace's verdict — the figure and the pill cannot disagree", () => {
    // 400 of 1000 on day 3 of 31 → ~$4,133 lands past the allocation, and the
    // pace for the same four numbers says so.
    const proj = projectedMonthEnd(400, 3, 31)
    expect(proj).toBeCloseTo(4133.33, 2)
    expect(proj as number).toBeGreaterThan(1000)
    expect(budgetPace(400, 1000, 3, 31)).toBe('pace-over')
  })
})
