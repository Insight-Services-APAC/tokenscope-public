/*
 * verdict — pure resolver unit tests (no DB). Design §9: "activation gate",
 * "post-activation heuristic ignored", "unresolved never chargeable".
 */
import { describe, it, expect } from 'vitest'
import {
  resolveGithubVerdict,
  resolveAnthropicVerdict,
  type GovernanceResolutionContext,
} from '../../../server/governance/verdict'

function ctx(overrides: Partial<GovernanceResolutionContext> = {}): GovernanceResolutionContext {
  return {
    activated: false,
    enterpriseBillingById: new Map(),
    orgBillingById: new Map(),
    legacyExemptOrgs: new Set(),
    legacyExemptEnterprises: new Set(),
    ...overrides,
  }
}

describe('resolveGithubVerdict — pre-activation (legacy rollback seam)', () => {
  it('reproduces the legacy per-org name heuristic', () => {
    const c = ctx({ activated: false })
    expect(
      resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: 'acme-demo' }).exempt,
    ).toBe(true)
    expect(
      resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: 'acme-prod' }).exempt,
    ).toBe(false)
    expect(
      resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: 'acme-prod' }).source,
    ).toBe('legacy-heuristic')
  })

  it('falls back to the enterprise-level heuristic when there is no license org (App-mode)', () => {
    const c = ctx({ activated: false })
    expect(resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'partner-demo', licenseOrg: null }).exempt).toBe(
      true,
    )
    expect(resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'insight-prod', licenseOrg: null }).exempt).toBe(
      false,
    )
  })

  it('honours the configured exempt sets (env-equivalent) pre-activation', () => {
    const c = ctx({ activated: false, legacyExemptOrgs: new Set(['legacy-exempt-org']) })
    expect(resolveGithubVerdict(c, { providerEnterpriseId: 'e', enterpriseSlug: 's', licenseOrg: 'legacy-exempt-org' }).exempt).toBe(
      true,
    )
  })
})

describe('resolveGithubVerdict — post-activation (governance is data)', () => {
  it('ignores the name/env heuristic entirely — a *-demo org with billing=billed is chargeable', () => {
    const c = ctx({
      activated: true,
      enterpriseBillingById: new Map([['ent-1', 'billed']]),
      legacyExemptOrgs: new Set(), // heuristic would still match 'acme-demo' below if consulted
    })
    const v = resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: 'acme-demo' })
    expect(v.exempt).toBe(false)
    expect(v.source).toBe('governance:billed')
  })

  it('reads ONLY the enterprise billing — org identity is never consulted', () => {
    const c = ctx({ activated: true, enterpriseBillingById: new Map([['ent-1', 'tracked']]) })
    const withOrg = resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: 'acme-prod' })
    const withoutOrg = resolveGithubVerdict(c, { providerEnterpriseId: 'ent-1', enterpriseSlug: 'acme', licenseOrg: null })
    expect(withOrg).toEqual(withoutOrg)
    expect(withOrg.exempt).toBe(true)
    expect(withOrg.source).toBe('governance:tracked')
  })

  it('an unresolved enterprise is governance-unresolved — never chargeable, never silently exempt', () => {
    const c = ctx({ activated: true })
    const v = resolveGithubVerdict(c, { providerEnterpriseId: null, enterpriseSlug: 'unknown-ent', licenseOrg: 'x' })
    expect(v.exempt).toBe(true)
    expect(v.source).toBe('unresolved')
  })
})

describe('resolveAnthropicVerdict', () => {
  it('pre-activation: always chargeable (Anthropic never had a live heuristic)', () => {
    const c = ctx({ activated: false })
    const v = resolveAnthropicVerdict(c, { providerOrgId: 'org-1' })
    expect(v.exempt).toBe(false)
    expect(v.source).toBe('legacy-heuristic')
  })

  it('pre-activation: even an org whose billing is already tracked stays chargeable (no live read)', () => {
    const c = ctx({ activated: false, orgBillingById: new Map([['org-1', 'tracked']]) })
    expect(resolveAnthropicVerdict(c, { providerOrgId: 'org-1' }).exempt).toBe(false)
  })

  it('post-activation: reads provider_org.billing authoritatively', () => {
    const c = ctx({ activated: true, orgBillingById: new Map([['org-1', 'tracked'], ['org-2', 'billed']]) })
    expect(resolveAnthropicVerdict(c, { providerOrgId: 'org-1' }).exempt).toBe(true)
    expect(resolveAnthropicVerdict(c, { providerOrgId: 'org-2' }).exempt).toBe(false)
  })

  it('post-activation: unresolved org id is governance-unresolved (never chargeable, never silently exempt)', () => {
    const c = ctx({ activated: true })
    const v = resolveAnthropicVerdict(c, { providerOrgId: null })
    expect(v.exempt).toBe(true)
    expect(v.source).toBe('unresolved')
  })
})
