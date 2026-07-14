// @vitest-environment node
/*
 * GitHub Copilot adapter — DB path against testcontainers Postgres.
 *
 * Exercises pull() end to end with a STUBBED GitHub client (no live calls): a
 * resolved login produces ReconciledLines bound to its teammate; an unmatched
 * login is carried forward (never emitted/guessed); the license org comes from
 * the seat roster (never from telemetry); and a per-seat-day API failure is
 * isolated rather than starving the sweep.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  createGithubAdapterWithClient,
  resolveEnterpriseForOrg,
  resolveGithubRoster,
} from '../../../server/reconciliation/adapters/github'
import type { GithubSeat, GithubAiCreditUsage } from '../../../server/reconciliation/adapters/github-client'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
let teammateId = ''
// A SECOND teammate — the enterprise-lane binding target for the self-link precedence test.
let teammateId2 = ''
const ENT = 'acme-partner-demo'
const RESOLVED_LOGIN = 'octocat'
const UNMATCHED_LOGIN = 'ghost-seat'

const credential: ResolvedCredential = { secretName: 'partner-demo', value: 'unused-in-stub', level: 'enterprise' }

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-gh', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-gh'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.gh', 'gh-bu', 'GH BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'gh-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-gh', 'veli@example.com', ${region!.id}, ${org!.id}),
           (gen_random_uuid(), 'oid-gh-2', 'veli2@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-gh'`
  teammateId = tm!.id
  const [tm2] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-gh-2'`
  teammateId2 = tm2!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

async function linkLogin(login: string, licenseOrg: string): Promise<void> {
  await t.client`
    INSERT INTO teammate_identity_map
      (teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug, license_org, sso_email, source)
    VALUES
      (${teammateId}, 'github', ${login}, 'username', ${login}, ${ENT}, ${licenseOrg}, 'veli@example.com', 'directory-sync')`
}

/* An ENTERPRISE-lane binding to a SPECIFIC teammate (the authoritative directory/admin lane). */
async function linkEnterprise(login: string, tmId: string, licenseOrg: string): Promise<void> {
  await t.client`
    INSERT INTO teammate_identity_map
      (teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug, license_org, source)
    VALUES
      (${tmId}, 'github', ${login}, 'username', ${login}, ${ENT}, ${licenseOrg}, 'directory-sync')`
}

/* A SELF-SERVICE link exactly as POST /api/v1/me/identities writes it: source='self',
 * enterprise_slug NULL (the separate self lane), unverified. */
async function selfLink(login: string, tmId: string): Promise<void> {
  await t.client`
    INSERT INTO teammate_identity_map
      (teammate_id, system, identifier, identifier_kind, source, is_canonical)
    VALUES
      (${tmId}, 'github', ${login}, 'username', 'self', false)`
}

function seat(login: string, org: string): GithubSeat {
  return { assignee: { login }, organization: { login: org } } as GithubSeat
}

function usage(grossQuantity: number, grossAmount: number): GithubAiCreditUsage {
  return {
    usageItems: [
      {
        product: 'copilot',
        sku: 'Copilot AI Credits',
        unitType: 'ai-credits',
        pricePerUnit: 0.01,
        grossQuantity,
        grossAmount,
        discountQuantity: grossQuantity,
        discountAmount: grossAmount,
        netQuantity: 0,
        netAmount: 0,
      },
    ],
  }
}

describe('GithubAdapter.pull (DB path)', () => {
  it('emits lines only for resolved logins; carries forward the unmatched one', async () => {
    await linkLogin(RESOLVED_LOGIN, 'acme-prod')

    const getAiCreditUsage = vi.fn(async () => usage(100, 1))
    const listSeats = vi.fn(async () => [seat(RESOLVED_LOGIN, 'acme-prod'), seat(UNMATCHED_LOGIN, 'acme-prod')])
    const adapter = createGithubAdapterWithClient(t.db, { externalRef: ENT, credential }, { listSeats, getAiCreditUsage })

    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })

    expect(lines).toHaveLength(1)
    expect(lines[0]!.subject).toEqual({ kind: 'teammate', teammateId })
    expect(lines[0]!.licenseOrg).toBe('acme-prod')
    expect(lines[0]!.unit).toEqual({ quantity: 100, unitType: 'ai-credits' })
    // Usage is only fetched for the resolved seat — the unmatched login is skipped early.
    expect(getAiCreditUsage).toHaveBeenCalledTimes(1)
    expect(getAiCreditUsage).toHaveBeenCalledWith(RESOLVED_LOGIN, expect.objectContaining({ day: 7 }))
  })

  it('a multi-org user is staged ONCE per login (usage is per-user — no Nx inflation)', async () => {
    // ai_credit/usage is per-USER; a user holding seats in two orgs must NOT have the same
    // usage pulled + emitted per seat (the engine's conflict-key aggregation, which excludes
    // license_org, would SUM them → Nx inflation). The adapter dedups per login. (ADR-0010)
    await linkLogin(RESOLVED_LOGIN, 'acme-prod')
    const getAiCreditUsage = vi.fn(async () => usage(100, 1))
    const listSeats = vi.fn(async () => [seat(RESOLVED_LOGIN, 'acme-prod'), seat(RESOLVED_LOGIN, 'acme-demo')])
    const adapter = createGithubAdapterWithClient(t.db, { externalRef: ENT, credential }, { listSeats, getAiCreditUsage })

    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })

    expect(lines).toHaveLength(1) // ONE line, not two
    expect(getAiCreditUsage).toHaveBeenCalledTimes(1) // usage pulled once, not per seat
    expect(Number(lines[0]!.amountUsd)).toBeCloseTo(1, 6) // 1× the user's usage, not 2×
  })

  it('uses the roster license org (acme-prod) regardless of any telemetry org', async () => {
    // The identity map says acme-prod (a real, non-NFR org). v1 holds ALL Copilot
    // indicative (copilot-pre-billing) until the F2 billing worker promotes it, so it
    // must NOT cross-charge. The roster org is still authoritative for licenseOrg.
    await linkLogin(RESOLVED_LOGIN, 'acme-prod')
    const adapter = createGithubAdapterWithClient(
      t.db,
      { externalRef: ENT, credential },
      { listSeats: async () => [seat(RESOLVED_LOGIN, 'acme-prod')], getAiCreditUsage: async () => usage(50, 0.5) },
    )
    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })
    expect(lines[0]!.spendClass).toBe('indicative')
    expect(lines[0]!.indicativeReason).toBe('copilot-pre-billing')
    expect(lines[0]!.licenseOrg).toBe('acme-prod')
  })

  it('classes a finance/chargeback-exempt (NFR/demo) license org as indicative', async () => {
    // No env config set -> the partner-bootstrap heuristic classes a *-demo org exempt.
    await linkLogin(RESOLVED_LOGIN, 'insight-apac-demo')
    const adapter = createGithubAdapterWithClient(
      t.db,
      { externalRef: ENT, credential },
      { listSeats: async () => [seat(RESOLVED_LOGIN, 'insight-apac-demo')], getAiCreditUsage: async () => usage(50, 0.5) },
    )
    const [line] = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })
    expect(line!.spendClass).toBe('indicative')
    expect(line!.indicativeReason).toBe('chargeback-exempt')
  })

  it('keys finance exclusion by ORG: org in the exempt set -> excluded; org not in set -> reportable-eligible', async () => {
    // The generalised primitive: an explicit allow-list excludes EXACTLY the listed orgs
    // from the finance/chargeback report; an unlisted org is chargeback-eligible.
    process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS = 'exempt-org'
    try {
      await linkLogin(RESOLVED_LOGIN, 'exempt-org')
      const exemptAdapter = createGithubAdapterWithClient(
        t.db,
        { externalRef: ENT, credential },
        { listSeats: async () => [seat(RESOLVED_LOGIN, 'exempt-org')], getAiCreditUsage: async () => usage(50, 0.5) },
      )
      const [exemptLine] = await exemptAdapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })
      expect(exemptLine!.indicativeReason).toBe('chargeback-exempt')

      // An org NOT in the set and NOT nfr/demo-named is chargeback-eligible
      // (copilot-pre-billing). Under the UNION fix an *-demo org would STILL be exempt
      // even with a list present — so use a plain prod name here to exercise the eligible
      // path. (A demo-named org staying exempt is the mis-charge footgun the fix removes.)
      await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
      await linkLogin(RESOLVED_LOGIN, 'unlisted-prod-team')
      const eligibleAdapter = createGithubAdapterWithClient(
        t.db,
        { externalRef: ENT, credential },
        { listSeats: async () => [seat(RESOLVED_LOGIN, 'unlisted-prod-team')], getAiCreditUsage: async () => usage(50, 0.5) },
      )
      const [eligibleLine] = await eligibleAdapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })
      expect(eligibleLine!.indicativeReason).toBe('copilot-pre-billing')
    } finally {
      delete process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS
    }
  })

  it('isolates a per-seat-day API failure instead of throwing', async () => {
    await linkLogin(RESOLVED_LOGIN, 'acme-prod')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Day 7 succeeds, day 8 throws — the sweep must keep the good day.
    const getAiCreditUsage = vi.fn(async (_login: string, date: { day: number }) => {
      if (date.day === 8) throw new Error('boom')
      return usage(100, 1)
    })
    const adapter = createGithubAdapterWithClient(
      t.db,
      { externalRef: ENT, credential },
      { listSeats: async () => [seat(RESOLVED_LOGIN, 'acme-prod')], getAiCreditUsage },
    )
    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-08' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.periodDate).toBe('2026-06-07')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns [] for an empty/invalid window without calling the API', async () => {
    await linkLogin(RESOLVED_LOGIN, 'acme-prod')
    const getAiCreditUsage = vi.fn(async () => usage(100, 1))
    const adapter = createGithubAdapterWithClient(
      t.db,
      { externalRef: ENT, credential },
      { listSeats: async () => [seat(RESOLVED_LOGIN, 'acme-prod')], getAiCreditUsage },
    )
    const lines = await adapter.pull({ startDate: '2026-06-08', endDate: '2026-06-07' })
    expect(lines).toEqual([])
    expect(getAiCreditUsage).not.toHaveBeenCalled()
  })
})

/*
 * identity-tail layer 2 (MONEY PATH): the Copilot roster reader resolves BOTH the
 * enterprise/directory-sync lane AND the self-service lane (enterprise_slug NULL,
 * source='self'), with the ENTERPRISE lane authoritative when both hold the same login.
 * These lock the exact precedence: no login can resolve to two teammates, and a self-link
 * never overrides the authoritative binding — it only ADDS the residual tail.
 */
describe('resolveGithubRoster (two-lane self-service + enterprise precedence)', () => {
  beforeEach(async () => {
    await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
  })

  it('resolves a self-linked login (source=self, enterprise_slug NULL) that has NO enterprise row', async () => {
    await selfLink(RESOLVED_LOGIN, teammateId)
    const roster = await resolveGithubRoster(t.db, ENT)
    expect(roster.get(RESOLVED_LOGIN)).toBe(teammateId)
  })

  it('the ENTERPRISE lane WINS over a self-link for the same login (self can only ADD, never override)', async () => {
    // Self-link points at teammate #1; the authoritative enterprise binding points at #2.
    await selfLink(RESOLVED_LOGIN, teammateId)
    await linkEnterprise(RESOLVED_LOGIN, teammateId2, 'acme-prod')
    const roster = await resolveGithubRoster(t.db, ENT)
    // Exactly ONE entry for the login, and it is the enterprise-lane teammate.
    expect(roster.get(RESOLVED_LOGIN)).toBe(teammateId2)
    // Precedence is order-independent: insert the enterprise row FIRST, self-link SECOND.
    await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
    await linkEnterprise(RESOLVED_LOGIN, teammateId2, 'acme-prod')
    await selfLink(RESOLVED_LOGIN, teammateId)
    const roster2 = await resolveGithubRoster(t.db, ENT)
    expect(roster2.get(RESOLVED_LOGIN)).toBe(teammateId2)
  })

  it('a login in NEITHER lane stays unresolved', async () => {
    const roster = await resolveGithubRoster(t.db, ENT)
    expect(roster.has(UNMATCHED_LOGIN)).toBe(false)
  })

  it('a self-link for a DIFFERENT enterprise still resolves (self lane is enterprise-agnostic by design)', async () => {
    // The self lane carries NO enterprise_slug, so a self-link resolves under ANY enterprise ref —
    // this is intended: a self-link is "this github login is me", not scoped to one enterprise.
    await selfLink(RESOLVED_LOGIN, teammateId)
    const roster = await resolveGithubRoster(t.db, 'some-other-enterprise')
    expect(roster.get(RESOLVED_LOGIN)).toBe(teammateId)
  })

  it('a self-linked login now ATTRIBUTES through adapter.pull (end-to-end money path)', async () => {
    // The literal gap this change closes: pre-change a self-link was INVISIBLE to Copilot
    // attribution (the enterprise-slug filter excluded NULL). Now the seat's usage attributes.
    await selfLink(RESOLVED_LOGIN, teammateId)
    const adapter = createGithubAdapterWithClient(
      t.db,
      { externalRef: ENT, credential },
      { listSeats: async () => [seat(RESOLVED_LOGIN, 'acme-prod')], getAiCreditUsage: async () => usage(50, 0.5) },
    )
    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-07' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.subject).toEqual({ kind: 'teammate', teammateId })
  })
})

/*
 * org -> enterprise keying readiness (F2 activation-time logic). The Copilot emit carries
 * the repo org; resolveEnterpriseForOrg maps org -> provider_org.provider_enterprise_id ->
 * provider_enterprise.external_id (the credential/reconciliation lane). It is a no-op until
 * a provider_org row is LINKED to a provider_enterprise (the F2 onboarding seed is a
 * template), so it returns null for an unlinked or unknown org and never invents a slug.
 */
describe('resolveEnterpriseForOrg (org -> enterprise keying)', () => {
  const ENT_SLUG = 'acme-partner-demo'
  const LINKED_ORG = 'partner-demo-org'

  beforeEach(async () => {
    await t.client`DELETE FROM provider_org WHERE provider = 'github' AND external_org_id IN ('partner-demo-org', 'orphan-org')`
    await t.client`DELETE FROM provider_enterprise WHERE provider = 'github' AND external_id = ${ENT_SLUG}`
  })

  async function seedEnterprise(): Promise<string> {
    await t.client`
      INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, billing, credential_secret_name)
      VALUES ('github', ${ENT_SLUG}, 'Partner Demo Ent', 'reconciled', 'tracked', 'partner-demo')`
    const [ent] = await t.client<{ id: string }[]>`
      SELECT id::text AS id FROM provider_enterprise WHERE provider = 'github' AND external_id = ${ENT_SLUG}`
    return ent!.id
  }

  it('maps a linked GitHub org to its enterprise slug (case-insensitive)', async () => {
    const entId = await seedEnterprise()
    await t.client`
      INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id)
      VALUES ('github', ${LINKED_ORG}, 'Partner Demo Org', ${entId}::uuid)`
    expect(await resolveEnterpriseForOrg(t.db, LINKED_ORG)).toBe(ENT_SLUG)
    // Casing-robust: GitHub slugs/logins are canonically lowercase; a caller's mixed case resolves.
    expect(await resolveEnterpriseForOrg(t.db, 'Partner-Demo-Org')).toBe(ENT_SLUG)
  })

  it('returns null for an org that exists but is NOT linked to an enterprise (no-op until onboarded)', async () => {
    await t.client`
      INSERT INTO provider_org (provider, external_org_id, display_name)
      VALUES ('github', 'orphan-org', 'Unlinked Org')`
    expect(await resolveEnterpriseForOrg(t.db, 'orphan-org')).toBeNull()
  })

  it('returns null for an unknown org and for empty/null input', async () => {
    expect(await resolveEnterpriseForOrg(t.db, 'never-seen-org')).toBeNull()
    expect(await resolveEnterpriseForOrg(t.db, null)).toBeNull()
    expect(await resolveEnterpriseForOrg(t.db, '')).toBeNull()
    expect(await resolveEnterpriseForOrg(t.db, '   ')).toBeNull()
  })
})
