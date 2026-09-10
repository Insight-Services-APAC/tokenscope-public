/*
 * csvEscape — CSV cell escape with formula-injection mitigation.
 *
 * Per OWASP CSV Injection (CWE-1236 / sub-CWE-77): cells whose first
 * character is one of `=+-@\t\r` are interpreted as formulas by Excel /
 * Calc / Sheets. Prepend a single quote so the value is rendered as a
 * literal string. Then handle the standard CSV escaping (commas,
 * quotes, newlines).
 *
 * Centralised here so every CSV-emitting endpoint shares one
 * implementation; the security-audit sweep mandated this.
 */
export function csvEscape(v: string): string {
  let value = v
  if (value.length > 0 && /^[=+\-@\t\r]/.test(value)) {
    value = `'${value}`
  }
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/**
 * A `#` metadata header line, escaped as ONE cell.
 *
 * Escaping only the interpolated LABEL does not work, and that was the first
 * attempt at this: `# tokenscope … scope="APAC,=cmd…"` does not START the field
 * with a quote, so a CSV parser treats the comma as a delimiter anyway and the
 * next cell begins with `=`. The quote has to open the field, which means the
 * whole line is the cell.
 *
 * The line always begins with `#`, so it can never itself be read as a formula;
 * what this contains is the label's commas, quotes and newlines, any of which
 * would otherwise manufacture extra cells or extra ROWS in someone's Excel.
 */
export function csvMetaLine(line: string): string {
  return csvEscape(line)
}
