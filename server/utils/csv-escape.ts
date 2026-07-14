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
