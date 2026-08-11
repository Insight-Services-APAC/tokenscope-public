/*
 * The BASE ALLOWANCE — the product's soft cap on a teammate's UNALLOCATED spend.
 *
 * ONE GLOBAL CONSTANT, not per-teammate configuration: `NUXT_BASE_ALLOWANCE_USD`,
 * defaulting to 100. Per-teammate or per-region allowances would be a change to
 * the allowance itself, not to any surface that reads it.
 *
 * WHY IT IS A FUNCTION AND NOT A MODULE CONSTANT. It is read at CALL time, never
 * at import time. The value is an env var, and both the deployed process (which
 * may be started before the var is materialised from Key Vault) and the test
 * suite (tests/integration/me/usage-extended.test.ts sets it between cases)
 * depend on a later read seeing a later value. A module-level `const` would
 * freeze whatever was set when the first importer loaded.
 *
 * WHY IT IS EXTRACTED. Two surfaces apply this policy and they must not be able
 * to disagree: the developer's own page derives `over_soft_cap` from it
 * (server/utils/me-queries.ts) and the cost-centre lead's "over the soft cap"
 * card applies the SAME policy to the manager's view
 * (server/reporting/engine/over-soft-cap.ts). A second hand-rolled parse is how
 * a developer comes to see an "Over" badge on a row their manager's card does
 * not list — the two would be answering the same question with different
 * arithmetic. See docs/design/reporting-consolidation/04-prototype-delta.md §5.
 */

/** The allowance when `NUXT_BASE_ALLOWANCE_USD` is unset, unparseable or negative. */
export const BASE_ALLOWANCE_DEFAULT_USD = 100

/**
 * The base allowance in USD.
 *
 * `0` IS A LEGAL VALUE and is preserved (the guard is `>= 0`, not `> 0`) — an
 * operator who sets the cap to zero means "no unallocated spend is fine", and
 * silently substituting 100 would ignore them. Readers must handle it: a cap of
 * zero has no meaningful multiple, and `over-soft-cap.ts` says so rather than
 * dividing by it.
 */
export function baseAllowanceUsd(): number {
  const parsed = Number(process.env.NUXT_BASE_ALLOWANCE_USD)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : BASE_ALLOWANCE_DEFAULT_USD
}
