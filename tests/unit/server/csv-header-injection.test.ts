/*
 * CSV headers escape the scope label too (MDASH: formula injection).
 *
 * A leading `#` makes the first cell inert, so the header LOOKS safe. But the
 * label is a Business-Unit name a region admin controls, and a comma in it
 * splits the line into further cells — the next of which can begin with `=`,
 * `+`, `-` or `@`. Finance opens the export in Excel and that cell is a live
 * formula. Every DATA cell already went through csvEscape; the headers did not.
 */
import { describe, it, expect } from 'vitest'
import { csvEscape, csvMetaLine } from '../../../server/utils/csv-escape'

const HOSTILE = 'APAC,=cmd|\'/c calc\'!A1'

describe('csvEscape neutralises a hostile Business-Unit name', () => {
  it('quotes a label containing a comma so it cannot become extra cells', () => {
    const out = csvEscape(HOSTILE)
    expect(out.startsWith('"'), 'a comma must be quoted into ONE cell').toBe(true)
    // The whole hostile value stays inside one quoted cell.
    expect(out).toContain("=cmd")
    expect(out.split('","').length, 'must not split into multiple cells').toBe(1)
  })

  it("prefixes a leading formula character so Excel treats it as text", () => {
    // No embedded quotes here: a value containing " is also comma/quote-wrapped,
    // which puts the guard prefix INSIDE the quotes rather than at index 0.
    for (const lead of ['=', '+', '-', '@']) {
      expect(csvEscape(`${lead}SUM(A1:A9)`).startsWith("'")).toBe(true)
    }
    // ...and when it IS wrapped, the guard is still present.
    expect(csvEscape('=HYPERLINK("http://x")')).toContain("'=HYPERLINK")
  })

  it('leaves an ordinary label untouched', () => {
    expect(csvEscape('APAC Services')).toBe('APAC Services')
  })
})

describe('every CSV metadata header is escaped as a WHOLE cell', () => {
  /*
   * The first attempt escaped only the interpolated label, which does not work:
   * `# tokenscope … scope="APAC,=cmd…"` does not START the field with a quote,
   * so a parser splits on the comma anyway and the next cell begins with `=`.
   * The quote has to open the field, so the whole line is the cell.
   */
  it('no `# tokenscope` header line escapes its exposure', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const dir = 'server/reporting'
    const missed: string[] = []
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(`${dir}/${name}`, 'utf8')
      src.split('\n').forEach((line, i) => {
        if (!line.includes('`# tokenscope')) return
        // the wrap sits on the line above, or inline
        const prev = src.split('\n')[i - 1] ?? ''
        if (!line.includes('csvMetaLine') && !prev.includes('csvMetaLine')) {
          missed.push(`${name}:${i + 1}`)
        }
      })
    }
    expect(missed, `unescaped CSV metadata headers: ${missed.join(', ')}`).toEqual([])
  })

  it('the whole line becomes one quoted cell when the label is hostile', () => {
    const line = `# tokenscope regional trend · month=2026-09 · scope=${HOSTILE}`
    const out = csvMetaLine(line)
    expect(out.startsWith('"'), 'the quote must OPEN the field').toBe(true)
    expect(out.endsWith('"')).toBe(true)
    // and the payload is inside it, not a cell of its own
    expect(out).toContain('=cmd')
  })
})
