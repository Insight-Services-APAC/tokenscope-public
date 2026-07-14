// @vitest-environment node
/*
 * GitHub Copilot identity resolver — DB path against testcontainers Postgres.
 *
 * Exercises syncGithubIdentities with a STUBBED directory client: it UPSERTs
 * teammate_identity_map for a login whose SSO email matches a teammate, carries
 * forward a login with no SSO email or no matching teammate, is idempotent on a
 * second run, records a per-enterprise summary audit, and (M-3) cannot clobber a
 * human self-service link that sits in the enterprise_slug=NULL lane.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { syncGithubIdentities } from '../../../server/reconciliation/adapters/github-identity'
import type {
  GithubDirectoryClient,
  SeatHolderProvisioner,
} from '../../../server/reconciliation/adapters/github-identity'
import type { GithubSeat, SamlIdentity } from '../../../server/reconciliation/adapters/github-client'

let t: TestDb
let teammateId = ''
const ENT = 'acme-partner-demo'

// Set the env credential so resolveEnterpriseCredential() returns a value for the
// seeded provider_enterprise (credential_secret_name='partner-demo'). The value is
// never used (the client is stubbed), only its presence gates the sync.
process.env.NUXT_GITHUB_PAT_PARTNER_DEMO = 'stub-pat-not-used'

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-id', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-id'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.id', 'id-bu', 'ID BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'id-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-id', 'veli@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-id'`
  teammateId = tm!.id

  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${ENT}, 'Acme Partner Demo', 'reconciled', 'partner-demo')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

function stubClient(seats: GithubSeat[], saml: Record<string, SamlIdentity[]>): GithubDirectoryClient {
  return {
    listSeats: async () => seats,
    listSamlIdentities: async (org: string) => saml[org] ?? [],
  }
}

function seat(login: string, org: string): GithubSeat {
  return { assignee: { login }, organization: { login: org } } as GithubSeat
}

// By default these tests DISABLE bill-driven provisioning (provisioner returns null →
// carry-forward), so the mapping assertions stay focused. The provisioning path is
// exercised explicitly in its own test (ADR-0010 rule 1) with a recording stub.
const deps = (client: GithubDirectoryClient, provisionSeatHolder?: SeatHolderProvisioner) => ({
  clientFor: () => client,
  now: () => new Date('2026-06-08T00:00:00.000Z'),
  provisionSeatHolder: provisionSeatHolder ?? (async () => null),
})

async function mapRows() {
  return t.client<{ identifier: string; teammate_id: string; enterprise_slug: string; sso_email: string; source: string }[]>`
    SELECT identifier, teammate_id::text AS teammate_id, enterprise_slug, sso_email, source
    FROM teammate_identity_map WHERE system = 'github' ORDER BY identifier`
}

describe('syncGithubIdentities (DB path)', () => {
  it('upserts a resolvable login and carries forward the unresolvable ones (provisioning off)', async () => {
    const client = stubClient(
      [seat('octocat', 'acme'), seat('no-email', 'acme'), seat('no-teammate', 'acme')],
      {
        acme: [
          { login: 'octocat', ssoEmail: 'veli@example.com' },
          { login: 'no-teammate', ssoEmail: 'stranger@elsewhere.com' },
          // 'no-email' is absent from SAML -> carried forward (no sso email).
        ],
      },
    )
    // Provisioning disabled (deps default) → 'no-teammate' carries forward as before.
    const res = await syncGithubIdentities(t.db, deps(client))
    expect(res).toEqual({ provider: 'github', upserts: 1 })

    const rows = await mapRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      identifier: 'octocat',
      teammate_id: teammateId,
      enterprise_slug: ENT,
      sso_email: 'veli@example.com',
      source: 'directory-sync',
    })
    // CANONICAL CASING (P1-7 / mig 0062): enterprise_slug is written lowercase so it
    // agrees with the unique index, the roster reader, and the credential resolver.
    expect(rows[0]!.enterprise_slug).toBe(rows[0]!.enterprise_slug.toLowerCase())
  })

  it('PROVISIONS a seat-holder with a SAML email but no teammate, then maps them (ADR-0010 rule 1)', async () => {
    // The bill is proof the user exists: a login with a provider-attested SAML email but
    // no teammate is bill-driven-PROVISIONED (region-floored to the license-org), NOT
    // dropped. Here the provisioner stub stands in for provisionAndPlace + creates the
    // teammate the way the real path would, and we assert (a) it was invoked with the SSO
    // email + the license-org's region floor (null — 'acme' isn't mapped), and (b) the
    // login is then bound to the provisioned teammate.
    // The stub stands in for provisionAndPlace: on the SSO email it CREATES the bill
    // teammate (as the real path does) and returns its id. Because no teammate exists for
    // that email yet, resolveTeammateId misses first → the provisioning branch fires.
    const calls: Array<{ email: string; fallbackRegionId: string | null }> = []
    const provisioner: SeatHolderProvisioner = async ({ email, fallbackRegionId }) => {
      calls.push({ email, fallbackRegionId })
      if (email !== 'stranger@elsewhere.com') return null
      await t.client`
        INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
        SELECT gen_random_uuid(), 'bill:stranger', ${email}, ou.region_id, ou.id
        FROM org_unit ou WHERE ou.code = 'id-bu'`
      const [p] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'bill:stranger'`
      return p!.id
    }
    const client = stubClient([seat('no-teammate', 'acme')], {
      acme: [{ login: 'no-teammate', ssoEmail: 'stranger@elsewhere.com' }],
    })

    const res = await syncGithubIdentities(t.db, deps(client, provisioner))
    expect(res.upserts).toBe(1)
    expect(calls).toEqual([{ email: 'stranger@elsewhere.com', fallbackRegionId: null }])

    const [prov] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'bill:stranger'`
    const rows = await mapRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ identifier: 'no-teammate', teammate_id: prov!.id, source: 'directory-sync' })
  })

  it('is idempotent and refreshes on a second run (UPSERT, not duplicate)', async () => {
    const client = stubClient([seat('octocat', 'acme')], {
      acme: [{ login: 'octocat', ssoEmail: 'veli@example.com' }],
    })
    await syncGithubIdentities(t.db, deps(client))
    await syncGithubIdentities(t.db, deps(client))
    const rows = await mapRows()
    expect(rows).toHaveLength(1)
  })

  it('records a per-enterprise summary audit event', async () => {
    const client = stubClient([seat('octocat', 'acme')], {
      acme: [{ login: 'octocat', ssoEmail: 'veli@example.com' }],
    })
    const before = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM audit_event WHERE event_type = 'identity-sync-github'`
    await syncGithubIdentities(t.db, deps(client))
    const audits = await t.client<{ subject_kind: string; payload: { after: { upserts: number }; context: { enterpriseSlug: string } } }[]>`
      SELECT subject_kind, payload FROM audit_event
      WHERE event_type = 'identity-sync-github' ORDER BY ts_recorded DESC LIMIT 1`
    const after = await t.client<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM audit_event WHERE event_type = 'identity-sync-github'`
    expect(Number(after[0]!.c) - Number(before[0]!.c)).toBe(1)
    expect(audits[0]!.subject_kind).toBe('provider_enterprise')
    expect(audits[0]!.payload.context.enterpriseSlug).toBe(ENT)
    expect(audits[0]!.payload.after.upserts).toBe(1)
  })

  it('degrades an org whose SAML bridge is unavailable, keeping the others', async () => {
    const client: GithubDirectoryClient = {
      listSeats: async () => [seat('octocat', 'good-org'), seat('other', 'bad-org')],
      listSamlIdentities: async (org: string) => {
        if (org === 'bad-org') throw new Error('SAML unavailable (not SSO-authorised)')
        return [{ login: 'octocat', ssoEmail: 'veli@example.com' }]
      },
    }
    const res = await syncGithubIdentities(t.db, deps(client))
    expect(res.upserts).toBe(1)
    const rows = await mapRows()
    expect(rows.map((r) => r.identifier)).toEqual(['octocat'])
  })

  // R3 M-3 anti-claim-jacking: the directory-sync UPSERT lands in its own
  // (system, enterprise_slug, login) lane and cannot clobber a human self-service
  // link, which lives in the enterprise_slug=NULL (COALESCE '') lane. Stream A's
  // migration 0041 dropped the leftover narrow `teammate_identity_map_system_identifier_key`
  // constraint that previously shadowed 0038's widened key and blocked this.
  it('cannot clobber a self-service link in the enterprise_slug=NULL lane (M-3)', async () => {
    // A human self-service POST owns the (github, NULL-slug, login) lane.
    await t.client`
      INSERT INTO teammate_identity_map
        (teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug, sso_email, source)
      VALUES
        (${teammateId}, 'github', 'octocat', 'username', 'octocat', NULL, 'self@example.com', 'self-service')`

    const client = stubClient([seat('octocat', 'acme')], {
      acme: [{ login: 'octocat', ssoEmail: 'veli@example.com' }],
    })
    await syncGithubIdentities(t.db, deps(client))

    // Two distinct rows now exist: the self-service (NULL slug) and the directory
    // (enterprise slug) — the directory UPSERT lands in its own lane, untouched.
    const rows = await mapRows()
    expect(rows).toHaveLength(2)
    const selfRow = rows.find((r) => r.enterprise_slug === null)
    const dirRow = rows.find((r) => r.enterprise_slug === ENT)
    expect(selfRow!.source).toBe('self-service')
    expect(selfRow!.sso_email).toBe('self@example.com')
    expect(dirRow!.source).toBe('directory-sync')
  })
})
