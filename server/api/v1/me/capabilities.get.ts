/*
 * GET /api/v1/me/capabilities — relationship-derived capabilities the UI needs
 * to choose between "New project" and "Request a project". Kept off
 * /auth/me, whose contract is that it never touches the database on the common
 * path. A UI hint only: POST /projects runs canCreateProjects itself.
 */
import { defineEventHandler } from 'h3'
import { requireAuth } from '../../../auth/rbac'
import { withRequestRls } from '../../../db/request-rls'
import { hasProjectManagerGrant, pmOwnRegionOnly } from '../../../auth/org-roles'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  return await withRequestRls(event, async (tx) => ({
    can_create_projects: await hasProjectManagerGrant(tx, session.teammateId),
    pm_own_region_only: await pmOwnRegionOnly(tx),
    region_id: session.regionId,
  }))
})
