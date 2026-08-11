// @vitest-environment node
/*
 * server/workers/github-coverage-sweep.ts — transitions, dedupe, stale-expiry
 * interplay, and run-warning wiring. Real testcontainers DB; GitHub client + App-auth
 * mocked (no live calls) — mirrors github-coverage-routes.test.ts's convention.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
// vitest hoists vi.mock above all imports, so these still bind the mocked modules below.
import { runGithubCoverageSweep } from '../../../server/workers/github-coverage-sweep'
import { deriveRunWarnings } from '../../../server/reconciliation/run-warnings'

const stub = vi.hoisted(() => ({
  organizations: [] as Array<{ id: number; login: string }>,
  failCensus: null as unknown,
  installationDetails: {} as Record<string, { status: string; installationId?: number; appId?: number }>,
}))

vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listInstallableOrganizations() {
      if (stub.failCensus) throw stub.failCensus
      return { organizations: stub.organizations, pagesCapped: false, shortPageBreak: true }
    }
    static withApp(..._args: unknown[]) {
      return new GithubCopilotClient()
    }
    static withPat(..._args: unknown[]) {
      return new GithubCopilotClient()
    }
  }
  return { GithubCopilotClient }
})
vi.mock('../../../server/reconciliation/adapters/github-app-auth', () => {
  class GithubAppAuth {
    constructor(
      public appId: string,
      public value: string,
    ) {}
    async orgInstallationDetail(org: string) {
      return stub.installationDetails[org] ?? { status: 'not-found' }
    }
  }
  return { GithubAppAuth }
})

let t: TestDb
process.env.NUXT_GITHUB_APP_KEY_SWEEP = 'stub-app-key-mocked-auth-never-parses-it'

async function insertEnterprise(externalId: string, githubAppId: string | null): Promise<string> {
  const [e] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId, displayName: externalId, credentialSecretName: 'sweep', githubAppId })
    .returning()
  return e!.id
}

async function openInboxCount(enterpriseId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM inbox_item
    WHERE category = 'github-coverage-gap' AND related_entity_kind = 'provider-enterprise'
      AND related_entity_id = ${enterpriseId}::uuid AND ack_state <> 'resolved'`
  return Number(rows[0]!.n)
}
async function resolvedInboxCount(enterpriseId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM inbox_item
    WHERE category = 'github-coverage-gap' AND related_entity_kind = 'provider-enterprise'
      AND related_entity_id = ${enterpriseId}::uuid AND ack_state = 'resolved'`
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  // An active platform-admin so dispatchInbox has a real recipient (never a
  // ZERO-recipient drop) — the "github-coverage-gap" category is admin-routed.
  const [r] = await t.db.insert(schema.region).values({ code: 'sweep-r', displayName: 'Sweep R' }).returning()
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId: r!.id, path: 'sweep.svc', code: 'sweep-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  await t.db.insert(schema.teammate).values({ entraOid: 'oid-sweep-admin', email: 'sweep-admin@x.test', role: 'platform-admin', regionId: r!.id, orgUnitId: o!.id })
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM inbox_item WHERE category = 'github-coverage-gap'`
  await t.client`DELETE FROM provider_org_coverage`
  await t.client`DELETE FROM provider_enterprise_coverage_census`
  await t.client`DELETE FROM provider_org WHERE provider = 'github'`
  await t.client`DELETE FROM provider_enterprise WHERE provider = 'github'`
  stub.organizations = []
  stub.failCensus = null
  stub.installationDetails = {}
})

describe('runGithubCoverageSweep — bounded, per-enterprise isolation', () => {
  it('a PAT-mode enterprise is a cheap no-op: no error, no alert, swept nonetheless', async () => {
    await insertEnterprise('sweep-pat-ent', null)
    const result = await runGithubCoverageSweep(t.db)
    expect(result.enterprisesSwept).toBe(1)
    expect(result.coverageComputeErrors).toBe(0)
    expect(result.newAlerts).toBe(0)
    expect(result.censusUnknownEnterprises).toBe(1) // no denominator — but not an ERROR
  })

  it('reports the run-warning counters run-warnings.ts actually probes', async () => {
    const entId = await insertEnterprise('sweep-warn-ent', '1')
    stub.organizations = [{ id: 1, login: 'gap-org' }]
    stub.installationDetails = { 'gap-org': { status: 'not-found' } }
    const result = await runGithubCoverageSweep(t.db)
    expect(result.nonConnectedOrgs).toBe(1)
    const warnings = deriveRunWarnings(result)
    expect(warnings.some((w) => w.includes('1 GitHub org(s) are not connected'))).toBe(true)
    void entId
  })
})

describe('runGithubCoverageSweep — transitions + dedupe (the prior-vs-new comparison IS the dedup key)', () => {
  it('a FIRST-seen non-connected org dispatches exactly one alert', async () => {
    const entId = await insertEnterprise('sweep-first-ent', '1')
    stub.organizations = [{ id: 1, login: 'newly-gapped' }]
    stub.installationDetails = { 'newly-gapped': { status: 'not-found' } }
    const result = await runGithubCoverageSweep(t.db)
    expect(result.newAlerts).toBe(1)
    expect(await openInboxCount(entId)).toBe(1)
  })

  it('a SECOND sweep with the SAME state dispatches NO new alert (dedup)', async () => {
    const entId = await insertEnterprise('sweep-dedupe-ent', '1')
    stub.organizations = [{ id: 1, login: 'stuck-org' }]
    stub.installationDetails = { 'stuck-org': { status: 'not-found' } }
    await runGithubCoverageSweep(t.db)
    const second = await runGithubCoverageSweep(t.db)
    expect(second.newAlerts).toBe(0)
    expect(await openInboxCount(entId)).toBe(1) // still exactly one open alert, not two
  })

  it('overlapping producers cannot create duplicate open alerts from the same prior state', async () => {
    const entId = await insertEnterprise('sweep-race-ent', '1')
    stub.organizations = [{ id: 1, login: 'racing-org' }]
    stub.installationDetails = { 'racing-org': { status: 'not-found' } }

    const results = await Promise.all([
      runGithubCoverageSweep(t.db),
      runGithubCoverageSweep(t.db),
    ])

    expect(results.reduce((sum, r) => sum + r.newAlerts, 0)).toBe(1)
    expect(await openInboxCount(entId)).toBe(1)
  })

  it('a state CHANGE between two non-connected states dispatches a fresh alert', async () => {
    await insertEnterprise('sweep-change-ent', '1')
    stub.organizations = [{ id: 1, login: 'shifting-org' }]
    stub.installationDetails = { 'shifting-org': { status: 'not-found' } }
    const first = await runGithubCoverageSweep(t.db)
    expect(first.newAlerts).toBe(1)

    stub.installationDetails = { 'shifting-org': { status: 'suspended', installationId: 1, appId: 1 } }
    const second = await runGithubCoverageSweep(t.db)
    expect(second.newAlerts).toBe(1) // not-installed -> suspended is a genuine transition
  })

  it('a transition back to connected AUTO-RESOLVES the open alert, with no new alert', async () => {
    const entId = await insertEnterprise('sweep-resolve-ent', '1')
    await t.client`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
      SELECT 'github', 'recovering-org', 'recovering-org', ${entId}, id FROM org_unit LIMIT 1`
    stub.organizations = [{ id: 1, login: 'recovering-org' }]
    stub.installationDetails = { 'recovering-org': { status: 'suspended', installationId: 1, appId: 1 } }
    const first = await runGithubCoverageSweep(t.db)
    expect(first.newAlerts).toBe(1)
    expect(await openInboxCount(entId)).toBe(1)

    stub.installationDetails = { 'recovering-org': { status: 'active', installationId: 1, appId: 1 } }
    const second = await runGithubCoverageSweep(t.db)
    expect(second.newAlerts).toBe(0)
    expect(second.autoResolved).toBe(1)
    expect(await openInboxCount(entId)).toBe(0)
    expect(await resolvedInboxCount(entId)).toBe(1)
  })

  it('a capability LOSS (available -> unavailable) dispatches an enterprise-level alert; recovery auto-resolves it', async () => {
    const entId = await insertEnterprise('sweep-capability-ent', '1')
    // Homed properly so the FIRST sweep is genuinely 'connected' (no org-level alert
    // muddying this capability-only test) — mirrors the 'recovering-org' pattern above.
    await t.client`INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
      SELECT 'github', 'irrelevant-org', 'irrelevant-org', ${entId}, id FROM org_unit LIMIT 1`
    stub.organizations = [{ id: 1, login: 'irrelevant-org' }]
    stub.installationDetails = { 'irrelevant-org': { status: 'active', installationId: 1, appId: 1 } }
    const healthy = await runGithubCoverageSweep(t.db)
    expect(healthy.newAlerts).toBe(0) // healthy census, no capability alert

    stub.failCensus = { data: { detail: 'installable_organizations returned HTTP 403', status: 502 } }
    const lost = await runGithubCoverageSweep(t.db)
    expect(lost.newAlerts).toBe(1)
    expect(await openInboxCount(entId)).toBe(1)

    stub.failCensus = null
    const recovered = await runGithubCoverageSweep(t.db)
    expect(recovered.autoResolved).toBe(1)
    expect(await openInboxCount(entId)).toBe(0)
  })
})

describe('runGithubCoverageSweep — processes every registered enterprise in one tick', () => {
  it('a PAT-mode enterprise and an App-mode enterprise are BOTH swept in the same tick (no early-exit)', async () => {
    const patId = await insertEnterprise('sweep-multi-pat-ent', null)
    const appId = await insertEnterprise('sweep-multi-app-ent', '1')
    stub.organizations = [{ id: 1, login: 'ok-org' }]
    stub.installationDetails = { 'ok-org': { status: 'active', installationId: 1, appId: 1 } }
    const result = await runGithubCoverageSweep(t.db)
    expect(result.enterprisesSwept).toBe(2)
    expect(result.coverageComputeErrors).toBe(0)
    void patId
    void appId
  })
})
