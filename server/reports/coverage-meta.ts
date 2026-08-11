/*
 * Report coverage metadata (Workstream D, requirement 6 — NOT the rest of Workstream
 * E). Exposes a GitHub enterprise-org coverage marker on `ReportMeta`, mirroring the
 * existing `providerStates` settlement marker (server/reports/settling.ts):
 * reads-only, persisted-only (coverage-store.ts — no live network call on a report
 * page load), and NEVER fabricates a denominator.
 *
 * SUPPRESSION RULE. A report can span MULTIPLE GitHub enterprises. The aggregate
 * denominator is only ever non-null when EVERY relevant enterprise's own census is
 * currently available, uncapped, AND not stale — the weakest link governs, exactly
 * like a single enterprise's own denominator suppression (coverage.ts
 * summariseEnterpriseCoverage). One enterprise with unknown coverage makes the WHOLE
 * report's completeness claim unknown, never a partial "N of M" that quietly excludes
 * the enterprise we couldn't classify.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { loadAllPersistedCoverage } from '../reconciliation/coverage-store'
import type { ReportCoverageMeta } from '../../shared/reports/types'

type Db = PostgresJsDatabase<Record<string, unknown>>

/**
 * Build the coverage marker for a report response's `meta.coverage`. Reads ONLY the
 * persisted latest observation (coverage-store.ts) — never a live probe, so this is
 * safe on every report page load. Never throws: a read failure degrades to
 * `applicable: false` (the same "we cannot claim completeness" signal a genuine
 * absence of GitHub data would produce) rather than breaking the whole report.
 */
export async function reportCoverageMeta(db: Db): Promise<ReportCoverageMeta> {
  try {
    const all = await loadAllPersistedCoverage(db)
    if (all.length === 0) {
      return { applicable: false, denominator: null, connected: 0, nonConnected: 0, stale: false }
    }
    let denominatorKnown = true
    let denominator = 0
    let connected = 0
    let nonConnected = 0
    let stale = false
    for (const ent of all) {
      if (!ent.census.available || ent.census.capped || ent.census.stale) denominatorKnown = false
      if (ent.census.stale) stale = true
      if (denominatorKnown && ent.census.orgCount != null) denominator += ent.census.orgCount
      for (const o of ent.orgs) {
        if (o.state === 'connected') connected += 1
        else nonConnected += 1
      }
    }
    return { applicable: true, denominator: denominatorKnown ? denominator : null, connected, nonConnected, stale }
  } catch {
    return { applicable: false, denominator: null, connected: 0, nonConnected: 0, stale: false }
  }
}
