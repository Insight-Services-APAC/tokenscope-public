// @vitest-environment node
/*
 * POST /github/discover-orgs — read a GitHub enterprise's PAT seat roster and
 * auto-create the provider_org rows for its license-orgs (ADR-0010 onboarding: the
 * admin shouldn't hand-type/guess orgs the enterprise PAT can list). DB path against
 * testcontainers Postgres; the GitHub client is mocked (no live calls).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import discoverOrgs from '../../../server/api/v1/admin/reconciliation/github/discover-orgs.post'
import * as schema from '../../../drizzle/schema'

// Mutable seat roster + optional failure, shared with the hoisted mock.
const stub = vi.hoisted(() => ({ seats: [] as Array<{ assignee: { login: string }; organization: { login: string } | null }>, fail: null as unknown }))
// vitest hoists vi.mock above all imports, so the discoverOrgs import above still binds
// to this stubbed client despite appearing first in source order.
vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listSeats() {
      if (stub.fail) throw stub.fail
      return stub.seats
    }
    // The endpoint now constructs via the PAT factory static (App-mode split, mig 0078);
    // the mock mirrors it so discover-orgs still resolves to this stub.
    static withPat() {
      return new GithubCopilotClient()
    }
  }
  return { GithubCopilotClient }
})

let t: TestDb
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''
let entId = ''

process.env.NUXT_GITHUB_PAT_DISC = 'stub-pat-not-used'

function ev(opts: { session: Session; body?: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof discoverOrgs>[0]
}
const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })

async function orgRows() {
  return t.client<{ external_org_id: string; provider_enterprise_id: string | null }[]>`
    SELECT external_org_id, provider_enterprise_id::text AS provider_enterprise_id
    FROM provider_org WHERE provider = 'github' ORDER BY external_org_id`
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'd-r', displayName: 'D R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'd.svc', code: 'd-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-d-a', email: 'a@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-d-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
}, 180_000)

afterAll(async () => { await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM provider_org WHERE provider = 'github'`
  await t.client`DELETE FROM provider_enterprise WHERE provider = 'github'`
  stub.seats = []
  stub.fail = null
  const [e] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: 'disc-ent', displayName: 'Disc Ent', reconciliationMode: 'reconciled', credentialSecretName: 'disc',
  }).returning()
  entId = e!.id
})

describe('github discover-orgs', () => {
  it('creates a provider_org per distinct license-org, linked to the enterprise + audited', async () => {
    stub.seats = [
      { assignee: { login: 'u1' }, organization: { login: 'Acme-Eng' } }, // mixed case → lowercased
      { assignee: { login: 'u2' }, organization: { login: 'acme-eng' } }, // dupe of the above
      { assignee: { login: 'u3' }, organization: { login: 'acme-demo' } },
    ]
    const res = (await discoverOrgs(ev({ session: admin(), body: { enterpriseId: entId } }))) as { discovered: number; created: number }
    expect(res).toMatchObject({ discovered: 2, created: 2 })
    const rows = await orgRows()
    expect(rows.map((r) => r.external_org_id)).toEqual(['acme-demo', 'acme-eng'])
    expect(rows.every((r) => r.provider_enterprise_id === entId)).toBe(true)
    const audits = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = 'provider-org-discovered'`
    expect(Number(audits[0]!.n)).toBe(2)
  })

  it('is idempotent — a second run creates nothing (alreadyLinked)', async () => {
    stub.seats = [{ assignee: { login: 'u1' }, organization: { login: 'acme-eng' } }]
    await discoverOrgs(ev({ session: admin(), body: { enterpriseId: entId } }))
    const res = (await discoverOrgs(ev({ session: admin(), body: { enterpriseId: entId } }))) as { created: number; alreadyLinked: number }
    expect(res).toMatchObject({ created: 0, alreadyLinked: 1 })
    expect((await orgRows()).length).toBe(1)
  })

  it('links an existing UNLINKED org without overwriting its region', async () => {
    // Pre-existing org with a region set but no enterprise link.
    await t.client`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, region_id)
      VALUES ('github', 'acme-eng', 'Acme Eng', 'reconciled', 'tracked', ${regionId}::uuid)`
    stub.seats = [{ assignee: { login: 'u1' }, organization: { login: 'acme-eng' } }]
    const res = (await discoverOrgs(ev({ session: admin(), body: { enterpriseId: entId } }))) as { created: number; linked: number }
    expect(res).toMatchObject({ created: 0, linked: 1 })
    const [row] = await t.client<{ provider_enterprise_id: string; region_id: string }[]>`
      SELECT provider_enterprise_id::text AS provider_enterprise_id, region_id::text AS region_id
      FROM provider_org WHERE external_org_id = 'acme-eng'`
    expect(row!.provider_enterprise_id).toBe(entId) // now linked
    expect(row!.region_id).toBe(regionId) // region preserved, NOT overwritten
  })

  it('returns 422 { reason: no-key } when the enterprise has no PAT', async () => {
    await t.client`UPDATE provider_enterprise SET credential_secret_name = NULL WHERE id = ${entId}::uuid`
    const e = ev({ session: admin(), body: { enterpriseId: entId } })
    const res = (await discoverOrgs(e)) as { reason: string }
    expect(res.reason).toBe('no-key')
    expect((e as unknown as { node: { res: { statusCode: number } } }).node.res.statusCode).toBe(422)
  })

  it('maps a 403 PAT failure to reason 403-forbidden-scope (no key leak)', async () => {
    stub.fail = { data: { detail: 'seats returned HTTP 403' } }
    const res = (await discoverOrgs(ev({ session: admin(), body: { enterpriseId: entId } }))) as { reason: string }
    expect(res.reason).toBe('403-forbidden-scope')
  })

  it('a developer is rejected (RBAC)', async () => {
    await expect(discoverOrgs(ev({ session: dev(), body: { enterpriseId: entId } }))).rejects.toMatchObject({ statusCode: 403 })
  })
})
