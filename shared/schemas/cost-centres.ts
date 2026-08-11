/*
 * My cost centres (J3, mig 0048) — the P&L-owner view contract.
 *
 * A cost centre card = one cost-owning org unit the caller OWNS (active
 * cou_owner row), with its lead projects and budget-vs-burn rollup.
 * Cross-CC members are normal (people from several P&L centres work one
 * project); the lead CC is project.cost_owning_unit_id.
 */
import { z } from 'zod'
import { ProjectCard, VelocityState } from './usage'

// The W3 /projects-list legs (`mine_mtd_usd`, `spark`) are OMITTED: this is
// the P&L OWNER's card — "the caller's own contribution" has no meaning at
// observer scope, and a sparkline here would need its own batched lane read
// nothing on the card renders. Omit keeps the /projects contract strict
// (required there) without forcing a fake leg here.
export const CostCentreProject = ProjectCard.omit({ mine_mtd_usd: true, spark: true }).extend({
  // PM display names (assignment role 'manager', currently effective).
  managers: z.array(z.string()),
  cross_cou_member_count: z.number(),
  /*
   * NULLABLE here (unlike the /projects card): velocity is a LIVE rate — this ISO
   * week against the trailing four, keyed off the CLOCK, never off the requested
   * period. This card carries a period control, so on any window that no longer
   * reaches `now` the rate describes a different period from every other figure
   * on the row. It is withheld there, and `null` (not a $0.00, which reads as a
   * quiet week rather than an absent measurement) is how it says so.
   */
  velocity: VelocityState.nullable(),
})
export type CostCentreProject = z.infer<typeof CostCentreProject>

export const CostCentreCard = z.object({
  id: z.string(),
  code: z.string(),
  display_name: z.string(),
  region_code: z.string(),
  project_count: z.number(),
  member_count: z.number(),
  cross_cou_member_count: z.number(),
  mtd_cost_usd: z.string(),
  allocation_usd: z.string(),
  utilisation: z.number().nullable(),
  /*
   * The cost centre's own §A burn and EVERY term between it and `mtd_cost_usd`
   * (which is Σ of the project rows below), on the same lane and window:
   *
   *   mtd_cost_usd + ingest_only + untagged + foreign_project − off_centre
   *     = burn_usd
   *
   * All five are published because a reconciliation missing a term is not a
   * reconciliation — the card shipped once with two of the four and its own
   * numbers did not close.
   */
  reconciliation: z.object({
    /** This centre's own §A burn: Σ rows whose cost_owning_unit_id is this CC. */
    burn_usd: z.string(),
    /** Arm 3 — the ingest-only lane, untaggable by construction (mig 0101). */
    ingest_only_usd: z.string(),
    /**
     * Homed here, taggable, no project claim. Schema-legal but produced by no
     * writer today (the CoU is only ever set alongside a project) — real
     * unclaimed money is `member_untagged_usd`.
     */
    untagged_usd: z.string(),
    /** Homed here but tagged to a project a DIFFERENT centre leads. */
    foreign_project_usd: z.string(),
    /** Tagged to one of THIS centre's projects but not homed here (arm 2). */
    off_centre_usd: z.string(),
    /**
     * OUTSIDE the identity above, and measured on the TEAMMATE axis: taggable
     * spend with no project claim AND no burn home, by people whose own home
     * cost centre is this one. Reported because it is otherwise money that
     * appears in no cost centre's anything; never added into the burn.
     */
    member_untagged_usd: z.string(),
  }),
  /**
   * A ranked PAGE of the centre's projects (burn desc), not all of them —
   * `project_count` is the true total and `omitted_projects` is the difference.
   */
  projects: z.array(CostCentreProject),
  /**
   * What `projects` does not show. Σ rendered rows + `cost_usd` = `mtd_cost_usd`,
   * so the header roll-up is explained by the rows under it rather than exceeding
   * them for no stated reason.
   */
  omitted_projects: z.object({
    /** Projects the card holds back: the dormant ones plus the ranked-out tail. */
    count: z.number(),
    /** Σ their burn in the window (the dormant ones contribute nothing). */
    cost_usd: z.string(),
    /** The subset held back on RELEVANCE: ended, and no spend in the window. */
    dormant_count: z.number(),
  }),
})
export type CostCentreCard = z.infer<typeof CostCentreCard>

/**
 * The window the response ACTUALLY answered for — never merely the params that
 * were sent. The endpoint clamps an upper bound at `now`, so a label built from
 * the request would promise a period the figures do not cover.
 */
export const CostCentreWindow = z.object({
  /** Inclusive first day (`YYYY-MM-DD`). */
  from: z.string(),
  /** Inclusive LAST day covered, after clamping (`YYYY-MM-DD`). */
  to: z.string(),
  /** `YYYY-MM` when the window is exactly that whole calendar month, else null. */
  month: z.string().nullable(),
  /** True when the upper bound is `now` — the window is still running. */
  runs_to_now: z.boolean(),
})
export type CostCentreWindow = z.infer<typeof CostCentreWindow>

export const MyCostCentresResponse = z.object({
  cost_centres: z.array(CostCentreCard),
  total: z.number(),
  window: CostCentreWindow,
})
export type MyCostCentresResponse = z.infer<typeof MyCostCentresResponse>
