/*
 * GET /api/v1/admin/directory/field-distribution?sample=200
 *
 * The "which directory attribute maps to region on MY tenant?" diagnostic.
 * Samples the directory and returns, per region attribute, coverage + the top
 * distinct values (PII-safe: attribute values + counts only, k-anonymity floor).
 * Powers the Region-rules Discover panel so an admin (Insight or an open-source
 * adopter) can SEE which attribute is region-correlated before curating rules.
 *
 * GLOBAL roles only — same posture as the region rules it feeds (cross-region
 * placement config). Best-effort, re-runnable sample (see sampleDirectoryUsers).
 */
import { defineEventHandler, getValidatedQuery } from 'h3'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { sampleDirectoryUsers } from '../../../../azure/directory'
import { computeFieldDistribution } from '../../../../../shared/placement/field-distribution'

const Query = z.object({
  sample: z.coerce.number().int().min(10).max(999).default(200),
})

export default defineEventHandler(async (event) => {
  await requireRole(event, 'global-finops', 'platform-admin')

  const { sample } = await getValidatedQuery(event, Query.parse)

  const users = await sampleDirectoryUsers(sample)
  const dist = computeFieldDistribution(users)

  return {
    sampled: users.length,
    requested: sample,
    // Not a guaranteed-random sample — surface that so an admin reads the
    // coverage as directional, not authoritative.
    representative: false,
    ...dist,
  }
})
