// @vitest-environment node
/*
 * T29 — the parity gate would now have caught S3 and S4.
 *
 * WHY THE GATE ITSELF NEEDS A TEST. Two of the fix sprint's nine snags reached
 * Dev, where the owner found them, because the capture shot ONE width (1600) at
 * ONE moment (whenever it happened to run, i.e. mid-month):
 *
 *   S3 — the hero row silently becomes two-up below `xl`. At 1600 it is perfect.
 *   S4 — every hero spark is replaced by the words "not enough days yet" for the
 *        first six days of every month. On the 14th it is invisible.
 *
 * Neither is a data defect, so no amount of suite coverage could see them; the
 * screenshot gate was the right instrument and it was pointed at the one width
 * and the one day where both defects hide. This file pins the two axes that fix
 * that, so a future "simplification" back to a single width or a single state
 * goes red here rather than on Dev six weeks later.
 *
 * IT ALSO PINS THE HALF THAT MAKES DAY 1 REAL. A `?clock=` that the server
 * ignored would give a green matrix and a mid-month screenshot filed as day 1 —
 * the exact "asserting something we have not measured" class this project keeps
 * paying for. So the URL the matrix emits is fed to the resolver that actually
 * honours it (`server/utils/clock-pin.ts`, the HTTP path to F1's request-clock
 * seam) and the resulting ServerClock is asserted to BE day 1.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildJobs, dayOnePin, DEFAULT_STATES, DEFAULT_WIDTHS } from '../../../scripts/parity-jobs.mjs'
import { resolveClockPin, CLOCK_PIN_OFF } from '../../../server/utils/clock-pin'

const ROOT = resolve(__dirname, '../../..')

const BASE = {
  today: '2026-08-14',
  appBase: 'http://localhost:3450',
  protoBase: 'http://localhost:8899',
  proto2Base: 'http://localhost:8898',
}

const shots = (scopes: string[], over: Record<string, unknown> = {}) =>
  buildJobs({ ...BASE, scopes, ...over })

/** The `?clock=` value carried by a job, if any. */
function clockOf(url: string): string | null {
  const m = /[?&]clock=([^&#]+)/.exec(url)
  return m ? decodeURIComponent(m[1]!) : null
}

describe('T29 — the gate shoots a NARROW width (S3)', () => {
  it('the default width set includes one below the `xl` breakpoint, and 1600', () => {
    // 1600 is above every breakpoint in the product. A gate that only shoots it
    // can never see a row that becomes two-up on a laptop.
    expect(DEFAULT_WIDTHS).toContain(1600)
    expect(DEFAULT_WIDTHS.some((w: number) => w <= 1280)).toBe(true)
  })

  it('every app surface is shot at BOTH widths', () => {
    const jobs = shots(['usage', 'projects', 'project'])
    for (const name of ['app-usage', 'app-projects', 'app-project']) {
      const widths = new Set(jobs.filter((j) => j.name === name).map((j) => j.width))
      expect({ name, widths: [...widths].sort((a, b) => a - b) }).toEqual({
        name,
        widths: [...DEFAULT_WIDTHS].sort((a, b) => a - b),
      })
    }
  })

  it('the prototype is shot at the same widths, so the pair is comparable', () => {
    // A narrow app shot next to a 1600 drawing is not a comparison.
    const jobs = shots(['usage'])
    const app = new Set(jobs.filter((j) => j.name === 'app-usage').map((j) => j.width))
    const proto = new Set(jobs.filter((j) => j.name === 'proto-devpages-usage').map((j) => j.width))
    expect([...proto].sort()).toEqual([...app].sort())
  })

  it('each shot gets its own file — no width silently overwrites another', () => {
    const files = shots(['usage', 'projects']).map((j) => j.file)
    expect(new Set(files).size).toBe(files.length)
  })
})

describe('T29 — the gate shoots a DAY-1 clock (S4)', () => {
  it('the default state set covers both mid-month and day 1', () => {
    expect(DEFAULT_STATES).toEqual(['mid', 'd1'])
  })

  it('the day-1 arm pins the app clock on the URL; the mid arm does not', () => {
    const jobs = shots(['usage'])
    const d1 = jobs.filter((j) => j.name === 'app-usage' && j.state === 'd1')
    const mid = jobs.filter((j) => j.name === 'app-usage' && j.state === 'mid')
    expect(d1.length).toBeGreaterThan(0)
    expect(d1.every((j) => clockOf(j.url!) === '2026-08-01T09:00:00.000Z')).toBe(true)
    // Unpinned by default: the mid shot is the product on the real clock.
    expect(mid.every((j) => clockOf(j.url!) === null)).toBe(true)
  })

  it('the pin is the 1st of the RUN\'s own month, not a hardcoded date', () => {
    // A frozen historical month would shoot a page with no data in it.
    expect(dayOnePin('2026-12-31')).toBe('2026-12-01T09:00:00.000Z')
    expect(dayOnePin('2027-02-03')).toBe('2027-02-01T09:00:00.000Z')
    expect(clockOf(shots(['usage'], { today: '2027-02-03' }).find((j) => j.state === 'd1' && j.name === 'app-usage')!.url!)).toBe(
      '2027-02-01T09:00:00.000Z',
    )
  })

  it('the prototype arm is deep-linked to its OWN d1 state, so the pair matches', () => {
    const jobs = shots(['usage'])
    const proto = jobs.filter((j) => j.name === 'proto-devpages-usage' && j.state === 'd1')
    expect(proto.length).toBeGreaterThan(0)
    expect(proto.every((j) => j.url!.includes('st=d1'))).toBe(true)
    // …and the mid arm to `st=mid`; one drawing per state, never one for both.
    expect(
      jobs
        .filter((j) => j.name === 'proto-devpages-usage' && j.state === 'mid')
        .every((j) => j.url!.includes('st=mid')),
    ).toBe(true)
  })

  it('the URL the gate emits ACTUALLY resolves to day 1 on the server', () => {
    /*
     * The end-to-end claim, in one assertion: matrix → `?clock=` → the resolver
     * the middleware follows → a ServerClock whose `today` IS the 1st and whose
     * settled edge is the last day of the previous month. If the pin were
     * ignored, this is where a "day-1" screenshot that is really mid-month
     * stops being green.
     */
    const url = shots(['usage']).find((j) => j.name === 'app-usage' && j.state === 'd1')!.url!
    const verdict = resolveClockPin({ demoCapable: true, query: clockOf(url)!, cookie: undefined })
    expect(verdict.action).toBe('pin')
    if (verdict.action !== 'pin') return
    expect(verdict.clock.today).toBe('2026-08-01')
    expect(verdict.clock.settledThrough).toBe('2026-07-31')
    // It rides a cookie so the client's own /api/v1/clock fetch sees the same
    // instant; without that the page would snap back to the wall clock on hydrate.
    expect(verdict.setCookie).toBe(true)
  })
})

describe('T29 — the clock pin is a demo-env seam, and it fails loudly', () => {
  it('is INERT outside a demo-capable env, param and cookie alike', () => {
    expect(resolveClockPin({ demoCapable: false, query: '2026-08-01T09:00:00Z', cookie: undefined })).toEqual({
      action: 'none',
    })
    expect(resolveClockPin({ demoCapable: false, query: undefined, cookie: '2026-08-01T09:00:00Z' })).toEqual({
      action: 'none',
    })
  })

  it('rejects a malformed pin rather than shooting the wrong day', () => {
    for (const bad of ['2026-08-01', 'tomorrow', '2026-08-01T09:00:00+02:00']) {
      expect(resolveClockPin({ demoCapable: true, query: bad, cookie: undefined }).action).toBe('reject')
    }
  })

  it('honours the cookie without re-setting it, and clears on `off` or corruption', () => {
    const carried = resolveClockPin({ demoCapable: true, query: undefined, cookie: '2026-08-01T09:00:00Z' })
    expect(carried.action).toBe('pin')
    if (carried.action === 'pin') expect(carried.setCookie).toBe(false)

    expect(resolveClockPin({ demoCapable: true, query: CLOCK_PIN_OFF, cookie: 'x' }).action).toBe('clear')
    expect(resolveClockPin({ demoCapable: true, query: undefined, cookie: 'nonsense' }).action).toBe('clear')
    expect(resolveClockPin({ demoCapable: true, query: undefined, cookie: undefined }).action).toBe('none')
  })
})

describe('T29 — the day-1 pin reaches the surfaces the d1 arm shoots', () => {
  /*
   * THE HALF THAT WAS MISSING, AND HOW IT WAS FOUND. The first real day-1
   * capture came back showing "day 5 of 31" — a page pinned to 2026-08-01 that
   * still believed it was the 5th. `/api/v1/clock` honoured the pin (so the
   * browser's axis moved) while `/api/v1/me/usage` took its own `new Date()`
   * (so every server-computed month operand did not). A screenshot in that state
   * is worse than no screenshot: it is filed as day 1 and is not.
   *
   * A pinned clock is only real on a page if the endpoints BEHIND that page read
   * the request clock. These three are the ones the `usage`, `projects` and
   * `project` arms depend on. The assertion is on the source rather than on a
   * live request because that is where the defect lives — a handler that calls
   * `new Date()` is unpinnable by construction, and no fixture can make it not so.
   */
  const CLOCK_BOUND_HANDLERS = [
    'server/api/v1/me/usage.get.ts',
    'server/api/v1/me/projects/summary.get.ts',
    'server/api/v1/me/projects/[code]/index.get.ts',
    /*
     * Added by the integrator after F6 surfaced the class. These two are
     * windowing handlers on surfaces THIS change rebuilt, so leaving them on a
     * second clock would ship a page whose month disagrees with the month the
     * same PR introduced — the S6/S7 defect one surface over.
     *
     * `me/cost-centres.get.ts` is the sharper of the two: `resolveOwnerWindow`
     * bounds EVERY spend figure on the cost-centre response, and F5 rebuilt that
     * page here. `me/home.get.ts` already had a one-clock-per-response comment
     * explaining that two clocks either side of UTC midnight put the two halves
     * of its payload in different months — it just read the wrong clock.
     *
     * The remaining ~50 `new Date()` in server/ are audit timestamps
     * (`saved_at`, `issuedAt`) — real instants, correctly not clock-bound — plus
     * admin surfaces outside this change. Those are a disclosed sweep, not this
     * PR's work.
     */
    'server/api/v1/me/cost-centres.get.ts',
    'server/api/v1/me/home.get.ts',
  ]
  /** Comments quote `new Date()` by name; the gate must read code, not prose. */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  it.each(CLOCK_BOUND_HANDLERS)('%s resolves `now` from requestClock', (rel) => {
    const src = stripComments(readFileSync(resolve(ROOT, rel), 'utf8'))
    expect({ file: rel, seam: src.includes('requestClock(event)') }).toEqual({ file: rel, seam: true })
    expect({ file: rel, bare: /\bnew\s+Date\s*\(\s*\)/.test(src) }).toEqual({ file: rel, bare: false })
  })
})

describe('T29 — the arms that were already right stay right', () => {
  it('the teammate arm skips with its reason rather than shooting a 400', () => {
    const jobs = shots(['teammate'])
    const arm = jobs.filter((j) => j.name === 'app-teammate')
    expect(arm.length).toBeGreaterThan(0)
    expect(arm.every((j) => j.url === null && /PARITY_TEAMMATE/.test(j.skipped!))).toBe(true)
  })

  it('the teammate arm shoots when given a subject, carrying its `?src=` frame', () => {
    const jobs = shots(['teammate'], { teammateId: 'abc-123' })
    const arm = jobs.find((j) => j.name === 'app-teammate')!
    expect(arm.skipped).toBeUndefined()
    expect(arm.url).toContain('/reporting/teammate/abc-123?src=across')
  })

  it('a bare reporting run does not drag in the developer-pages prototype', () => {
    const jobs = shots(['region', 'cost-centres', 'finance'])
    expect(jobs.some((j) => j.name.startsWith('proto-devpages'))).toBe(false)
    expect(jobs.some((j) => j.name === 'proto-full')).toBe(true)
  })
})
