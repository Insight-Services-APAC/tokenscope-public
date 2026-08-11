/*
 * provenance — the `usage_provenance` axis on `v_complete_usage` (Workstream A,
 * migration 0101; docs/design/usage-completeness-and-provider-governance.md §3.1,
 * docs/wiki/Reporting.md §2 Axis 1).
 *
 * A row's PROVENANCE (how we learned of the spend) is independent of its
 * `identity_state` (whether the teammate/device binding is confirmed — mig
 * 0089). Keeping the two axes separate is deliberate: identity_state answers
 * "do we trust WHO this is", provenance answers "HOW do we know this spend
 * happened". Conflating them was the exact drift this axis exists to prevent
 * (docs/wiki/Reporting.md §2 Axis 1).
 *
 *   otel-emitted   — arm 1, `attribution_record`: a client emitted it to us
 *                    directly (Claude Code from an enrolled instance).
 *   api-reconciled — arm 2, `unaccounted_usage`: a provider API told us about a
 *                    gap OTel did not capture, for an ordinarily-taggable tool.
 *   provider-usage — arm 3, the ingest-only completeness union (migration
 *                    0101, A3): genuine provider usage truth for a tool that
 *                    can NEVER be OTel-emitted or reconciled into a taggable
 *                    record (the non-Code Claude surfaces, `copilot-agent`).
 *                    Rows in this lane carry `model IS NULL` because
 *                    TokenScope does not carry a model down this lane — NOT
 *                    because attribution failed, and NOT (as this comment
 *                    previously asserted) because the source API lacks a model
 *                    dimension. A live capture on 2026-08-01 disproved that for
 *                    the Claude surfaces: Enterprise Analytics returns `model`
 *                    on every row, `product: 'chat'` included. So the NULL is
 *                    ours to explain, and must still never render as an
 *                    attribution failure. See shared/reports/model-attribution.ts.
 */

export const USAGE_PROVENANCE_VALUES = ['otel-emitted', 'api-reconciled', 'provider-usage'] as const

export type UsageProvenance = (typeof USAGE_PROVENANCE_VALUES)[number]

/** True for arm 3 (the ingest-only completeness union) — genuine provider
 *  usage truth for which TokenScope carries no model, never an attribution gap. */
export function isProviderUsageProvenance(
  usageProvenance: string | null | undefined,
): usageProvenance is 'provider-usage' {
  return usageProvenance === 'provider-usage'
}
