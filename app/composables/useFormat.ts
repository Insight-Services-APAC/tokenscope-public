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

import { toolLabel } from '#shared/usage/surface'
import { githubSurfaceAdapter } from '#shared/usage/github-surface'

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

/**
 * A DURATION in milliseconds, at the precision the number deserves: sub-second
 * work keeps its milliseconds (`947ms`), seconds-scale work reads in seconds
 * (`5.3s`), anything past a minute is `m:ss`. Null / non-finite is an em-dash —
 * a run with no recorded duration is not a run that took 0 ms.
 *
 * Used by the worker-run drill-down (docs/design/alert-diagnosability.md D5),
 * where the difference between 288 ms and 5 293 ms is the whole diagnosis.
 */
export function fmtDurationMs(ms: number | string | null | undefined): string {
  if (ms == null || ms === '') return EM_DASH
  const v = Number(ms)
  if (!Number.isFinite(v)) return EM_DASH
  if (Math.abs(v) < 1000) return `${Math.round(v)}ms`
  if (Math.abs(v) < 60_000) return `${(v / 1000).toFixed(1)}s`
  const total = Math.round(v / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
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
 * Like `fmtPct`, but the two open bands either side of the absolutes are named
 * as bands rather than rounded INTO an absolute — the lane-bar tooltip/legend
 * convention (#142; shared by FinanceCouTable, the practice bill-by-surface
 * card, OtherSurfacesPanel and BudgetCoverageNote):
 *
 *   - `(0, 1%)`   → `<1%`, never a rounded-away `0%`
 *   - `(99%, 1)`  → `>99%`, never a rounded-up `100%`
 *
 * Both guards exist for one reason. Every caller renders a PART's share of a
 * whole, so at 0 decimal places a reader takes `0%` to mean "none of it" and
 * `100%` to mean "all of it". Rounding may not manufacture either claim: a
 * $400 remainder on a $100,000 denominator is 99.6%, and printing that as
 * `100%` tells the reader nothing is left over when $400 is.
 *
 * `0` and `1` themselves are passed through — they ARE the absolutes, and
 * naming them is the point. So is anything above `1`: an over-100% share
 * (a quota overrun) is a real reading, not a rounding artefact, and reads
 * `125%`. Non-finite input falls back to an em-dash like every formatter
 * above rather than rendering `NaN%` into a governance sentence.
 */
export function fmtSharePct(p: number): string {
  if (!Number.isFinite(p)) return EM_DASH
  if (p > 0 && p < 0.01) return '<1%'
  if (p > 0.99 && p < 1) return '>99%'
  return `${Math.round(p * 100)}%`
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
/*
 * Tool -> label, from the SAME registries the server classifies on.
 *
 * This function used to be two branches: anything containing "copilot" was
 * Copilot, and EVERYTHING ELSE was "Claude Code". So `claude-ai`,
 * `claude-office`, `claude-cowork` and `claude-design` all rendered as "Claude
 * Code" — including side by side on the surface-split card, which printed
 * "Claude Code 75% · Claude Code 25%" and made the one card whose entire
 * subject is WHICH SURFACE unreadable.
 *
 * That is the mirror image of the defect the vendor classifier
 * (`server/reporting/vendor-split.ts`) was written to fix: the same four
 * surfaces, swept into one bucket by hand-written literals instead of the
 * canon's sets. It is fixed the same way — read the registry, so a surface
 * labels correctly the day it is registered rather than the day someone
 * remembers to extend an `if`.
 *
 * Unknown tools fall back to the raw key (via `toolLabel`), never to a vendor's
 * name: an unrecognised surface is unrecognised, not Claude Code.
 */
const GITHUB_TOOL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  githubSurfaceAdapter.lanes.flatMap((l) => l.tools.map((t) => [t, l.label])),
)

export function clientMeta(tool: string): { icon: string; name: string } {
  const t = (tool || '').toLowerCase()
  const gh = GITHUB_TOOL_LABELS[t]
  if (gh) return { icon: 'logos:github-copilot', name: gh }
  if (t.includes('copilot') || t === 'cop') return { icon: 'logos:github-copilot', name: 'Copilot' }
  return { icon: 'logos:claude-icon', name: toolLabel(t) }
}

export function useFormat() {
  return { fmtUsd, fmtTokens, fmtTimeAgo, fmtPct, signedPct, clientMeta }
}
