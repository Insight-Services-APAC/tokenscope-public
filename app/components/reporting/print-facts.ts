/*
 * What a printed report says about itself (#583).
 *
 * A page on a desk has lost the app around it: the tabs, the lens toggle, the
 * settling chips. The printed header puts back the five facts a reader needs
 * to know what the figures are: the scope, the period (as UTC dates), the lens
 * (Usage or Chargeback), the settling state, and when the figures were read.
 *
 * WHO KNOWS WHAT. The page (reporting shell, project dashboard) owns the clock
 * and renders the header; the ACTIVE VIEW owns the payload, so it publishes the
 * other facts upward with `publishPrintFacts`. The view is presentational and
 * mounts in unit tests without a provider: with none, publishing is a no-op.
 *
 * NO BROWSER CLOCK. The period comes from the payload's own window and the time
 * from the server clock already on the page (`clock.now`), so a printed page
 * can never name a period the screen was not showing.
 */
import { inject, onBeforeUnmount, provide, shallowRef, watchEffect, type InjectionKey, type Ref } from 'vue'
import { settlingPill } from '#shared/reports/settling-words'
import { vendorLabel, type SettlingState } from '#shared/reports/types'

export type PrintLens = 'usage' | 'chargeback'

export interface ReportPrintFacts {
  /** What the figures cover, as the screen names it ("APAC", "All regions", a Business Unit, a project). */
  scope: string
  /** The window's first and last UTC day, inclusive (`YYYY-MM-DD`). */
  from: string
  to: string
  lens: PrintLens
  settling: { vendor?: string; state: SettlingState }[]
}

const KEY: InjectionKey<Ref<ReportPrintFacts | null>> = Symbol('report-print-facts')

/** The page: hold the facts the active view publishes. */
export function providePrintFacts(): Ref<ReportPrintFacts | null> {
  // Shallow: the facts are replaced whole, and the unmount check compares identity.
  const facts = shallowRef<ReportPrintFacts | null>(null)
  provide(KEY, facts)
  return facts
}

/** A view: publish its facts while it is mounted. A no-op without a provider. */
export function publishPrintFacts(get: () => ReportPrintFacts | null): void {
  const target = inject(KEY, null)
  if (!target) return
  let mine: ReportPrintFacts | null = null
  watchEffect(() => {
    mine = get()
    target.value = mine
  })
  onBeforeUnmount(() => {
    // Only clear what this view put there: the next view may already have published.
    if (target.value === mine) target.value = null
  })
}

/** A report window from `meta`: the custom range when set, else the whole UTC month. */
export function windowFromMeta(meta: { month: string; range?: { from: string; to: string } }): { from: string; to: string } {
  if (meta.range) return { from: meta.range.from, to: meta.range.to }
  const [y, m] = meta.month.split('-').map(Number) as [number, number]
  // Calendar arithmetic on the payload's month string; no clock is read.
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 31
  return { from: `${meta.month}-01`, to: `${meta.month}-${String(last).padStart(2, '0')}` }
}

/**
 * The Finance bill's period: the bill is MONTH-grained, and a custom range sums
 * every whole month it touches (finance/index.get.ts), so it prints those months.
 */
export function billMonthsWindow(meta: { month: string; range?: { from: string; to: string } }): { from: string; to: string } {
  if (!meta.range) return windowFromMeta(meta)
  return {
    from: windowFromMeta({ month: meta.range.from.slice(0, 7) }).from,
    to: windowFromMeta({ month: meta.range.to.slice(0, 7) }).to,
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * The period the way the rest of the app writes dates, from two inclusive UTC
 * days: "1 to 30 Nov 2026 (UTC)", "28 Oct to 3 Nov 2026 (UTC)",
 * "28 Dec 2026 to 3 Jan 2027 (UTC)", "5 Nov 2026 (UTC)". Read off the strings,
 * so no time zone can move a day.
 */
export function printPeriod(from: string, to: string): string {
  const parse = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
    return m ? { y: m[1]!, mo: MONTHS[Number(m[2]) - 1] ?? m[2]!, d: String(Number(m[3])) } : null
  }
  const a = parse(from)
  const b = parse(to)
  if (!a || !b) return `${from} to ${to} (UTC)`
  const end = `${b.d} ${b.mo} ${b.y}`
  if (from === to) return `${end} (UTC)`
  if (a.y !== b.y) return `${a.d} ${a.mo} ${a.y} to ${end} (UTC)`
  if (a.mo !== b.mo) return `${a.d} ${a.mo} to ${end} (UTC)`
  return `${a.d} to ${end} (UTC)`
}

export const LENS_WORD: Record<PrintLens, string> = { usage: 'Usage', chargeback: 'Chargeback' }

/** "Anthropic: Settling · Usage: Estimated" — the chip row, in the chips' own words. */
export function settlingLine(settling: ReportPrintFacts['settling']): string {
  return settling
    .map((s) => (s.vendor ? `${vendorLabel(s.vendor)}: ${settlingPill(s.state)}` : settlingPill(s.state)))
    .join(' · ')
}
