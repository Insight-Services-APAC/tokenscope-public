// @vitest-environment node
/*
 * server/reconciliation/github-coverage.ts — LIVE coverage computation, against a
 * REAL testcontainers DB (provider_enterprise / provider_org are read for real; only
 * the GitHub network layer is injected via buildClient/resolveCredential overrides —
 * mirrors github-health.test.ts's "real DB, mocked provider" convention).
 *
 * Covers:
 *   - PAT-mode enterprise ⇒ census unavailable (not-app-mode), no per-org probing at all
 *   - capability probe: granted / denied (401/403) / unknown (network/5xx)
 *   - a capability DENIAL still classifies KNOWN rows (mislinked/suspended/not-onboarded/
 *     connected) directly from the installation probe — the "authoritative fallback"
 *   - a capped census ⇒ denominator null even though the pull "succeeded"
 *   - the per-pass probe bound (probesCapped) also forces the denominator null
 *   - secrets never appear anywhere in the returned result
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  computeEnterpriseCoverage,
  probeInstallableOrganizationsCapability,
  type CoverageEnterpriseRow,
} from '../../../server/reconciliation/github-coverage'
import type { GithubAppAuth, InstallationDetail } from '../../../server/reconciliation/adapters/github-app-auth'
import type { GithubCopilotClient } from '../../../server/reconciliation/adapters/github-client'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'
import { persistEnterpriseCoverage } from '../../../server/reconciliation/coverage-store'

let t: TestDb
let couId = ''
const FAKE_APP_KEY = 'ZmFrZS1hcHAta2V5LWRvLW5vdC1sZWFrLTEyMzQ1' // base64, never a real PEM

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.client<{ id: string }[]>`
    INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'gc', 'GC') RETURNING id::text AS id`
  const [ou] = await t.client<{ id: string }[]>`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'gc.b', 'gc-bu', 'GC BU', 'bu') RETURNING id::text AS id`
  couId = ou!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

async function insertEnterprise(externalId: string, githubAppId: string | null): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    INSERT INTO provider_enterprise (id, provider, external_id, display_name, github_app_id)
    VALUES (gen_random_uuid(), 'github', ${externalId}, ${externalId}, ${githubAppId})
    RETURNING id::text AS id`
  return row!.id
}

async function insertOrg(args: {
  externalOrgId: string
  providerEnterpriseId?: string | null
  costOwningUnitId?: string | null
}): Promise<string> {
  const [row] = await t.client<{ id: string }[]>`
    INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
    VALUES ('github', ${args.externalOrgId}, ${args.externalOrgId}, ${args.providerEnterpriseId ?? null}, ${args.costOwningUnitId ?? null})
    RETURNING id::text AS id`
  return row!.id
}

/** A fake App-mode client whose listInstallableOrganizations is fully controlled. */
function fakeClient(
  behavior: () => Promise<{ organizations: Array<{ id: number; login: string }>; pagesCapped: boolean; shortPageBreak: boolean }>,
): Pick<GithubCopilotClient, 'listInstallableOrganizations'> {
  return { listInstallableOrganizations: behavior } as unknown as Pick<GithubCopilotClient, 'listInstallableOrganizations'>
}

/** A fake GithubAppAuth whose orgInstallationDetail is driven by a per-login map. */
function fakeAppAuth(details: Record<string, InstallationDetail>): GithubAppAuth {
  return {
    orgInstallationDetail: async (org: string) => details[org] ?? { status: 'not-found' },
  } as unknown as GithubAppAuth
}

const alwaysResolveCredential = async (): Promise<ResolvedCredential> => ({
  secretName: 'test-app',
  value: FAKE_APP_KEY,
  level: 'enterprise',
  kind: 'github-app',
  appId: '999999',
})

describe('computeEnterpriseCoverage — PAT-mode short-circuit', () => {
  it('a PAT-mode enterprise (no github_app_id) never probes at all: census unavailable, not-app-mode, no denominator', async () => {
    const id = await insertEnterprise('pat-ent', null)
    const ent: CoverageEnterpriseRow = { enterpriseId: id, externalId: 'pat-ent', githubAppId: null }
    const result = await computeEnterpriseCoverage(t.db, ent)
    expect(result.census).toEqual({ available: false, capped: false, reason: 'not-app-mode', orgCount: null })
    expect(result.orgs).toEqual([])
    expect(result.summary.denominator).toBeNull()
    expect(result.probesCapped).toBe(false)
  })
})

describe('computeEnterpriseCoverage — credential resolution failures', () => {
  it('no credential resolved at all ⇒ census unavailable, no-credential', async () => {
    const id = await insertEnterprise('app-nocred-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: id, externalId: 'app-nocred-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, { resolveCredential: async () => null })
    expect(result.census.available).toBe(false)
    expect(result.census.reason).toBe('no-credential')
    expect(result.summary.denominator).toBeNull()
  })

  it('a MissingGithubAppKeyError from credential resolution ⇒ no-credential (never rethrown)', async () => {
    const id = await insertEnterprise('app-missingkey-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: id, externalId: 'app-missingkey-ent', githubAppId: '123' }
    const { MissingGithubAppKeyError } = await import('../../../server/reconciliation/credentials')
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: async () => {
        throw new MissingGithubAppKeyError('app-missingkey-ent', 'test-app')
      },
    })
    expect(result.census.reason).toBe('no-credential')
  })

  it('a malformed App key (GithubAppAuth constructor throws) ⇒ key-malformed', async () => {
    const id = await insertEnterprise('app-badkey-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: id, externalId: 'app-badkey-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      buildClient: () => {
        throw new Error('github-app-auth: App private key failed to parse (crypto.createPrivateKey rejected it)')
      },
    })
    expect(result.census.reason).toBe('key-malformed')
  })
})

describe('probeInstallableOrganizationsCapability', () => {
  it('granted: returns the organizations + capped flag verbatim', async () => {
    const client = fakeClient(async () => ({
      organizations: [{ id: 1, login: 'foo' }],
      pagesCapped: false,
      shortPageBreak: true,
    }))
    const result = await probeInstallableOrganizationsCapability(client)
    expect(result).toEqual({ status: 'granted', organizations: [{ id: 1, login: 'foo' }], capped: false })
  })

  it('denied: a 401/403 classifies as denied, never as unknown', async () => {
    const client = fakeClient(async () => {
      throw {
        data: { detail: 'enterprises/{ent}/apps/installable_organizations returned HTTP 403', status: 502 },
      }
    })
    const result = await probeInstallableOrganizationsCapability(client)
    expect(result).toEqual({ status: 'denied' })
  })

  it('unknown: a 5xx / network failure classifies as unknown, never as a proven denial', async () => {
    const client = fakeClient(async () => {
      throw { data: { detail: 'enterprises/{ent}/apps/installable_organizations returned HTTP 503', status: 502 } }
    })
    const result = await probeInstallableOrganizationsCapability(client)
    expect(result.status).toBe('unknown')
  })
})

describe('computeEnterpriseCoverage — capability denial still classifies KNOWN rows (the authoritative fallback)', () => {
  it('a denied capability probe still reports a KNOWN suspended org as suspended, and a known connected org as connected — never a blanket coverage-unknown', async () => {
    const entId = await insertEnterprise('denied-ent', '123')
    await insertOrg({ externalOrgId: 'susp-org', providerEnterpriseId: entId, costOwningUnitId: couId })
    await insertOrg({ externalOrgId: 'ok-org', providerEnterpriseId: entId, costOwningUnitId: couId })
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'denied-ent', githubAppId: '123' }

    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      buildClient: () => ({
        client: fakeClient(async () => {
          throw { data: { detail: 'installable_organizations returned HTTP 403', status: 502 } }
        }),
        appAuth: fakeAppAuth({
          'susp-org': { status: 'suspended', installationId: 1, appId: 999999 },
          'ok-org': { status: 'active', installationId: 2, appId: 999999 },
        }),
      }),
    })

    expect(result.census.available).toBe(false)
    expect(result.census.reason).toBe('capability-denied')
    expect(result.summary.denominator).toBeNull() // no N-of-M claim
    const byOrg = Object.fromEntries(result.orgs.map((o) => [o.org, o.state]))
    expect(byOrg['susp-org']).toBe('suspended')
    expect(byOrg['ok-org']).toBe('connected')
  })
})

describe('computeEnterpriseCoverage — census capped/probe-bounded suppresses the denominator', () => {
  it('a capped (but "successful") census pull never yields a denominator', async () => {
    const entId = await insertEnterprise('capped-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'capped-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      buildClient: () => ({
        client: fakeClient(async () => ({
          organizations: [
            { id: 1, login: 'a' },
            { id: 2, login: 'b' },
          ],
          pagesCapped: true,
          shortPageBreak: false,
        })),
        appAuth: fakeAppAuth({
          a: { status: 'active', installationId: 1, appId: 999999 },
          b: { status: 'active', installationId: 2, appId: 999999 },
        }),
      }),
    })
    expect(result.census.available).toBe(true)
    expect(result.census.capped).toBe(true)
    expect(result.summary.denominator).toBeNull()
  })

  it('hitting the per-pass org-probe bound also forces the denominator null, even with an uncapped census', async () => {
    const entId = await insertEnterprise('probebound-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'probebound-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      maxOrgProbes: 1,
      buildClient: () => ({
        client: fakeClient(async () => ({
          organizations: [
            { id: 1, login: 'a' },
            { id: 2, login: 'b' },
          ],
          pagesCapped: false,
          shortPageBreak: true,
        })),
        appAuth: fakeAppAuth({
          a: { status: 'active', installationId: 1, appId: 999999 },
          b: { status: 'active', installationId: 2, appId: 999999 },
        }),
      }),
    })
    expect(result.probesCapped).toBe(true)
    expect(result.orgs).toHaveLength(1)
    expect(result.summary.denominator).toBeNull()
  })

  it('a later bounded pass advances to an unobserved org instead of re-probing the same prefix', async () => {
    const entId = await insertEnterprise('probe-progress-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'probe-progress-ent', githubAppId: '123' }
    const opts = {
      resolveCredential: alwaysResolveCredential,
      maxOrgProbes: 1,
      buildClient: () => ({
        client: fakeClient(async () => ({
          organizations: [
            { id: 1, login: 'a' },
            { id: 2, login: 'b' },
          ],
          pagesCapped: false,
          shortPageBreak: true,
        })),
        appAuth: fakeAppAuth({
          a: { status: 'active', installationId: 1, appId: 999999 },
          b: { status: 'active', installationId: 2, appId: 999999 },
        }),
      }),
    }

    const first = await computeEnterpriseCoverage(t.db, ent, opts)
    expect(first.orgs.map((o) => o.org)).toEqual(['a'])
    await persistEnterpriseCoverage(t.db, first, { now: new Date('2026-07-01T00:00:00Z') })

    const second = await computeEnterpriseCoverage(t.db, ent, opts)
    expect(second.orgs.map((o) => o.org)).toEqual(['b'])
  })

  it('the fully happy path (granted, uncapped, under the probe bound) yields an honest N-of-M', async () => {
    const entId = await insertEnterprise('happy-ent', '123')
    await insertOrg({ externalOrgId: 'onboarded', providerEnterpriseId: entId, costOwningUnitId: couId })
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'happy-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      buildClient: () => ({
        client: fakeClient(async () => ({
          organizations: [
            { id: 1, login: 'onboarded' },
            { id: 2, login: 'not-installed-org' },
          ],
          pagesCapped: false,
          shortPageBreak: true,
        })),
        appAuth: fakeAppAuth({
          onboarded: { status: 'active', installationId: 1, appId: 999999 },
          'not-installed-org': { status: 'not-found' },
        }),
      }),
    })
    expect(result.census).toEqual({ available: true, capped: false, reason: null, orgCount: 2 })
    expect(result.summary.denominator).toBe(2)
    expect(result.summary.connected).toBe(1)
    expect(result.summary.states['not-installed']).toBe(1)
  })
})

describe('computeEnterpriseCoverage — secrets never leak', () => {
  it('the App key / secret value never appears anywhere in the returned result', async () => {
    const entId = await insertEnterprise('secret-ent', '123')
    const ent: CoverageEnterpriseRow = { enterpriseId: entId, externalId: 'secret-ent', githubAppId: '123' }
    const result = await computeEnterpriseCoverage(t.db, ent, {
      resolveCredential: alwaysResolveCredential,
      buildClient: () => ({
        client: fakeClient(async () => ({ organizations: [{ id: 1, login: 'x' }], pagesCapped: false, shortPageBreak: true })),
        appAuth: fakeAppAuth({ x: { status: 'active', installationId: 1, appId: 999999 } }),
      }),
    })
    const dump = JSON.stringify(result)
    expect(dump).not.toContain(FAKE_APP_KEY)
  })
})
