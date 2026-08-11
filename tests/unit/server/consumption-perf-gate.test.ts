// @vitest-environment node
/*
 * Performance gate (brief §6.5): the consumption/project dashboards read
 * attribution_AGGREGATE for series/mix, never the raw ledger — at 3,000
 * developers a ledger scan in a dashboard path is a regression.
 *
 * The sanctioned raw-ledger exception in server/usage/project-detail.ts is now
 * ONE query, not three. Member contribution and activity mix were grains of the
 * project total and moved to the §A lane (server/usage/complete-spend.ts) with
 * the headline; only untagged pressure still needs the ledger, because it counts
 * CONVERSATIONS and `v_complete_usage` has no session-id axis.
 *
 * Exception #2 (developer-pages W0c, D10): server/usage/session-economics.ts —
 * the /usage Session-economics card's per-conversation distribution. Same
 * reason (it counts CONVERSATIONS; the view has no session-id axis), same
 * discipline (ONE query, teammate-scoped, bounded on BOTH sides by the
 * caller's window). The gate is extended, never dodged.
 *
 * Same enforcement pattern as the finance-reportable gate: source-grep,
 * whitespace-normalised so reformatting can't sneak past.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()
/** Strip block + line comments (line-comment strip skips `https://` URLs). */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const DASHBOARD_HANDLERS = [
  'server/api/v1/me/usage.get.ts',
  'server/api/v1/me/projects/summary.get.ts',
  'server/api/v1/me/projects/[code]/index.get.ts',
  'server/api/v1/me/insights/[id]/ack.post.ts',
]

describe('consumption perf gate', () => {
  it('dashboard handlers contain NO SQL against attribution_record', () => {
    for (const f of DASHBOARD_HANDLERS) {
      expect(norm(read(f)), `${f} must not read attribution_record`).not.toContain(
        'from attribution_record',
      )
    }
  })

  it('the aggregate read-models (consumption, insights) never touch the ledger', () => {
    expect(norm(read('server/usage/consumption.ts'))).not.toContain('from attribution_record')
    expect(norm(read('server/usage/insights.ts'))).not.toContain('from attribution_record')
  })

  it('project-detail.ts ledger reads stay within the sanctioned exception set', () => {
    // Exactly ONE month-bounded, single-project ledger read is allowed
    // (untagged pressure — a CONVERSATION count, which the §A lane cannot
    // express). A second read is either a project-spend grain, which belongs on
    // complete-spend.ts, or it needs an aggregate dimension — fail loudly here.
    const src = norm(read('server/usage/project-detail.ts'))
    const matches = src.match(/from attribution_record/g) ?? []
    expect(matches.length).toBe(1)
    /*
     * It must be bounded on BOTH sides by the caller's window. It used to be
     * bounded from below only (`ts_event >= date_trunc('month', now())`), which
     * this gate accepted as "month-bounded" — so the one ledger read in the
     * dashboard path scanned every future-dated row in the table AND quoted them
     * under a month-to-date figure. A lower bound alone is not a window.
     */
    expect(src).toContain('ar.ts_event >= ${')
    expect(src).toContain('ar.ts_event < ${')
    expect(
      norm(stripComments(read('server/usage/project-detail.ts'))),
      'must take the window from the caller, not compute its own',
    ).not.toContain("date_trunc('month', now()")
  })

  it('session-economics.ts ledger reads stay within sanctioned exception #2 (W0c D10)', () => {
    // Exactly ONE teammate-scoped, both-sides-bounded ledger read is allowed —
    // the per-conversation distribution, which the §A lane cannot express
    // because `v_complete_usage` has no session-id axis. A second read is a
    // spend grain that belongs on complete-spend.ts — fail loudly here.
    const src = norm(read('server/usage/session-economics.ts'))
    const matches = src.match(/from attribution_record/g) ?? []
    expect(matches.length).toBe(1)
    // Bounded on BOTH sides by the caller's window (a lower bound alone is not
    // a window — the project-detail lesson, verbatim).
    expect(src).toContain('ar.ts_event >= ${')
    expect(src).toContain('ar.ts_event < ${')
    expect(
      norm(stripComments(read('server/usage/session-economics.ts'))),
      'must take the window from the caller, not compute its own',
    ).not.toContain("date_trunc('month', now()")
  })

  it('the project-spend seam never reads the ledger or the OTel-only rollup', () => {
    // The one definition of project spend must stay on the §A lane. If either
    // of these ever appears here, five surfaces silently revert at once.
    const src = norm(read('server/usage/complete-spend.ts'))
    expect(src).not.toContain('from attribution_record')
    expect(src).not.toContain('from attribution_aggregate')
    expect(src).toContain('v_complete_usage')
  })

  it('the project page model axis reads the §A lane, not the OTel-only aggregate (07 D7)', () => {
    // mix.by_model / series_by_model must come from complete-spend.ts's lane
    // reads: the aggregate is OTel-only, so wiring either back to it makes a
    // tagged fill day's money reach the headline while its models vanish from
    // the mix beside it — the exact defect D7 removes.
    const src = norm(stripComments(read('server/api/v1/me/projects/[code]/index.get.ts')))
    expect(src).toContain('completeprojectmodelmix(')
    expect(src).toContain('completeprojectmodelseries(')
    expect(src).toContain('by_model: modelmix')
    expect(src, 'the aggregate model series must not be wired back in').not.toContain(
      'fetchmodelseries(',
    )
  })

  it('no project surface computes MTD spend from the aggregate', () => {
    // `fetchMtdSpend` was the aggregate-backed project headline: OTel-only and
    // cron-lagged. Deleted, and pinned deleted — a re-introduction would put
    // the smallest number in the product back above a live table.
    for (const f of [
      'server/usage/consumption.ts',
      'server/api/v1/me/projects/summary.get.ts',
      'server/api/v1/me/projects/[code]/index.get.ts',
      'server/api/v1/me/cost-centres.get.ts',
    ]) {
      expect(norm(read(f)), `${f} must not use fetchMtdSpend`).not.toContain('fetchmtdspend(')
    }
  })
})
