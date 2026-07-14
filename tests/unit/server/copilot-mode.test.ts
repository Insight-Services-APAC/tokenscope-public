import { describe, it, expect } from 'vitest'
import { copilotFinanceMode, copilotChargebackEnabled } from '../../../server/reports/copilot-mode'

describe('copilotFinanceMode', () => {
  it('defaults to pool-utilisation when the flag is unset (pre-validation)', () => {
    expect(copilotFinanceMode({} as NodeJS.ProcessEnv)).toBe('pool-utilisation')
    expect(copilotChargebackEnabled({} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('flips to chargeback only when the flag is truthy', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', ' Yes ']) {
      expect(copilotFinanceMode({ NUXT_COPILOT_CHARGEBACK_ENABLED: v } as unknown as NodeJS.ProcessEnv)).toBe('chargeback')
    }
    for (const v of ['false', '0', 'no', '', 'off']) {
      expect(copilotFinanceMode({ NUXT_COPILOT_CHARGEBACK_ENABLED: v } as unknown as NodeJS.ProcessEnv)).toBe('pool-utilisation')
    }
  })
})
