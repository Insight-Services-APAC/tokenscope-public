import { z } from 'zod'
import { REPORT_ACCESS_GRANT_VALUES } from '../auth/report-visibility'

/*
 * POST /api/v1/admin/report-access body — write ONE report-access row for ONE
 * teammate, optionally time-boxed. `permission` is validated against the ONE
 * source of truth (REPORT_ACCESS_GRANT_VALUES in shared/auth/report-visibility.ts
 * = the positive grants PLUS the 'revoke-all' DENY, mig 0130), so the API can
 * never accept a value the enforcement layer or the DB CHECK doesn't understand.
 * A 'revoke-all' write is how an admin turns report access OFF for a person
 * (the "administer, no data" case); the DELETE endpoint clears it to restore.
 * snake_case keys per admin API convention.
 *
 * The readonly literal tuple is passed to `z.enum` UNCAST. Zod 4 accepts a
 * `const` readonly string array directly, so `ReportAccessGrantBody['permission']`
 * infers the three-literal union; the `as unknown as [string, ...string[]]`
 * this replaces widened it to plain `string`, which silently un-typed every
 * consumer while runtime validation stayed correct — the two must agree.
 */
export const ReportAccessGrantBody = z.object({
  teammate_id: z.string().uuid(),
  permission: z.enum(REPORT_ACCESS_GRANT_VALUES),
  expires_at: z.string().datetime({ offset: true }).optional(),
})
export type ReportAccessGrantBody = z.infer<typeof ReportAccessGrantBody>
