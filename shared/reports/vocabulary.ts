/*
 * reports/vocabulary — the user-facing WORDS the reporting layer renders for
 * objects whose wire keys never change.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The product says "Budget" and the reporting layer said "Project" for the same
 * object. A developer tags a session to a **Budget**
 * (`app/components/home/TagSessionDialog.vue`), then opens a report and picks a
 * breakdown called **Project** — the same thing under two names, in two places a
 * single person visits in one sitting.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 * This is a DISPLAY label, never a key. The axis key stays `'project'` on the
 * wire, in `?axis=` URLs, in the CSV export column and in every server enum
 * (`DriverAxis`, `COST_CENTRE_DRILL_AXES`), so nothing a caller has saved or
 * scripted moves. Renaming a label and renaming a contract are different
 * changes; only the first one is here.
 *
 * It is also NOT a rename of the project ENTITY. A project still has a code, a
 * PM, an end date, and prose that names any of those is untouched — this
 * constant is only ever the word on the AXIS a reader picks, and the field on
 * the tag dialog that picks the same object.
 *
 * ── WHY A CONSTANT AND NOT A STRING PER SITE ─────────────────────────────────
 * Five sites rendered the word independently and drifted to two answers. One
 * constant is what makes "the product says Budget" checkable
 * (`tests/unit/components/reporting-budget-vocabulary.test.ts` asserts no
 * reporting component hardcodes the axis label) instead of aspirational.
 *
 * The region-configurable vocabulary (see the project memory note on
 * region-configurable enterprise vocabulary) replaces this constant with a
 * lookup if and when it lands; until then this is the single authority.
 */

/** The word for the object the wire keys as `'project'` — singular, as an axis. */
export const BUDGET_LABEL = 'Budget'

/**
 * The plural, DERIVED from the singular so the two can never disagree — used
 * where the label heads a LIST of them (the cost-centre Budgets hero).
 */
export const BUDGET_LABEL_PLURAL = `${BUDGET_LABEL}s`

/**
 * The budget axis's UNALLOCATED bucket in the chargeback lane — spend that
 * reached the estate and carries no budget claim.
 *
 * ── WHY IT IS NOT "UNTAGGED" HERE ────────────────────────────────────────────
 * The usage lane says "Untagged", which is a statement about a developer's
 * bookkeeping and reads right beside a coverage figure. The chargeback lane's
 * reader is asking where money lands, and the answer for this row is that it has
 * not landed anywhere yet — the tokensheet signal
 * (target-state-data-architecture.md §4: "unallocated spend is not a data defect
 * to be minimised, it is THE ACCOUNTABILITY SIGNAL"). Naming it for the lane's
 * own question is the difference between a row a cost-centre owner acts on and a
 * row they read as a data problem.
 *
 * It is NEVER "Other", never folded into a remainder and never dropped: it is
 * the row the product exists to surface, and the sum-back depends on it.
 */
export const UNALLOCATED_BUDGET_LABEL = `Not yet attributed to a ${BUDGET_LABEL.toLowerCase()}`

/**
 * The unallocated bucket's stable row key — distinct from the usage lane's
 * `__null_project` so a consumer that receives both lanes' rows (a CSV stacked
 * on another CSV) cannot merge two different questions' answers under one key.
 */
export const UNALLOCATED_BUDGET_KEY = '__unallocated_budget'

/*
 * ── THE BUSINESS UNIT ────────────────────────────────────────────────────────
 * The word for the org node a Business Unit owner reports on. The wire keys,
 * routes, columns and `data-testid`s all still say `costCentre` / `cost-centre`
 * and are NOT touched by this: renaming a label and renaming a contract are
 * different changes, and a `data-testid` rename would silently blind the three
 * visual gates.
 *
 * "Cost centre" is not merely the old word — it is a DIFFERENT OBJECT in this
 * product: an optional finance code tag carried on a BU, set in admin config
 * and unused today. One word for both guarantees a collision the day that tag
 * is switched on, which is why this is not a find-and-replace but a constant.
 *
 * ── WHY A CONSTANT, GIVEN THE TERM IS PER-REGION ─────────────────────────────
 * It is NOT globally "Business Unit". `drizzle/seed-org-structure.ts` already
 * carries the org's own answer per region — APAC "Business Unit", EMEA "Area of
 * Expertise", North America "Business Unit", Global IT "Team" — as `unitTerm`,
 * a TypeScript field that was never made a column and has no reader. Building
 * `region.unit_term` + its reader is S2 of
 * `docs/design/business-unit-tree/00-epic-design.md`.
 *
 * So hard-coding the words at ~59 call sites would ship EMEA the wrong noun AND
 * have to be undone by S2. This constant is the seam S2 replaces with a lookup:
 * one place to change, and until then the global default the seed also gives
 * two of the four regions.
 */

/** The word for the org node the wire keys as `costCentre` — singular. */
export const BU_LABEL = 'Business Unit'

/** Plural, DERIVED so the two can never disagree. */
export const BU_LABEL_PLURAL = `${BU_LABEL}s`

/** Mid-sentence form, for prose that does not start on the word. */
export const BU_LABEL_LOWER = BU_LABEL.toLowerCase()

/** Mid-sentence plural — "spend tagged to another business unit's projects". */
export const BU_LABEL_LOWER_PLURAL = BU_LABEL_PLURAL.toLowerCase()
