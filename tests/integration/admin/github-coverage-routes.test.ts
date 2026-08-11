// @vitest-environment node
/*
 * GitHub coverage admin routes (Workstream D, design §6):
 *   GET  /api/v1/admin/reconciliation/github/coverage[?enterpriseId=]
 *   POST /api/v1/admin/reconciliation/github/coverage-recheck
 *
 * Real testcontainers DB; the GitHub client + App-auth modules are MOCKED (no live
 * calls) — mirrors github-discover-orgs.test.ts's convention exactly.
 *
 * Covers: RBAC (developer → 403), CSRF (cross-origin POST → 403), Zod (bad
 * enterpriseId → 400), 404 (unknown / non-github enterprise), audit rows, and the
 * live recompute actually persisting + returning a coverage result end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import * as schema from '../../../drizzle/schema'
// vitest hoists vi.mock above all imports, so these handler imports still bind the
// mocked modules below — matches github-discover-orgs.test.ts's convention exactly.
import coverageGet from '../../../server/api/v1/admin/reconciliation/github/coverage.get'
import coverageRecheck from '../../../server/api/v1/admin/reconciliation/github/coverage-recheck.post'

const stub = vi.hoisted(() => ({
  organizations: [] as Array<{ id: number; login: string }>,
  pagesCapped: false,
  failCensus: null as unknown,
  installationDetails: {} as Record<string, { status: string; installationId?: number; appId?: number }>,
}))

vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listInstallableOrganizations() {
      if (stub.failCensus) throw stub.failCensus
      return { organizations: stub.organizations, pagesCapped: stub.pagesCapped, shortPageBreak: !stub.pagesCapped }
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
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''
let entId = ''

process.env.NUXT_GITHUB_APP_KEY_COV = 'stub-app-key-mocked-auth-never-parses-it'

function ev(opts: { session: Session; method: 'GET' | 'POST'; query?: Record<string, string>; body?: unknown; origin?: string | null }) {
  const path = opts.query ? `/x?${new URLSearchParams(opts.query).toString()}` : '/x'
  const headers: Record<string, string> = { host: 'localhost:3450', 'content-type': 'application/json' }
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost:3450'
  const e = {
    method: opts.method,
    path,
    context: { params: {} },
    node: {
      req: { method: opts.method, url: path, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof coverageGet>[0]
}
const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'cov-r', displayName: 'Cov R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'cov.svc', code: 'cov-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-cov-a', email: 'a@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-cov-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM provider_org_coverage`
  await t.client`DELETE FROM provider_enterprise_coverage_census`
  await t.client`DELETE FROM provider_org WHERE provider = 'github'`
  await t.client`DELETE FROM provider_enterprise WHERE provider = 'github'`
  stub.organizations = []
  stub.pagesCapped = false
  stub.failCensus = null
  stub.installationDetails = {}
  const [e] = await t.db
    .insert(schema.providerEnterprise)
    .values({
      provider: 'github',
      externalId: 'cov-ent',
      displayName: 'Cov Ent',
      reconciliationMode: 'reconciled',
      credentialSecretName: 'cov',
      githubAppId: '424242',
    })
    .returning()
  entId = e!.id
})

describe('route source files are not accidentally git-ignored', () => {
  // Regression pin: this repo's .gitignore excludes `coverage/` (the test-coverage-
  // report convention). A route living under a literal `github/coverage/` SUBDIRECTORY
  // would silently match that pattern and never be tracked by git (and never linted) —
  // exactly why coverage-recheck.post.ts is a FLAT file, not github/coverage/recheck.post.ts.
  it('every Workstream D route file is tracked by git (none sit under a colliding coverage/ directory)', () => {
    const files = [
      'server/api/v1/admin/reconciliation/github/coverage.get.ts',
      'server/api/v1/admin/reconciliation/github/coverage-recheck.post.ts',
    ]
    for (const f of files) {
      const result = spawnSync('git', ['check-ignore', '--quiet', f], { cwd: process.cwd() })
      // git check-ignore exits 1 when the path is NOT ignored (the desired outcome).
      expect(result.status, `${f} is git-ignored (likely a coverage/ directory collision)`).toBe(1)
    }
  })
})

describe('GET /admin/reconciliation/github/coverage', () => {
  it('RBAC: a developer is forbidden', async () => {
    await expect(coverageGet(ev({ session: dev(), method: 'GET' }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an invalid enterpriseId is a 400', async () => {
    await expect(coverageGet(ev({ session: admin(), method: 'GET', query: { enterpriseId: 'not-a-uuid' } }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('an unknown enterpriseId is a 404', async () => {
    await expect(
      coverageGet(ev({ session: admin(), method: 'GET', query: { enterpriseId: '00000000-0000-0000-0000-000000000000' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('an enterprise never swept reads as never-observed (available: false, stale: false)', async () => {
    const res = (await coverageGet(ev({ session: admin(), method: 'GET', query: { enterpriseId: entId } }))) as {
      coverage: { census: { available: boolean; stale: boolean } }
    }
    expect(res.coverage.census).toMatchObject({ available: false, stale: false, observedAt: null })
  })

  it('with no enterpriseId, returns coverage for every github enterprise', async () => {
    const res = (await coverageGet(ev({ session: admin(), method: 'GET' }))) as { coverage: Array<{ enterpriseId: string }> }
    expect(res.coverage.some((c) => c.enterpriseId === entId)).toBe(true)
  })
})

describe('POST /admin/reconciliation/github/coverage-recheck', () => {
  it('RBAC: a developer is forbidden', async () => {
    await expect(coverageRecheck(ev({ session: dev(), method: 'POST', body: { enterpriseId: entId } }))).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('CSRF: a cross-origin POST is rejected', async () => {
    await expect(
      coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: entId }, origin: 'https://evil.example.com' })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('Zod: a malformed body is a 400', async () => {
    await expect(coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: 'nope' } }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('404: an unknown enterpriseId', async () => {
    await expect(
      coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: '00000000-0000-0000-0000-000000000000' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('400: a non-github enterprise', async () => {
    const [anth] = await t.db
      .insert(schema.providerEnterprise)
      .values({ provider: 'anthropic', externalId: 'anth-ent', displayName: 'Anth Ent' })
      .returning()
    await expect(coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: anth!.id } }))).rejects.toMatchObject({
      statusCode: 400,
    })
  })

  it('computes live, persists, audits (triggered + completed), and returns the fresh result', async () => {
    stub.organizations = [{ id: 1, login: 'onboard-me' }]
    stub.installationDetails = { 'onboard-me': { status: 'not-found' } }

    const res = (await coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: entId } }))) as {
      result: { census: { available: boolean; orgCount: number }; summary: { denominator: number | null; states: Record<string, number> } }
    }
    expect(res.result.census).toMatchObject({ available: true, orgCount: 1 })
    expect(res.result.summary.denominator).toBe(1)
    expect(res.result.summary.states['not-installed']).toBe(1)

    // Persisted — a subsequent GET sees it without re-probing.
    const getRes = (await coverageGet(ev({ session: admin(), method: 'GET', query: { enterpriseId: entId } }))) as {
      coverage: { census: { available: boolean }; orgs: Array<{ org: string; state: string }> }
    }
    expect(getRes.coverage.census.available).toBe(true)
    expect(getRes.coverage.orgs).toEqual([{ org: 'onboard-me', state: 'not-installed', providerOrgId: null, observedAt: expect.any(String), stale: false, lastObservedState: 'not-installed' }])

    const audits = await t.client<{ event_type: string }[]>`
      SELECT event_type FROM audit_event WHERE subject_id = ${entId}::uuid AND event_type LIKE 'github-coverage-%' ORDER BY event_type`
    expect(audits.map((a) => a.event_type)).toEqual(['github-coverage-recheck-completed', 'github-coverage-recheck-triggered'])
  })

  it('a capability denial still recomputes/persists a KNOWN org state (never a blanket failure)', async () => {
    const [org] = await t.client<{ id: string }[]>`
      INSERT INTO provider_org (provider, external_org_id, display_name, provider_enterprise_id)
      VALUES ('github', 'known-org', 'known-org', ${entId}) RETURNING id::text AS id`
    stub.failCensus = { data: { detail: 'installable_organizations returned HTTP 403', status: 502 } }
    stub.installationDetails = { 'known-org': { status: 'suspended', installationId: 1, appId: 424242 } }

    const res = (await coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: entId } }))) as {
      result: { census: { available: boolean; reason: string | null }; orgs: Array<{ org: string; state: string }> }
    }
    expect(res.result.census).toMatchObject({ available: false, reason: 'capability-denied' })
    expect(res.result.orgs).toEqual([{ org: 'known-org', state: 'suspended', providerOrgId: org!.id }])
  })

  it('a manual recheck reconciles coverage alerts instead of stranding them after overwriting the prior state', async () => {
    await t.client`
      INSERT INTO provider_org
        (provider, external_org_id, display_name, provider_enterprise_id, cost_owning_unit_id)
      VALUES ('github', 'recover-org', 'recover-org', ${entId}::uuid, ${ouId}::uuid)
    `
    stub.organizations = [{ id: 1, login: 'recover-org' }]
    stub.installationDetails = {
      'recover-org': { status: 'suspended', installationId: 1, appId: 424242 },
    }
    await coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: entId } }))

    const [{ openBefore }] = await t.client<{ openBefore: string }[]>`
      SELECT count(*)::text AS "openBefore"
      FROM inbox_item
      WHERE category = 'github-coverage-gap'
        AND related_entity_id = ${entId}::uuid
        AND ack_state = 'unread'
    `
    expect(Number(openBefore)).toBe(1)

    stub.installationDetails = {
      'recover-org': { status: 'active', installationId: 1, appId: 424242 },
    }
    await coverageRecheck(ev({ session: admin(), method: 'POST', body: { enterpriseId: entId } }))

    const [{ resolvedAfter }] = await t.client<{ resolvedAfter: string }[]>`
      SELECT count(*)::text AS "resolvedAfter"
      FROM inbox_item
      WHERE category = 'github-coverage-gap'
        AND related_entity_id = ${entId}::uuid
        AND ack_state = 'resolved'
    `
    expect(Number(resolvedAfter)).toBe(1)
  })
})
