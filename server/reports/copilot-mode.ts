/*
 * copilot.mode — the Finance Copilot rendering mode switch (reporting-consolidation build-design
 * §6 "Interim labeling" + risk 1). Decouples Finance UI delivery from Wave 0's validation:
 *
 *   - 'pool-utilisation' — the pre-validation surface. Finance renders Copilot as pool
 *     UTILISATION only (usage vs the interim pool estimate), labelled estimate-class. The
 *     canonically-correct pooled chargeback (copilot_pool_bill) exists but is NOT rendered as a
 *     charge until it is validated on Dev (Σ=bill green).
 *   - 'chargeback' — Wave 0 landed AND validated: Finance renders the pooled chargeback from
 *     v_finance_chargeback_month.
 *
 * Gated by NUXT_COPILOT_CHARGEBACK_ENABLED (default OFF → 'pool-utilisation'). Flip to true only
 * once the Σ=bill check is green on Dev. A tiny server helper — the Finance endpoint (Wave 5)
 * puts `copilot.mode` in its response and the UI reads it; no UI change is needed at cutover.
 */
export type CopilotFinanceMode = 'pool-utilisation' | 'chargeback'

/** True when the pooled Copilot chargeback has been validated and may render as a charge. */
export function copilotChargebackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.NUXT_COPILOT_CHARGEBACK_ENABLED ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** The Finance Copilot rendering mode. Defaults to 'pool-utilisation' until validated on Dev. */
export function copilotFinanceMode(env: NodeJS.ProcessEnv = process.env): CopilotFinanceMode {
  return copilotChargebackEnabled(env) ? 'chargeback' : 'pool-utilisation'
}
