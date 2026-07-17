import { z } from 'zod'
import { REPORT_VISIBILITY_MODES } from '../auth/report-visibility'

/*
 * PUT /api/v1/admin/report-visibility body — the single org-wide knob.
 *
 * `mode` is validated against the ONE source of truth (REPORT_VISIBILITY_MODES
 * in shared/auth/report-visibility.ts), so the API can never accept a mode the
 * enforcement layer doesn't understand. Mirrors the DevLoginBody pattern
 * (schemas/auth.ts) of building a zod enum from a shared literal tuple.
 */
export const ReportVisibilityPutBody = z.object({
  mode: z.enum([...REPORT_VISIBILITY_MODES] as [string, ...string[]]),
})
export type ReportVisibilityPutBody = z.infer<typeof ReportVisibilityPutBody>
