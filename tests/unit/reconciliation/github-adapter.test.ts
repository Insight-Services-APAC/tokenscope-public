/*
 * Pure-helper unit tests for the GitHub Copilot adapter (no DB, no HTTP).
 *
 * Covers the credit -> ReconciledLine normalisation (gross/discount/net facets,
 * the authoritative grossAmount/grossQuantity rate, indicative vs estimated,
 * the gross<=0 skip, and the multi-category split) plus the day enumeration,
 * SKU categorisation, license-org extraction, and the general finance/chargeback
 * org-exclusion classification (the generalised "NFR/demo" mechanism).
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  normaliseSeatDay,
  enumerateDays,
  categoriseSku,
  seatLicenseOrg,
} from '../../../server/reconciliation/adapters/github'
import {
  isChargebackExemptOrg,
  chargebackExemptOrgSet,
  isNfrDemoOrg,
  nfrDemoOrgSet,
} from '../../../server/reconciliation/legacy-chargeback-heuristic'
import type { GithubSeat, GithubUsageItem } from '../../../server/reconciliation/adapters/github-client'

function usageItem(over: Partial<GithubUsageItem> = {}): GithubUsageItem {
  return {
    product: 'copilot',
    sku: 'Copilot AI Credits',
    model: 'gpt-4',
    unitType: 'ai-credits',
    pricePerUnit: 0.01,
    grossQuantity: 100,
    grossAmount: 1,
    discountQuantity: 0,
    discountAmount: 0,
    netQuantity: 100,
    netAmount: 1,
    ...over,
  }
}

describe('enumerateDays', () => {
  it('returns an inclusive list of UTC days', () => {
    const days = enumerateDays('2026-06-05', '2026-06-08')
    expect(days.map((d) => d.iso)).toEqual(['2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08'])
    expect(days[0]).toEqual({ iso: '2026-06-05', year: 2026, month: 6, day: 5 })
  })

  it('handles a single-day window', () => {
    expect(enumerateDays('2026-06-07', '2026-06-07').map((d) => d.iso)).toEqual(['2026-06-07'])
  })

  it('returns [] for an inverted or invalid range', () => {
    expect(enumerateDays('2026-06-08', '2026-06-05')).toEqual([])
    expect(enumerateDays('not-a-date', '2026-06-08')).toEqual([])
  })

  it('crosses a month boundary correctly', () => {
    expect(enumerateDays('2026-05-31', '2026-06-02').map((d) => d.iso)).toEqual([
      '2026-05-31',
      '2026-06-01',
      '2026-06-02',
    ])
  })
})

describe('categoriseSku', () => {
  it('maps the AI-credits SKU to the interactive lane', () => {
    expect(categoriseSku(usageItem({ sku: 'Copilot AI Credits' }))).toBe('copilot_interactive')
  })

  it('maps a coding/cloud-agent SKU to the coding-agent lane (defensive match)', () => {
    expect(categoriseSku(usageItem({ sku: 'Copilot Coding Agent' }))).toBe('copilot_coding_agent')
    expect(categoriseSku(usageItem({ product: 'cloud-agent', sku: '' }))).toBe('copilot_coding_agent')
    expect(categoriseSku(usageItem({ sku: 'padawan' }))).toBe('copilot_coding_agent')
  })

  it('defaults unknown SKUs to the interactive lane', () => {
    expect(categoriseSku(usageItem({ product: '', sku: 'Something New' }))).toBe('copilot_interactive')
  })
})

describe('seatLicenseOrg', () => {
  const seat = (over: Partial<GithubSeat>): GithubSeat =>
    ({ assignee: { login: 'a' }, ...over }) as GithubSeat

  it('reads the org login when present', () => {
    expect(seatLicenseOrg(seat({ organization: { login: 'insight-apac-demo' } }))).toBe('insight-apac-demo')
  })

  it('falls back to the assigning team (string or object)', () => {
    expect(seatLicenseOrg(seat({ organization: null, assigning_team: 'team-x' }))).toBe('team-x')
    expect(seatLicenseOrg(seat({ organization: null, assigning_team: { name: 'team-y' } }))).toBe('team-y')
  })

  it('returns null when neither is available', () => {
    expect(seatLicenseOrg(seat({ organization: null }))).toBeNull()
  })
})

describe('chargebackExemptOrgSet / isChargebackExemptOrg (general finance-exclusion by org)', () => {
  afterEach(() => {
    delete process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS
    delete process.env.NUXT_GITHUB_NFR_DEMO_ORGS
  })

  it('uses the partner-bootstrap heuristic when NEITHER env var is configured', () => {
    const set = chargebackExemptOrgSet()
    expect(set.size).toBe(0)
    expect(isChargebackExemptOrg('insight-apac-demo', set)).toBe(true) // demo -> exempt
    expect(isChargebackExemptOrg('acme-nfr', set)).toBe(true) // nfr -> exempt
    expect(isChargebackExemptOrg('acme-prod', set)).toBe(false) // chargeback-eligible
    expect(isChargebackExemptOrg(null, set)).toBe(false)
  })

  it('honours an explicit allow-list via NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS (case-insensitive), UNIONed with the heuristic', () => {
    process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS = 'Acme-Prod, other-org'
    const set = chargebackExemptOrgSet()
    // org in the set -> exempt (excluded from finance/chargeback report)
    expect(isChargebackExemptOrg('acme-prod', set)).toBe(true)
    expect(isChargebackExemptOrg('OTHER-ORG', set)).toBe(true)
    // org NOT in the set and NOT nfr/demo-named -> chargeback-eligible
    expect(isChargebackExemptOrg('acme-corp', set)).toBe(false)
    // an nfr/demo-named org is STILL exempt even with a list present (UNION, not replace):
    // configuring a list must never silently re-enable charging of a demo/NFR org omitted
    // from it — the mis-charge footgun this fix removes.
    expect(isChargebackExemptOrg('insight-apac-demo', set)).toBe(true)
  })

  it('reads the legacy NUXT_GITHUB_NFR_DEMO_ORGS as a backward-compat fallback alias', () => {
    process.env.NUXT_GITHUB_NFR_DEMO_ORGS = 'legacy-prod-org'
    const set = chargebackExemptOrgSet()
    expect(isChargebackExemptOrg('legacy-prod-org', set)).toBe(true)
    // heuristic still applies under the union (an nfr/demo-named org is exempt)
    expect(isChargebackExemptOrg('insight-apac-demo', set)).toBe(true)
    // a non-listed, non-heuristic org is chargeback-eligible
    expect(isChargebackExemptOrg('acme-corp', set)).toBe(false)
  })

  it('UNIONS the new var with the legacy var so neither silently shadows the other', () => {
    process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS = 'new-exempt'
    process.env.NUXT_GITHUB_NFR_DEMO_ORGS = 'legacy-exempt'
    const set = chargebackExemptOrgSet()
    expect(isChargebackExemptOrg('new-exempt', set)).toBe(true)
    expect(isChargebackExemptOrg('legacy-exempt', set)).toBe(true)
    expect(isChargebackExemptOrg('unlisted-prod', set)).toBe(false)
  })

  it('keeps nfrDemoOrgSet / isNfrDemoOrg as backward-compat aliases of the general primitive', () => {
    expect(nfrDemoOrgSet).toBe(chargebackExemptOrgSet)
    expect(isNfrDemoOrg).toBe(isChargebackExemptOrg)
  })
})

describe('normaliseSeatDay', () => {
  const base = {
    enterpriseRef: 'acme-partner-demo',
    teammateId: '33333333-3333-3333-3333-333333333333',
    licenseOrg: 'acme-prod',
    periodDate: '2026-06-07',
    login: 'octocat',
  }

  it('emits one line per category, summing gross/discount/net in credits', () => {
    const lines = normaliseSeatDay({
      ...base,
      chargebackExempt: false,
      usageItems: [
        usageItem({ grossQuantity: 100, grossAmount: 1, discountQuantity: 20, netQuantity: 80, netAmount: 0.8 }),
        usageItem({ grossQuantity: 50, grossAmount: 0.5, discountQuantity: 10, netQuantity: 40, netAmount: 0.4 }),
      ],
    })
    expect(lines).toHaveLength(1)
    const l = lines[0]!
    expect(l.provider).toBe('github')
    expect(l.category).toBe('copilot_interactive')
    expect(l.unit).toEqual({ quantity: 150, unitType: 'ai-credits' })
    expect(l.facets).toEqual({ gross: 150, discount: 30, net: 120 })
    // rate = grossAmount / gross = 1.5 / 150 = 0.01
    expect(Number(l.rateUsdPerUnit)).toBeCloseTo(0.01, 8)
    expect(Number(l.amountUsd)).toBeCloseTo(1.5, 6)
    expect(l.spendClass).toBe('indicative') // v1: Copilot held indicative until F2
    expect(l.indicativeReason).toBe('copilot-pre-billing')
    expect(l.licenseOrg).toBe('acme-prod')
    expect(l.subject).toEqual({ kind: 'teammate', teammateId: base.teammateId })
  })

  it('marks a chargeback-exempt org indicative with the chargeback-exempt reason', () => {
    const [l] = normaliseSeatDay({ ...base, chargebackExempt: true, usageItems: [usageItem()] })
    expect(l!.spendClass).toBe('indicative')
    expect(l!.indicativeReason).toBe('chargeback-exempt')
  })

  it('marks a chargeback-eligible org indicative with the copilot-pre-billing reason (v1)', () => {
    const [l] = normaliseSeatDay({ ...base, chargebackExempt: false, usageItems: [usageItem()] })
    expect(l!.spendClass).toBe('indicative')
    expect(l!.indicativeReason).toBe('copilot-pre-billing')
  })

  it('skips a category with no billable (gross<=0) credits', () => {
    const lines = normaliseSeatDay({
      ...base,
      chargebackExempt: false,
      usageItems: [usageItem({ grossQuantity: 0, grossAmount: 0 })],
    })
    expect(lines).toEqual([])
  })

  it('splits interactive and coding-agent SKUs into separate lines', () => {
    const lines = normaliseSeatDay({
      ...base,
      chargebackExempt: false,
      usageItems: [
        usageItem({ sku: 'Copilot AI Credits', grossQuantity: 100, grossAmount: 1 }),
        usageItem({ sku: 'Copilot Coding Agent', grossQuantity: 40, grossAmount: 0.4 }),
      ],
    })
    expect(lines).toHaveLength(2)
    const byCat = Object.fromEntries(lines.map((l) => [l.category, l]))
    expect(byCat.copilot_interactive!.unit.quantity).toBe(100)
    expect(byCat.copilot_coding_agent!.unit.quantity).toBe(40)
  })

  it('preserves the verbatim usage items in raw for audit', () => {
    const items = [usageItem()]
    const [l] = normaliseSeatDay({ ...base, chargebackExempt: false, usageItems: items })
    expect((l!.raw as { items: GithubUsageItem[] }).items).toEqual(items)
    expect((l!.raw as { login: string }).login).toBe('octocat')
  })
})
