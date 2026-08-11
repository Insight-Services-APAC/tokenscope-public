import { z } from 'zod'
import { REPORT_ACCESS_PERMISSIONS } from '../auth/report-visibility'

/*
 * POST /api/v1/admin/report-access body — grant ONE permission to ONE
 * teammate, optionally time-boxed. `permission` is validated against the ONE
 * source of truth (REPORT_ACCESS_PERMISSIONS in shared/auth/report-visibility.ts),
 * so the API can never accept a permission the enforcement layer doesn't
 * understand — mirrors how the retired shared/schemas/report-visibility.ts
 * built its enum from the literal source, and the DevLoginBody pattern
 * (schemas/auth.ts). snake_case keys per admin API convention.
 */
export const ReportAccessGrantBody = z.object({
  teammate_id: z.string().uuid(),
  permission: z.enum(REPORT_ACCESS_PERMISSIONS as unknown as [string, ...string[]]),
  expires_at: z.string().datetime({ offset: true }).optional(),
})
export type ReportAccessGrantBody = z.infer<typeof ReportAccessGrantBody>
