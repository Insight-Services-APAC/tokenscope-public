/*
 * The words for tier-2 ("advisory") spend (#600), one place so My usage, the
 * project page and the session drawers cannot drift. Approved by the product
 * owner. Each claim is traced to code in the PR that introduced it:
 *   the figure      SUM(cost_usd) WHERE fidelity_tier = 'tier-2'
 *   the three cases azure-monitor-reader.ts: Copilot, an unregistered or
 *                   indicative Claude org, and a backfill re-send
 * "Does not check" is said only of Claude organisations: the reconciliation
 * engine compares Copilot's ai-credit lane, and excludes only the token lane.
 */
export const ADVISORY_INFO =
  "Usage is marked indicative when it is from Copilot, was sent again later to fill a gap, or comes from a Claude organisation TokenScope does not check against the provider's figures."

/** `amount` is already formatted; `span` reads after "of": "the last 30 days", "this period". */
export function advisorySentence(amount: string, span: string): string {
  return `${amount} of ${span} is indicative: worked out from the devices' own reports, and it may differ from what the provider records.`
}
