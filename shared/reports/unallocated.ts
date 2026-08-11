/*
 * unallocated — the ONE reusable constant/helper for an explicit "no
 * cost-owning-unit-mapped" row across reports (requirement 6). Before this,
 * `finance.ts`, `regional.ts` and `fetchOverageDrivers` each hand-typed their
 * own key/label pair for the identical NULL-`cost_owning_unit_id` bucket
 * (`'Unallocated'` vs a synthetic `'unallocated'`/`'__unallocated'` key) — a
 * drift risk with no functional difference. Every report that retains a
 * NULL-CoU bucket (rather than silently dropping it — ADR-0010 rule 3) reads
 * its key/label from here.
 *
 * Pure TS, no runtime deps — safe in `shared/` for both server + client.
 */

/** Synthetic driver/row key for the explicit "no cost-owning unit" bucket. */
export const UNALLOCATED_KEY = '__unallocated'

/** Display label for the explicit "no cost-owning unit" bucket. */
export const UNALLOCATED_LABEL = 'Unallocated'
