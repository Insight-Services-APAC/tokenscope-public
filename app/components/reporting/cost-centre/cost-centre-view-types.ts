/*
 * cost-centre-view-types — the wire shapes the rebuilt Cost-Centre budget tracker
 * reads.
 *
 * The base `CostCentreReport` (../cost-centre-report-types.ts) predates the
 * whole-scope KPI/RAG rollup: `/reports/cost-centres` now returns a `summary`
 * block (server/reporting/cost-centres.ts → summariseCostCentres) that the base
 * type does not declare. Rather than edit a file this track does not own (mirroring
 * the Across scope's `across/across-view-types.ts` convention), we compose the
 * extra field here from the canonical `CostCentreSummary` in `#shared/reports/types`.
 * When the base type catches up this local extension collapses to a re-export.
 */
import type { CostCentreSummary, ActiveTrend, UsageSurfaceWeeklyCell } from '#shared/reports/types'
import type { PerDeveloperSeries } from '#shared/reports/per-developer'
import type { CostCentreReport as BaseCostCentreReport } from '../cost-centre-report-types'

/** The Cost-Centre grid report as the endpoint actually returns it (base + summary). */
export interface CostCentreReport extends BaseCostCentreReport {
  /** Whole-scope KPI strip + RAG count rollup (over / near / on-track / no-budget). */
  summary: CostCentreSummary
}

export type {
  CostCentreCard,
  CostCentreDrill,
  CostCentreDriverList,
} from '../cost-centre-report-types'

/*
 * BAND 2's payload — GET /reports/cost-centres/{ccId}/trend.
 *
 * Its `window` is the ROLLING band (~60 days to the settled edge), NOT the month
 * the drill covers, and the cards label themselves from it so a reader is never
 * left to assume the two frames agree. Deliberately a separate response from the
 * drill: they answer over different windows, and one object carrying two frames
 * is how a card ends up captioned with the other one's dates.
 */
export interface CostCentreTrend {
  window: { from: string; to: string }
  windowDays: number
  series: { day: string; key: 'claude-code' | 'copilot-cli' | 'copilot-agent' | 'other'; value: number }[]
  activeTrend: ActiveTrend
  usageWeeklyLanes: UsageSurfaceWeeklyCell[]
  perDeveloper: PerDeveloperSeries
}
