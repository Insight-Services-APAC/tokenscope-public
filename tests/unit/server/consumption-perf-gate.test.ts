// @vitest-environment node
/*
 * Performance gate (brief §6.5): the consumption/project dashboards read
 * attribution_AGGREGATE, never the raw ledger — at 3,000 developers a
 * ledger scan in a dashboard path is a regression. The single sanctioned
 * exception lives in server/usage/consumption.ts (per-project DETAIL
 * reads: member contribution, activity mix, untagged pressure — one
 * project, month-bounded, index-served).
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

const DASHBOARD_HANDLERS = [
  'server/api/v1/me/consumption.get.ts',
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
    // Exactly three month-bounded, single-project ledger reads are allowed
    // (member contribution, activity mix, untagged pressure). A fourth read
    // needs an aggregate dimension instead — fail loudly here.
    const src = norm(read('server/usage/project-detail.ts'))
    const matches = src.match(/from attribution_record/g) ?? []
    expect(matches.length).toBe(3)
    // Each must be month-bounded.
    const monthBounds = src.match(/date_trunc\('month', now\(\)/g) ?? []
    expect(monthBounds.length).toBeGreaterThanOrEqual(3)
  })
})
