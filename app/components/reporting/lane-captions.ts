/*
 * lane-captions — the reporting area's per-lens explainer sentences.
 *
 * WHY A MODULE. These sentences used to live inside LaneToggle, printed under
 * the control. They now render inside the reporting header's notes disclosure
 * instead (ReportHeaderNotes) — the control stays above the fold, the paragraph
 * explaining it does not. Two components therefore need the same two strings,
 * and a caption copied into the second one is a caption that will eventually
 * contradict the first.
 *
 * These are the EXACT sentences that were rendered before the move. Do not
 * reword them here to suit the new position: the caveats were relocated, not
 * rewritten, and each one was argued for where it was written.
 */
import type { ReportLane } from '../../composables/useReportState'

export const REPORT_LANE_CAPTIONS: Record<ReportLane, string> = {
  usage: 'Provider usage truth — what was consumed. Not an invoice; includes NFR/exempt.',
  /*
   * IT SAYS WHICH PART OF "cost-of-record" IT CANNOT DELIVER. Copilot raises ONE
   * pooled invoice per cost centre, so a per-person or per-model Copilot charge
   * does not exist — those breakdowns carry Anthropic's charge alone. Naming
   * only the pooling ("Copilot pooled per cost-centre") left a reader to infer
   * that every breakdown under this lens was still both providers.
   */
  chargeback:
    'Cost-of-record — what cross-charges to cost-centres. Copilot bills one pooled invoice per cost centre (pending validation), so per-person and per-model breakdowns are Anthropic’s charge alone.',
}
