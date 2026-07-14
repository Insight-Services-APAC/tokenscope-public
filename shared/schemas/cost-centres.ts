/*
 * My cost centres (J3, mig 0048) — the P&L-owner view contract.
 *
 * A cost centre card = one cost-owning org unit the caller OWNS (active
 * cou_owner row), with its lead projects and budget-vs-burn rollup.
 * Cross-CC members are normal (people from several P&L centres work one
 * project); the lead CC is project.cost_owning_unit_id.
 */
import { z } from 'zod'
import { ProjectCard } from './usage'

export const CostCentreProject = ProjectCard.extend({
  // PM display names (assignment role 'manager', currently effective).
  managers: z.array(z.string()),
  cross_cou_member_count: z.number(),
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
  projects: z.array(CostCentreProject),
})
export type CostCentreCard = z.infer<typeof CostCentreCard>

export const MyCostCentresResponse = z.object({
  cost_centres: z.array(CostCentreCard),
  total: z.number(),
})
export type MyCostCentresResponse = z.infer<typeof MyCostCentresResponse>
