/*
 * regional-view-types — the wire shapes the rebuilt Regional dashboard reads.
 *
 * The base `RegionalReport` (../regional-report-types.ts, owned by the foundation
 * phase) predates the per-provider split: the `/reports/regional` endpoint now
 * returns a `providerSplit` block (server/reporting/regional.ts →
 * fetchRegionalProviderSplit) that the base type does not yet declare. Rather than
 * edit a file this track does not own, we compose the extra field here from the
 * CANONICAL `ProviderSplit` in `#shared/reports/types` (mirroring the sibling
 * across-view-types.ts). When the base type catches up, this local extension
 * collapses to a plain re-export.
 */
import type { ProviderSplit } from '#shared/reports/types'
import type { RegionalReport as BaseRegionalReport } from '../regional-report-types'

/** The Regional report as the endpoint actually returns it (base + providerSplit). */
export interface RegionalReport extends BaseRegionalReport {
  /** Region-scoped per-provider usage split (spend + active users). Sums back to genuine. */
  providerSplit: ProviderSplit
}

export type { RegionalDriversResp, RegionalTrendResp } from '../regional-report-types'
