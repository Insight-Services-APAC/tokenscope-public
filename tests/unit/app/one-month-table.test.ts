/*
 * RATCHET (#641): short month words come from ONE table
 * (`shared/format/month-words.ts`). An `Intl.DateTimeFormat` or
 * `toLocale*String` call that asks for `month: 'short'` prints the locale's own
 * word, which is "Sept" in current en-GB data and "Sep" in older data, so the
 * same date read differently page to page. Use `formatMonthWords` (or
 * `monthShort` for hand-built strings) instead.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const DIRS = ['app', 'shared', 'server'].map((d) => join(ROOT, d))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name)) out.push(p)
  }
  return out
}

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

const SHORT_MONTH = /\bmonth\s*:\s*['"]short['"]/

export function shortMonthCalls(src: string): number[] {
  const lines: number[] = []
  const re = /((?:new\s+)?Intl\.DateTimeFormat|\.toLocale(?:Date)?String)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (SHORT_MONTH.test(argsAt(src, m.index + m[0].length - 1))) {
      lines.push(src.slice(0, m.index).split('\n').length)
    }
  }
  return lines
}

describe('one month table (#641)', () => {
  it('no formatter outside month-words.ts asks Intl for a short month', () => {
    const bad: string[] = []
    for (const dir of DIRS) {
      for (const file of walk(dir)) {
        const rel = relative(ROOT, file)
        if (rel === 'shared/format/month-words.ts') continue
        for (const line of shortMonthCalls(readFileSync(file, 'utf8'))) bad.push(`${rel}:${line}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('catches the shapes it exists for', () => {
    expect(shortMonthCalls(`new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(t)`)).toEqual([1])
    expect(shortMonthCalls(`d.toLocaleString('en-US', {\n  month: "short", timeZone: 'UTC' })`)).toEqual([1])
    expect(shortMonthCalls(`new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(t)`)).toEqual([])
    expect(shortMonthCalls(`Intl.DateTimeFormat('en-GB', { month: 'short' }).format(t)`)).toEqual([1])
    expect(shortMonthCalls(`formatMonthWords('en-GB', { month: 'short' }, t)`)).toEqual([])
  })
})
