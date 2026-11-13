/*
 * Month abbreviations, in ONE table (#641): Jan Feb Mar Apr May Jun Jul Aug Sep
 * Oct Nov Dec, as the SPEC and the design boards write them.
 *
 * `Intl.DateTimeFormat('en-GB', { month: 'short' })` is not that table: current
 * browsers' en-GB data abbreviates September as "Sept", older data and Node's
 * small-ICU builds say "Sep", so one date read "2 Sept 2026" on one page,
 * "1 Sep" on the next, and differently again between server render and browser.
 *
 * So every short month in the product comes from MONTH_SHORT: hand-built
 * strings index it directly, and Intl formatting goes through
 * `formatMonthWords`, which keeps the locale's order and punctuation but swaps
 * the month part for the table's word. A ratchet
 * (`tests/unit/app/one-month-table.test.ts`) refuses a `month: 'short'` option
 * anywhere else.
 */

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** The table's word for a 1-based month number, or undefined when out of range. */
export function monthShort(month1: number): string | undefined {
  return MONTH_SHORT[month1 - 1]
}

/**
 * `new Intl.DateTimeFormat(locale, options).format(t)` with a `month: 'short'`
 * part replaced by the table's word. The month is read in the same `timeZone`
 * as the rest of the string, so a UTC day and a local instant both name the
 * month they print.
 */
export function formatMonthWords(
  locale: string,
  options: Intl.DateTimeFormatOptions & { month: 'short' },
  t: number | Date,
): string {
  const parts = new Intl.DateTimeFormat(locale, options).formatToParts(t)
  const numeric = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(t)
  const word = monthShort(Number(numeric))
  return parts.map((p) => (p.type === 'month' && word ? word : p.value)).join('')
}
