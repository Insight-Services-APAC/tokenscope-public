/*
 * across-view-types — the wire shapes the Across-Regions dashboard reads.
 *
 * The base `AcrossReport` (../across-report-types.ts) now carries `providerSplit`
 * natively, so the former local extension (which composed the field on because
 * the base type predated the per-provider split) has collapsed to a plain
 * re-export. This module is kept as the scope-local import surface so the
 * container + View + subcomponents share ONE import path.
 */
export type {
  AcrossReport,
  AcrossRegionCard,
  AcrossChargebackRegion,
  AcrossDriversResp,
  ConcentrationStats,
} from '../across-report-types'
