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
import type { CostCentreSummary } from '#shared/reports/types'
import type { CostCentreReport as BaseCostCentreReport } from '../cost-centre-report-types'

/** The Cost-Centre grid report as the endpoint actually returns it (base + summary). */
export interface CostCentreReport extends BaseCostCentreReport {
  /** Whole-scope KPI strip + RAG count rollup (over / near / on-track / no-budget). */
  summary: CostCentreSummary
}

export type { CostCentreCard, CostCentreDrill } from '../cost-centre-report-types'
