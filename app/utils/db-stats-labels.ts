/*
 * Display formatting for the db-performance panel's statistics ages.
 *
 * Outside the SFC so it is testable without mounting a 2,000-line component.
 *
 * Every function takes the server's `generatedAt` and reads no clock of its
 * own: the server owns the clock and the client only displays it
 * (docs/design/clock-and-day-boundary.md).
 */

/*
 * How far back the counters reach, as a COMPLETE clause.
 *
 * RETURNS A WHOLE SENTENCE. The template interpolates it and adds nothing —
 * splitting a sentence between a template and a function makes every branch
 * responsible for grammar in a context the function cannot see, and the null
 * and unavailable branches read as nonsense when it is split.
 *
 * `now` is the payload's own generatedAt, never the browser clock — the server
 * owns the clock and a locally-computed age would label a window the server is
 * not describing.
 */
export function statsWindowLabel(
  w: { databaseSince: string | null; available: boolean } | undefined,
  generatedAt: string,
): string {
  if (!w || !w.available) return 'The age of these counters could not be read.'
  if (!w.databaseSince) return 'These counters have never been reset.'
  const ms = Date.parse(generatedAt) - Date.parse(w.databaseSince)
  if (!Number.isFinite(ms)) return 'These counters have never been reset.'
  // Clamped: generatedAt is captured before the reads, so a reset landing
  // mid-request can be newer than it. A negative age is never worth rendering.
  const clamped = Math.max(0, ms)
  const h = clamped / 3_600_000
  const age =
    h < 1
      ? `${Math.max(1, Math.round(clamped / 60_000))} min`
      : h < 48
        ? `${Math.round(h)} h`
        : `${Math.round(h / 24)} days`
  return `Counts below run back to the last database-wide reset, ${age} ago.`
}

/** Analyze state for one table, or '' when the server did not report it. */
export function analyzeLabel(r: { lastAnalyzed?: string | null; neverAnalyzed?: number; rowsChangedSinceAnalyze?: number }, generatedAt: string): string {
  if (r.neverAnalyzed === undefined && r.lastAnalyzed === undefined) return ''
  if (r.neverAnalyzed) return `NEVER analysed (${r.neverAnalyzed})`
  if (!r.lastAnalyzed) return 'never analysed'
  const ms = Date.parse(generatedAt) - Date.parse(r.lastAnalyzed)
  // Clamped for the same reason as the window: a concurrent ANALYZE can land
  // after generatedAt was captured, and "analysed -1h ago" helps nobody.
  const h = Number.isFinite(ms) ? Math.max(0, ms) / 3_600_000 : NaN
  const age = !Number.isFinite(h) ? '?' : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`
  const drift = r.rowsChangedSinceAnalyze ?? 0
  return drift > 0 ? `analysed ${age} ago · ${drift.toLocaleString()} rows since` : `analysed ${age} ago`
}

