// @vitest-environment node
/*
 * GitHub Copilot identity resolver — APP-MODE DB path against testcontainers Postgres.
 *
 * App mode now bridges identity PER-ORG (mirroring PAT mode) — the enterprise consumed-licenses
 * endpoint is App-blocked for installation tokens. syncGithubIdentities enumerates the
 * enterprise's onboarded license orgs (provider_org) and, per org, reads its Copilot SEATS
 * (listOrgCopilotSeats) + externalIdentities (listSamlIdentities) with that org's installation
 * token, then UPSERTs teammate_identity_map keyed by enterprise_slug with the CORRECT license_org.
 * Only SEAT-HOLDERS are bound/provisioned (ADR-0010 rule 1): an SSO org member with no Copilot
 * seat is never provisioned.
 *
 * PAT (SAML) mode is unchanged and covered by github-identity.test.ts (back-compat).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { syncGithubIdentities } from '../../../server/reconciliation/adapters/github-identity'
import type { GithubDirectoryClient } from '../../../server/reconciliation/adapters/github-identity'
import type { SamlIdentity } from '../../../server/reconciliation/adapters/github-client'

let t: TestDb
let teammateId = ''
let entId = ''
const ENT = 'acme-partner-demo'
const ORG = 'acme-org'

// App-mode credential is wired in the DB (github_app_id) + env (App key) so
// resolveEnterpriseCredential returns kind='github-app'. The client is stubbed, so the
// key value is never parsed — NOT PEM-armoured (armour trips secret scanners).
const APP_KEY_B64 = Buffer.from('stub-app-key-never-parsed-by-the-stubbed-client').toString('base64')
process.env.NUXT_GITHUB_APP_KEY_PARTNER_DEMO = APP_KEY_B64

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-ida', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-ida'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.ida', 'ida-bu', 'IDA BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'ida-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-ida', 'veli@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-ida'`
  teammateId = tm!.id

  // App-mode enterprise: github_app_id set, credential_secret_name 'partner-demo'.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name, github_app_id)
    VALUES ('github', ${ENT}, 'Acme Partner Demo', 'reconciled', 'partner-demo', '1234567')`
  const [ent] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM provider_enterprise WHERE external_id = ${ENT}`
  entId = ent!.id
  // The onboarded license org, linked to its enterprise (mig 0038 lane link).
  await t.client`
    INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, provider_enterprise_id)
    VALUES ('github', ${ORG}, 'Acme Org', 'reconciled', ${entId})`
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_APP_KEY_PARTNER_DEMO
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

/* An App-mode stub: per-org Copilot seats + per-org externalIdentities. PAT's listSeats must
 * NOT be called (proves App mode branched correctly). */
function appStubClient(
  seatsByOrg: Record<string, { login: string; org: string }[]>,
  samlByOrg: Record<string, SamlIdentity[]>,
): GithubDirectoryClient {
  return {
    listSeats: async () => {
      throw new Error('listSeats must not be called in App mode')
    },
    listOrgCopilotSeats: async (org: string) => seatsByOrg[org] ?? [],
    listSamlIdentities: async (org: string) => samlByOrg[org] ?? [],
  }
}

const deps = (client: GithubDirectoryClient) => ({
  clientFor: () => client,
  now: () => new Date('2026-06-08T00:00:00.000Z'),
  // Provisioning disabled (ADR-0010 rule 1): a seat-holder whose SSO email matches no teammate
  // must carry forward (NOT be provisioned) so this suite tests the mapping/binding path in
  // isolation, without touching Graph/placement. The provisioning path is covered elsewhere.
  provisionSeatHolder: async () => null,
})

async function mapRows() {
  return t.client<{ identifier: string; teammate_id: string; enterprise_slug: string; sso_email: string; license_org: string | null; source: string }[]>`
    SELECT identifier, teammate_id::text AS teammate_id, enterprise_slug, sso_email, license_org, source
    FROM teammate_identity_map WHERE system = 'github' ORDER BY identifier`
}

describe('syncGithubIdentities (App mode, per-org seats + externalIdentities)', () => {
  it('binds ONLY seat-holders with an SSO email; a non-seat SSO member is never bound/provisioned; license_org is set', async () => {
    const client = appStubClient(
      { [ORG]: [{ login: 'octocat', org: ORG }, { login: 'stranger', org: ORG }] },
      {
        [ORG]: [
          { login: 'octocat', ssoEmail: 'veli@example.com' }, // seat + resolves → upserted
          { login: 'stranger', ssoEmail: 'stranger@elsewhere.com' }, // seat but no teammate → carry forward
          { login: 'ghost', ssoEmail: 'ghost@example.com' }, // SSO member but NOT a seat → ignored
        ],
      },
    )
    const res = await syncGithubIdentities(t.db, deps(client))
    expect(res).toEqual({ provider: 'github', upserts: 1 })

    const rows = await mapRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      identifier: 'octocat',
      teammate_id: teammateId,
      enterprise_slug: ENT,
      sso_email: 'veli@example.com',
      // Per-org path populates the license org (unlike the old consumed-licenses NULL).
      license_org: ORG,
      source: 'directory-sync',
    })
    // 'ghost' (a non-seat SSO member) is never bound; provisioning disabled → 'stranger' carried
    // forward. Neither should have been provisioned as a teammate.
    const strays = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM teammate WHERE email IN ('ghost@example.com','stranger@elsewhere.com')`
    expect(strays[0]!.c).toBe('0')
  })

  it('is idempotent across a second run (UPSERT, not duplicate)', async () => {
    const client = appStubClient(
      { [ORG]: [{ login: 'octocat', org: ORG }] },
      { [ORG]: [{ login: 'octocat', ssoEmail: 'veli@example.com' }] },
    )
    await syncGithubIdentities(t.db, deps(client))
    await syncGithubIdentities(t.db, deps(client))
    expect(await mapRows()).toHaveLength(1)
  })

  it('isolates ONE org whose externalIdentities bridge throws, keeping the enterprise alive', async () => {
    const client: GithubDirectoryClient = {
      listSeats: async () => [],
      listOrgCopilotSeats: async (org: string) => (org === ORG ? [{ login: 'octocat', org: ORG }] : []),
      listSamlIdentities: async () => {
        throw new Error('externalIdentities unavailable (org not SSO-authorised)')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await syncGithubIdentities(t.db, deps(client))
    expect(res.upserts).toBe(0)
    expect(await mapRows()).toHaveLength(0)
    warn.mockRestore()
  })

  it('warns (not throws) and upserts nothing when no license org is onboarded (provider_org empty)', async () => {
    await t.client`DELETE FROM provider_org WHERE external_org_id = ${ORG}`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const client = appStubClient(
        { [ORG]: [{ login: 'octocat', org: ORG }] },
        { [ORG]: [{ login: 'octocat', ssoEmail: 'veli@example.com' }] },
      )
      const res = await syncGithubIdentities(t.db, deps(client))
      expect(res.upserts).toBe(0)
      expect(await mapRows()).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no license orgs onboarded'))
    } finally {
      warn.mockRestore()
      // Restore the org so test ordering can't leak this deletion.
      await t.client`
        INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, provider_enterprise_id)
        VALUES ('github', ${ORG}, 'Acme Org', 'reconciled', ${entId})`
    }
  })
})
