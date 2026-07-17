/*
 * Shared display formatters + the AI-client (tool) brand mapping. Extracted from
 * the dashboard so the homepage, the tag dialog, and future views format money,
 * tokens, relative time, and client marks identically.
 *
 * SYS-5 / FE-12: this is the ONLY place money/token/time formatting lives —
 * per-page reimplementations drifted (rounding, separators, tiers). All
 * formatters guard against missing/malformed input and fall back to an em-dash
 * instead of rendering "$NaN" / "NaNd ago" into financial columns.
 */

const EM_DASH = '—'

export interface FmtUsdOptions {
  /** Round to whole dollars (finance / rollup tables). Default: cents. */
  whole?: boolean
}

export function fmtUsd(
  n: number | string | null | undefined,
  opts: FmtUsdOptions = {},
): string {
  if (n == null || n === '') return EM_DASH
  const v = Number(n)
  if (!Number.isFinite(v)) return EM_DASH
  const digits = opts.whole ? 0 : 2
  const abs = Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${v < 0 ? '-' : ''}$${abs}`
}

export function fmtTokens(n: number | string | null | undefined): string {
  if (n == null || n === '') return EM_DASH
  const v = Number(n)
  if (!Number.isFinite(v)) return EM_DASH
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(v)
}

export function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return EM_DASH
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return EM_DASH
  const ms = Date.now() - t
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

export interface FmtPctOptions {
  /** Decimal places on the percentage. Default: 0 (whole percent). */
  digits?: number
}

/**
 * Format a FRACTION in [0,1] as a percentage — `0.423 → "42%"`. Matches the
 * existing practice-page `pct()` convention (input is a 0..1 share, e.g.
 * `DriverRow.sharePct`, `dominantModel().share`). Guards non-finite → em-dash.
 */
export function fmtPct(
  n: number | string | null | undefined,
  opts: FmtPctOptions = {},
): string {
  if (n == null || n === '') return EM_DASH
  const v = Number(n)
  if (!Number.isFinite(v)) return EM_DASH
  return `${(v * 100).toFixed(opts.digits ?? 0)}%`
}

/**
 * Like `fmtPct`, but a tiny non-zero share reads `<1%` instead of rounding to
 * a misleading `0%` — the lane-bar tooltip/legend convention (#142; shared by
 * FinanceCouTable and the practice bill-by-surface card).
 */
export function fmtSharePct(p: number): string {
  return p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`
}

/**
 * Like `fmtPct` but always carries an explicit sign — `+0.12 → "+12%"`,
 * `-0.12 → "-12%"`. For MoM / vs-average deltas. Non-finite → em-dash.
 */
export function signedPct(
  n: number | string | null | undefined,
  opts: FmtPctOptions = {},
): string {
  if (n == null || n === '') return EM_DASH
  const v = Number(n)
  if (!Number.isFinite(v)) return EM_DASH
  const sign = v >= 0 ? '+' : '-'
  return `${sign}${(Math.abs(v) * 100).toFixed(opts.digits ?? 0)}%`
}

// Map a tool code (claude-code / copilot-cli, or the CC/COP shorthand) to its
// brand mark + name — the same client language as the Connect buttons.
export function clientMeta(tool: string): { icon: string; name: string } {
  const t = (tool || '').toLowerCase()
  if (t.includes('copilot') || t === 'cop') return { icon: 'logos:github-copilot', name: 'Copilot' }
  return { icon: 'logos:claude-icon', name: 'Claude Code' }
}

export function useFormat() {
  return { fmtUsd, fmtTokens, fmtTimeAgo, fmtPct, signedPct, clientMeta }
}
