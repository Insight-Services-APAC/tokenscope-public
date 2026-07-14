/*
 * Unit tests for the shared per-(teammate, day) line builder + the GitHub metrics
 * normaliser. Pure functions, no DB/HTTP. The builder is the standardisation seam both
 * adapters route through, so its rate-formatting contract (the bit that must NOT shift
 * existing Anthropic rows) is pinned here.
 */
import { describe, it, expect } from 'vitest'
import { reconciledTeammateLine } from '../../../server/reconciliation/adapters/teammate-line'
import { normaliseMetricsCreditLine } from '../../../server/reconciliation/adapters/github'

describe('reconciledTeammateLine (shared builder)', () => {
  const base = {
    provider: 'anthropic' as const,
    enterpriseRef: 'org-1',
    periodDate: '2026-06-29',
    teammateId: 'tm-1',
    category: 'model_tokens' as const,
    unitType: 'tokens' as const,
    spendClass: 'estimated' as const,
    raw: { x: 1 },
  }

  it('derives the rate as amountUsd/quantity at 8dp when not supplied', () => {
    const l = reconciledTeammateLine({ ...base, quantity: 1000, amountUsd: 0.5 })
    expect(l.rateUsdPerUnit).toBe('0.00050000')
    expect(l.amountUsd).toBe('0.500000')
    expect(l.subject).toEqual({ kind: 'teammate', teammateId: 'tm-1' })
    expect(l.unit).toEqual({ quantity: 1000, unitType: 'tokens' })
    expect(l.licenseOrg).toBeNull()
    // No facets / indicativeReason on a token line.
    expect(l.facets).toBeUndefined()
    expect(l.indicativeReason).toBeUndefined()
  })

  it("books a zero-quantity line as rate '0' (not '0.00000000') — preserves existing rows", () => {
    const l = reconciledTeammateLine({ ...base, quantity: 0, amountUsd: 0 })
    expect(l.rateUsdPerUnit).toBe('0')
  })

  it('uses an explicitly-supplied rate at 8dp (GitHub passes the authoritative rate)', () => {
    const l = reconciledTeammateLine({ ...base, quantity: 100, amountUsd: 1, rateUsdPerUnit: 0.01 })
    expect(l.rateUsdPerUnit).toBe('0.01000000')
    expect(l.amountUsd).toBe('1.000000')
  })

  it('attaches facets, indicativeReason and licenseOrg only when present', () => {
    const l = reconciledTeammateLine({
      ...base,
      provider: 'github',
      quantity: 50,
      amountUsd: 0.5,
      facets: { gross: 50, discount: 0, net: 50 },
      indicativeReason: 'chargeback-exempt',
      licenseOrg: 'acme-prod',
    })
    expect(l.facets).toEqual({ gross: 50, discount: 0, net: 50 })
    expect(l.indicativeReason).toBe('chargeback-exempt')
    expect(l.licenseOrg).toBe('acme-prod')
  })
})

describe('normaliseMetricsCreditLine (App-mode metrics path)', () => {
  const base = {
    enterpriseRef: 'acme-partner-demo',
    teammateId: 'tm-1',
    periodDate: '2026-06-29',
    login: 'octocat',
    raw: { user_login: 'octocat', ai_credits_used: 562.57 },
  }

  it('prices per-user credits at the flat $0.01 into a single copilot_interactive credit line', () => {
    const l = normaliseMetricsCreditLine({ ...base, credits: 562.57, chargebackExempt: true })
    expect(l.provider).toBe('github')
    expect(l.subject).toEqual({ kind: 'teammate', teammateId: 'tm-1' })
    expect(l.category).toBe('copilot_interactive')
    expect(l.unit).toEqual({ quantity: 562.57, unitType: 'ai-credits' })
    expect(l.rateUsdPerUnit).toBe('0.01000000')
    expect(l.amountUsd).toBe('5.625700') // 562.57 * 0.01
    // GROSS consumption — net=gross, no discount/allowance applied (that's the billing API's job).
    expect(l.facets).toEqual({ gross: 562.57, discount: 0, net: 562.57 })
    expect(l.spendClass).toBe('indicative')
    expect(l.indicativeReason).toBe('chargeback-exempt')
    // Metrics is enterprise-grain → no per-user license org.
    expect(l.licenseOrg).toBeNull()
  })

  it('marks a non-exempt enterprise as copilot-pre-billing (chargeback-eligible at F2)', () => {
    const l = normaliseMetricsCreditLine({ ...base, credits: 10, chargebackExempt: false })
    expect(l.indicativeReason).toBe('copilot-pre-billing')
  })

  it('preserves the source record under raw for audit / late-binding', () => {
    const l = normaliseMetricsCreditLine({ ...base, credits: 10, chargebackExempt: false })
    expect(l.raw).toEqual({ login: 'octocat', periodDate: '2026-06-29', credits: 10, record: base.raw })
  })
})
