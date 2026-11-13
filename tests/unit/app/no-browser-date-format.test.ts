/*
 * RATCHET (#633): dates under app/ go through the shared formatters.
 *
 * An instant renders through `fmtInstant` ("12 Nov 2026, 19:05", the viewer's
 * zone); a UTC day through `fmtUtcDay`; never the browser's own default style,
 * which prints "11/12/2026" in one browser and "12/11/2026" in the next, and
 * converts a day bucket into the wrong day west of UTC (CLAUDE.md "The clock").
 *
 * What fails:
 *   - any `.toLocaleDateString(` / `.toLocaleTimeString(` call, and
 *   - a `.toLocaleString(` call on `new Date(...)`, or one whose options name a
 *     date field (month, day, year, hour, minute, second, weekday, dateStyle,
 *     timeStyle),
 * unless its options say `timeZone: 'UTC'`: a provider month or day labelled
 * in UTC is the rule, not an exception to it.
 *
 * What passes: number formatting (`n.toLocaleString()`, `count.toLocaleString('en')`),
 * which has no receiver `new Date(` and no date options. Named exceptions live
 * in ALLOWED with the reason.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const APP = join(ROOT, 'app')

/* file -> why it may format dates itself. */
const ALLOWED: Record<string, string> = {
  'app/composables/useFormat.ts': 'the shared formatters themselves',
}

const DATE_OPTION = /\b(month|day|year|hour|minute|second|weekday|dateStyle|timeStyle)\s*:/
const UTC_OPTION = /timeZone\s*:\s*['"]UTC['"]/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

/** The text of the call's parentheses, starting at the `(` at `open`. */
function argsAt(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return src.slice(open + 1)
}

function violations(src: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = []
  const re = /\.toLocale(Date|Time)?String\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const args = argsAt(src, open)
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const receiver = src.slice(lineStart, m.index)
    const dateOnly = m[1] !== undefined
    const dateish = dateOnly || /new Date\(/.test(receiver) || DATE_OPTION.test(args)
    if (dateish && !UTC_OPTION.test(args)) {
      const line = src.slice(0, m.index).split('\n').length
      found.push({ line, text: src.slice(lineStart, src.indexOf('\n', m.index)).trim() })
    }
  }
  return found
}

describe('no browser-default date formatting under app/ (#633)', () => {
  it('every date goes through fmtInstant / fmtUtcDay, or is labelled in UTC', () => {
    const bad: string[] = []
    for (const f of walk(APP)) {
      const rel = relative(ROOT, f)
      if (ALLOWED[rel]) continue
      for (const v of violations(readFileSync(f, 'utf8'))) bad.push(`${rel}:${v.line}: ${v.text}`)
    }
    expect(bad).toEqual([])
  })

  it('catches the shapes it exists for, and lets numbers through', () => {
    expect(violations('x = new Date(v).toLocaleString()')).toHaveLength(1)
    expect(violations("x = new Date(v).toLocaleDateString(undefined, { month: 'short' })")).toHaveLength(1)
    expect(violations('x = d.toLocaleTimeString()')).toHaveLength(1)
    expect(violations("x = d.toLocaleString(undefined, {\n  month: 'long',\n  year: 'numeric',\n})")).toHaveLength(1)
    expect(violations("x = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })")).toHaveLength(0)
    expect(violations("x = n.toLocaleString('en')")).toHaveLength(0)
    expect(violations('x = total.toLocaleString()')).toHaveLength(0)
    expect(violations('x = n.toLocaleString(undefined, { maximumFractionDigits: 1 })')).toHaveLength(0)
  })
})
