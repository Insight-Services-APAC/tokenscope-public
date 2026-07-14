/*
 * csvEscape — formula-injection + standard CSV escape unit test.
 *
 * Pins the shared helper in server/utils/csv-escape.ts. Lessons-
 * baked-in says every CSV-emitting endpoint must use this; the
 * security-audit sweep mandated the helper exist as a single source
 * of truth.
 */
import { describe, it, expect } from 'vitest'
import { csvEscape } from '../../../server/utils/csv-escape'

describe('csvEscape', () => {
  it('returns plain values unchanged', () => {
    expect(csvEscape('abc')).toBe('abc')
    expect(csvEscape('123')).toBe('123')
    expect(csvEscape('')).toBe('')
  })

  it('prefixes formula-leading characters with a single quote', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvEscape('+1+1')).toBe("'+1+1")
    expect(csvEscape('-5')).toBe("'-5")
    expect(csvEscape('@mention')).toBe("'@mention")
  })

  it('handles tab + CR as formula leaders, wrapping only when the value also contains an embedded special', () => {
    // \t is a formula-leader but isn't itself in the wrap-trigger set,
    // so it just gets prefixed.
    expect(csvEscape('\tleading-tab')).toBe("'\tleading-tab")
    // \r is in the wrap-trigger set so the value gets wrapped after
    // the formula prefix.
    expect(csvEscape('\rcr')).toBe('"\'\rcr"')
  })

  it('does not double-prefix when value already starts with apostrophe', () => {
    expect(csvEscape("'safe")).toBe("'safe")
  })

  it('wraps values containing commas, quotes, or newlines and escapes embedded quotes', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })

  it('combines formula prefix and quote wrapping when both apply', () => {
    expect(csvEscape('=A1,B1')).toBe('"\'=A1,B1"')
  })
})
