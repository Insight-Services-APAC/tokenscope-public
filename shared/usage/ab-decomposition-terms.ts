/*
 * ab-decomposition-terms — the named terms of the §A/§B delta decomposition.
 *
 * Shared const so the implementation, tests, and future UI card cannot drift.
 * See docs/design/usage-completeness-and-provider-governance.md §1.1 for the
 * design rationale ("Gate on a full decomposition, not a subtraction").
 */

/**
 * The named terms that decompose the §B−§A delta. Each is a signed amount:
 * positive means "this term makes §B exceed §A" (i.e. spend present in §B but
 * absent from §A, or spend removed from §A). Negative means the reverse.
 *
 * By construction: delta = §B − §A = Σ(terms) + residual.
 * The residual MUST be zero if the decomposition is exhaustive.
 *
 * MORE terms than the design's six — count the const below rather than trusting
 * a number written in prose, which has now drifted twice. The design (§1.1)
 * lists "licence lanes" as
 * one term covering the whole Copilot side. That is not decomposable as a single
 * term without becoming a subtraction of two totals, which is exactly what the
 * gate forbids ("Gate on a full decomposition, not a subtraction") — a single
 * copilot term absorbs every Copilot-side discrepancy and forces the residual to
 * zero by construction, so a zero residual would prove nothing. The Copilot side
 * is therefore split along the lane boundary migration 0085 already guarantees
 * (Σ lanes == the invoice):
 *
 *   licenceLanes      — `copilot-license` seat SKUs. A PURE SUM: an idle licensed
 *                       seat is legitimately §A = 0, §B > 0, so this lane has NO
 *                       §A counterpart to subtract and none is subtracted.
 *   copilotUsageGap   — `copilot-usage` measured against
 *                       the §A per-user gross. These lanes DO have an §A
 *                       counterpart, but §B measures them pooled (the enterprise
 *                       invoice) while §A measures them per-user
 *                       (`ai_credit/usage`). The gap between those two grains is a
 *                       real, distinct phenomenon and is named as such rather than
 *                       hidden inside the licence figure.
 *
 *   copilotAgentUsage — a PURE SUM of the coding-agent lane, billed inside the pooled
 *                       `copilot-usage` invoice but is §A-INVISIBLE BY DESIGN:
 *                       migration 0086 excludes it from `v_complete_usage`
 *                       (OTel-invisible, so no attribution rows; ingest_only, so
 *                       no unaccounted rows), and 0085's NAMESPACE RULE denies it
 *                       a §B lane of its own. Left unnamed it would sit inside
 *                       `copilotUsageGap` and be reported as a benign grain
 *                       mismatch, which is a completeness hole wearing the wrong
 *                       label. `copilotUsageGap` is the REMAINDER once this is
 *                       named, which is what keeps it narrow.
 *
 * This split is the finding: the design's six-term prediction is incomplete for
 * the Copilot side.
 *
 * EIGHT, once real data was run: `unreconciledApiLag` was added after the first
 * live run against dev-shaped data returned a $698.53 residual. It is the
 * SYMMETRIC COUNTERPART OF `floor`: the floor names days where OTel over-reads
 * the API, and this names days where the API over-reads OTel but the
 * reconciliation worker has not yet materialised the difference into
 * `unaccounted_usage`, so §A has not caught up while §B already bills it.
 *
 * TEN, once it was noticed that the lag term was a single SIGNED number built by
 * subtracting two estate-wide aggregates. Lag on one (teammate, day) and stale
 * materialisation on another cancelled, so the term could read zero while real
 * reconciliation failure sat underneath it. `unreconciledApiStale` splits the
 * negative direction out: §A carrying MORE than the API now reports, typically
 * late telemetry arriving after a day was reconciled. Opposite phenomena with
 * opposite operator responses, so they are two names, not one signed number.
 *
 * It is a term rather than an alarm because reconciliation lag is normal,
 * expected, and self-healing while the day remains inside the worker's trailing
 * 35-day window (server/workers/usage-reconciliation.ts); an older month needs a
 * backfill before it clears, which is why the card's hint says so rather than
 * promising it clears on its own: any environment whose worker is mid-cycle (every
 * dev box, and production for part of every day) would otherwise show a
 * permanent unexplained gap, and a residual that is never zero teaches operators
 * to ignore the one number on the card that means something is genuinely wrong.
 * When the worker is caught up this term is 0.
 */
/*
 * `quarantine` is retained but pinned at ZERO, and that is a correction rather
 * than dead weight. It once carried the quarantined OTel total as a positive
 * contribution while `floor` carried the same rows negatively, so the pair
 * cancelled: the residual stayed at zero and could not reveal the double-count,
 * but the absolute total the dominance verdict divides by was inflated by twice
 * the quarantined amount, which was enough to reverse the gate's answer on the
 * project's own fixture.
 *
 * Quarantined money moves the gap by nothing, though not by being absent from
 * both sides — that shorter story is wrong, and the fixture disproves it. Two
 * cases, and only the second is an absence:
 *
 *   API corroborates the same (teammate, day). The OTel is out of §A arm 1, but
 *   the reconciliation measures the API against CORROBORATED OTel, which now
 *   excludes those rows, so the amount materialises as unaccounted usage and
 *   RETURNS to §A through arm 2. §B bills the same actual_spend. Present on both
 *   sides, so it cancels.
 *
 *   Nothing corroborates it (a genuine forgery). No actual_spend row exists, so
 *   the API side is zero, the reconciliation produces nothing, and the amount
 *   enters neither §A nor §B.
 *
 * Zero either way, by cancellation in the first case and by absence in the
 * second. The
 * term stays in the list because a reader of a decomposition needs to see that
 * quarantine was considered and why it contributes nothing; the real quantity is
 * returned as `diagnostics.quarantinedOtelUsd`, where a non-zero value is
 * visible and falsifiable instead of cancelling invisibly against another term.
 */
/*
 * ELEVEN, once the gate was run against a chargeback-exempt claude-code day.
 *
 * `chargebackExemptUsage` is the money `chargeback_exempt` removes from §B while
 * leaving it in §A. Every §B lane filters `WHERE NOT chargeback_exempt`
 * (migrations 0073, 0081, 0085), but `v_teammate_usage_daily` carries no such
 * filter, so the reconciliation worker materialises exempt spend into
 * `unaccounted_usage` and it reaches §A through arm 2 regardless. One direction,
 * no counterpart, and before this term existed it landed in the residual.
 *
 * It is NOT a filter bug in this module. The `api_daily` CTEs deliberately do
 * not filter exempt rows, because they model what the reconciliation worker
 * does, and the worker does not filter them either. Adding a filter there would
 * make this module disagree with the system it is measuring. The money is real
 * and one-sided, so it gets a name.
 *
 * The term is correct whether or not the worker has caught up, which is worth
 * stating because the two states look very different:
 *
 *   Materialised. §A carries the amount through arm 2, §B does not, the delta
 *   falls by it, and this term carries it. `unreconciledApiLag` is 0.
 *
 *   Not yet materialised. §A does not carry it and neither does §B, so the delta
 *   is unchanged — but the API row is visible to `unreconciledApiLag`, which
 *   reads it as expected-but-unmaterialised and rises by the same amount. This
 *   term's negative cancels that positive exactly.
 *
 * LATENT IN PRODUCTION TODAY, and that is the dangerous part rather than a
 * reason to defer it. `chargeback_exempt` is currently written only by the
 * Copilot/GitHub path (server/reconciliation/copilot-bill.ts,
 * server/reconciliation/github.ts), whose tools do not reach §A from
 * `actual_spend` at all. Workstream B §4.1 makes the flag the recorded
 * governance verdict for EVERY provider, at which point claude-code rows carry
 * it — so an untermed gate would have started lying at precisely the moment the
 * workstream it guards shipped, and would have reported `residual-non-zero`
 * ("Workstream A must not ship on this reading") as a false blocker while
 * misfiling the money as reconciliation lag, whose operator advice is to
 * backfill a worker that is working perfectly.
 */
/*
 * STILL ELEVEN, but two terms CHANGE SHAPE at the migration-0101 cutover
 * (usage-completeness-and-provider-governance.md §3.1, "the diagnostic changes
 * shape at cutover"). No new term name is added — the count and the two
 * concerns this addendum is about (name, not number) are unaffected.
 *
 * Before 0101, `nonCodeSurfaces` and `copilotAgentUsage` were PURE §B-SIDE
 * SUMS: their lanes were structurally absent from every §A arm (no OTel, and
 * excluded from `v_teammate_usage_daily`), so there was nothing on the §A side
 * to subtract — the term WAS the whole gap, by construction. Migration 0101
 * (A1/A3) gives both lanes a real §A arm (the non-taggable, ingest-only union
 * arm on `v_complete_usage`), so from that migration onward BOTH terms are TRUE
 * (§B − §A) missing-usage amounts, and each reads (approximately) ZERO once its
 * lane is fully covered — the two terms that used to carry the whole
 * dominance verdict in §1.1 are gone, which is the entire point of shipping A.
 * A non-zero reading now means real, current coverage loss, not "the mechanism
 * doesn't exist yet".
 *
 * `chargebackExemptUsage`'s SCOPE narrows at the same cutover for the identical
 * reason, in the opposite direction: it used to exclude the non-Code Claude
 * surfaces (an exempt non-Code row reached NEITHER side, so naming it would
 * have invented a gap); now that those surfaces reach §A via arm 3 while still
 * being exempt-filtered out of §B, an exempt non-Code row is exactly the
 * one-directional shape this term has always existed to name, so it is
 * INCLUDED. `copilot-cli` / `copilot-agent` remain excluded — their §A truth is
 * still `reconciliation_record`, never `actual_spend`, so an exempt
 * `actual_spend` row carrying either tool literal still reaches neither side.
 *
 * See `server/usage/ab-decomposition.ts`'s own per-term comments for the full
 * derivation (why each side of `nonCodeSurfaces`/`copilotAgentUsage` is exempt-
 * excluded so this term and those two never double-count the same dollar) and
 * for the independent, non-summed diagnostics
 * (`codingAgentInSectionAUsd`/`codingAgentRawUsd`,
 * `nonCodeSurfacesInSectionAUsd`/`nonCodeSurfacesRawUsd`) that catch an absent
 * or doubled lane even if some other term's cancellation hid it from the
 * residual.
 */
export const AB_DECOMPOSITION_TERMS = [
  'nonCodeSurfaces',
  'licenceLanes',
  'copilotAgentUsage',
  'copilotUsageGap',
  'quarantine',
  'floor',
  'chargebackExemptUsage',
  'populationDifference',
  'homingLoss',
  'unreconciledApiLag',
  'unreconciledApiStale',
] as const

export type AbDecompositionTermName = (typeof AB_DECOMPOSITION_TERMS)[number]
