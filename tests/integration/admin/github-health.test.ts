// @vitest-environment node
/*
 * GET /api/v1/admin/reconciliation/github/health — the LIVE, classified, key-safe verify
 * probe for a GitHub Copilot enterprise. Exercises the REAL h3 handler against a real
 * testcontainers DB (so the roster read + provider_enterprise load are honest); the GitHub
 * client + App-auth modules are MOCKED (no live calls) so we can drive each verdict.
 *
 * Covers:
 *   - RBAC: a developer → 403; a missing/invalid enterpriseId → 400; not-found / non-github → 404
 *   - every verdict: healthy, no-teammate-match, metrics-empty, auth-failed, egress-blocked,
 *     key-malformed, no-credential
 *   - SAFETY: the response NEVER contains the fake App key / PAT (grep the JSON for the secret)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
// vitest hoists the vi.mock calls below above ALL imports, so this handler import still
// binds to the stubbed client/App-auth modules despite appearing first in source order
// (the github-discover-orgs.test.ts convention).
import healthGet from '../../../server/api/v1/admin/reconciliation/github/health.get'
import * as schema from '../../../drizzle/schema'

// The fake secret threaded through the App-key env; the SAFETY assertions grep for it.
const FAKE_SECRET = 'SUPER-SECRET-APP-KEY-DO-NOT-LEAK-abc123'

// Mutable client behaviour, shared with the hoisted client mock. Each field is the array
// the corresponding client method returns, or an error to throw.
const stub = vi.hoisted(() => ({
  samlIdentities: [] as Array<{ login: string }>,
  userDailyCredits: [] as Array<{ login: string }>,
  seats: [] as Array<{ assignee: { login: string } }>,
  usageItems: [] as unknown[],
  failLicenses: null as unknown,
  failMetrics: null as unknown,
  // Per-org overrides — used only by the representative-org selection test (M2). When a key
  // matches the probed org they take precedence; otherwise the flat arrays above apply, so
  // single-org tests behave exactly as before (a single org skips the seat call entirely).
  orgSeats: {} as Record<string, Array<{ login: string }>>,
  orgIdentities: {} as Record<string, Array<{ login: string }>>,
}))

// Mock the GitHub client so the health helper's real factory builds THIS stub (App-mode
// path: listSamlIdentities(org) + getUserDailyCredits; PAT-mode: listSeats + getAiCreditUsage).
vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listSamlIdentities(org: string) { if (stub.failLicenses) throw stub.failLicenses; return stub.orgIdentities[org] ?? stub.samlIdentities }
    async listOrgCopilotSeats(org: string) { return stub.orgSeats[org] ?? [] }
    async getUserDailyCredits() { if (stub.failMetrics) throw stub.failMetrics; return stub.userDailyCredits }
    async listSeats() { if (stub.failLicenses) throw stub.failLicenses; return stub.seats }
    async getAiCreditUsage() { if (stub.failMetrics) throw stub.failMetrics; return { usageItems: stub.usageItems } }
    static withApp() { return new GithubCopilotClient() }
    static withPat() { return new GithubCopilotClient() }
  }
  return { GithubCopilotClient }
})

// Mock App-auth so the App-mode client build never runs real crypto on the fake PEM. A
// malformed-key case is driven by making the ctor throw a github-app-auth:* error.
const appAuthStub = vi.hoisted(() => ({ throwOnCtor: null as unknown }))
vi.mock('../../../server/reconciliation/adapters/github-app-auth', () => {
  // The ctor is the ONLY seam the probe touches on this class (the client above is fully
  // mocked), so a ctor-only stand-in is deliberate.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class GithubAppAuth {
    constructor() { if (appAuthStub.throwOnCtor) throw appAuthStub.throwOnCtor }
  }
  return { GithubAppAuth }
})

let t: TestDb
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''
let teammateAliceId = ''
let appEntId = ''
let patEntId = ''
let anthEntId = ''

function ev(opts: { session: Session; enterpriseId?: string; raw?: string }) {
  const qs = opts.raw !== undefined ? opts.raw : opts.enterpriseId !== undefined ? `?enterpriseId=${opts.enterpriseId}` : ''
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    // h3 getValidatedQuery/getQuery reads event.path — provide it (real Nitro sets it).
    path: `/x${qs}`,
    context: { params: {} },
    node: {
      req: { method: 'GET', url: `/x${qs}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
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
  return e as unknown as Parameters<typeof healthGet>[0]
}
const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })

type Health = Awaited<ReturnType<typeof healthGet>>
const call = (e: ReturnType<typeof ev>) => healthGet(e) as Promise<Health>

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'gh-r', displayName: 'GH R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'd.svc', code: 'd-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-gh-a', email: 'a@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-gh-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
  const [alice] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-gh-alice', email: 'alice@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  teammateAliceId = alice!.id

  // App-mode enterprise (github_app_id set) — the App-key env is wired to the fake secret.
  process.env.NUXT_GITHUB_APP_KEY_APPHEALTH = FAKE_SECRET
  const [appEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: 'app-health-ent', displayName: 'App Health Ent', reconciliationMode: 'reconciled', credentialSecretName: 'apphealth', githubAppId: '1234567',
  }).returning()
  appEntId = appEnt!.id
  // App-mode identity is now per-org: the probe reads ONE onboarded license org's
  // externalIdentities, so seed a provider_org linked to the App enterprise (mig 0038 lane link).
  await t.db.insert(schema.providerOrg).values({
    provider: 'github', externalOrgId: 'app-health-org', displayName: 'App Health Org', reconciliationMode: 'reconciled', providerEnterpriseId: appEntId,
  })

  // PAT-mode enterprise — PAT env wired to the fake secret.
  process.env.NUXT_GITHUB_PAT_PATHEALTH = FAKE_SECRET
  const [patEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: 'pat-health-ent', displayName: 'PAT Health Ent', reconciliationMode: 'reconciled', credentialSecretName: 'pathealth',
  }).returning()
  patEntId = patEnt!.id

  // An anthropic enterprise — the github-only route must 404 it.
  const [anthEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'anthropic', externalId: 'anth-health-ent', displayName: 'Anth Ent', reconciliationMode: 'reconciled',
  }).returning()
  anthEntId = anthEnt!.id

  // Roster: alice (App-ent) maps to a teammate; bob does NOT.
  await t.db.insert(schema.teammateIdentityMap).values({
    teammateId: teammateAliceId, system: 'github', identifier: 'alice', identifierKind: 'github-login',
    enterpriseSlug: 'app-health-ent',
  })
  await t.db.insert(schema.teammateIdentityMap).values({
    teammateId: teammateAliceId, system: 'github', identifier: 'alice', identifierKind: 'github-login',
    enterpriseSlug: 'pat-health-ent',
  })
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_APP_KEY_APPHEALTH
  delete process.env.NUXT_GITHUB_PAT_PATHEALTH
  await stopTestDb(t)
}, 30_000)

beforeEach(() => {
  stub.samlIdentities = []
  stub.userDailyCredits = []
  stub.seats = []
  stub.failLicenses = null
  stub.usageItems = [{ grossQuantity: 1 }] // the PAT probe login has usage on the probe day
  stub.failMetrics = null
  stub.orgSeats = {}
  stub.orgIdentities = {}
  appAuthStub.throwOnCtor = null
})

/** A createError-shaped upstream failure, as GithubCopilotClient.fail() throws it. */
function upstream(status: number, extra?: string): unknown {
  return { statusCode: 502, data: { status: 502, detail: `surface returned HTTP ${status}${extra ? ` :: ${extra}` : ''}` } }
}
/** The REAL github-CLIENT endpoint failure shape (github-upstream type + surface in detail):
 *  what listSamlIdentities() throws when the externalIdentities ENDPOINT 401/403s AFTER the token minted. */
function endpointErr(surface: string, status: number, extra?: string): unknown {
  return { statusCode: 502, data: { status: 502, type: 'https://tokenscope.example.com/errors/github-upstream', detail: `${surface} returned HTTP ${status}${extra ? ` :: ${extra}` : ''}` } }
}
/** The REAL github-APP-AUTH failure shape (install-lookup / token-mint) — appAuth-layer origin. */
function appAuthErr(surface: string, status: number): unknown {
  return { statusCode: 502, data: { status: 502, type: 'https://tokenscope.example.com/errors/github-app-upstream', detail: `${surface} returned HTTP ${status}` } }
}
/** The REAL github-SAML failure shape (externalIdentities GraphQL 200 carrying FORBIDDEN /
 *  INSUFFICIENT_SCOPES) — a missing organization_administration:read on the org install. */
function samlErr(errorTypes: string[]): unknown {
  return { statusCode: 502, data: { status: 502, type: 'https://tokenscope.example.com/errors/github-saml', detail: errorTypes.join(',') } }
}
function netErr(code: string): unknown {
  return Object.assign(new Error(`request failed: ${code}`), { code })
}

describe('RBAC + input validation', () => {
  it('a developer is rejected (403)', async () => {
    await expect(call(ev({ session: dev(), enterpriseId: appEntId }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('a missing enterpriseId → 400', async () => {
    await expect(call(ev({ session: admin(), raw: '' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an invalid (non-uuid) enterpriseId → 400', async () => {
    await expect(call(ev({ session: admin(), raw: '?enterpriseId=not-a-uuid' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an unknown enterpriseId → 404', async () => {
    await expect(call(ev({ session: admin(), enterpriseId: '00000000-0000-0000-0000-000000000001' }))).rejects.toMatchObject({ statusCode: 404 })
  })
  it('an ANTHROPIC enterprise → 400 (validation — github-only route, matching discover-orgs)', async () => {
    await expect(call(ev({ session: admin(), enterpriseId: anthEntId }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('App-mode verdicts', () => {
  it('healthy — licenses + metrics ok, records>0, alice matched', async () => {
    stub.samlIdentities = [{ login: 'alice' }, { login: 'bob' }]
    stub.userDailyCredits = [{ login: 'alice' }, { login: 'bob' }]
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green', credentialKind: 'github-app' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 1 })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 2, matchedRecords: 1 })
    expect(JSON.stringify(h)).not.toContain(FAKE_SECRET)
  })

  it('no-teammate-match — metrics returns only bob (unmatched)', async () => {
    stub.samlIdentities = [{ login: 'bob' }]
    stub.userDailyCredits = [{ login: 'bob' }]
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'no-teammate-match', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 1, matchedRecords: 0 })
  })

  it('metrics-empty — metrics ok but zero records', async () => {
    stub.samlIdentities = [{ login: 'alice' }]
    stub.userDailyCredits = []
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'metrics-empty', color: 'amber' })
  })

  it('no-license-orgs AMBER — App wired but no license org onboarded (provider_org empty)', async () => {
    // Temporarily remove the enterprise's license org: the probe can't pick a representative
    // org to read externalIdentities from → an actionable AMBER config gap, not a hard red.
    await t.client`DELETE FROM provider_org WHERE provider_enterprise_id = ${appEntId}`
    try {
      stub.samlIdentities = [{ login: 'alice' }] // never read (no org resolved)
      const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
      expect(h).toMatchObject({ verdict: 'no-license-orgs', color: 'amber' })
      expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'no-license-orgs' })
      expect(h.stages.metrics).toMatchObject({ skipped: true })
    } finally {
      await t.db.insert(schema.providerOrg).values({
        provider: 'github', externalOrgId: 'app-health-org', displayName: 'App Health Org', reconciliationMode: 'reconciled', providerEnterpriseId: appEntId,
      })
    }
  })

  it('auth-failed on the externalIdentities ENDPOINT → appAuth ✓ (minted) + org-admin-read hint on licenses', async () => {
    stub.samlIdentities = [{ login: 'alice' }]
    stub.failLicenses = endpointErr('graphql externalIdentities', 403)
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
  })

  it('auth-failed in the App-AUTH layer (token mint) → appAuth ✗, NO admin-read hint', async () => {
    stub.failLicenses = appAuthErr('app/installations/{id}/access_tokens', 403)
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: false, reason: 'auth-failed' })
    expect(h.stages.licenses.hint).toBeUndefined()
  })

  it('github-saml FORBIDDEN (GraphQL 200 + errors) → appAuth ✓ + auth-failed RED + org-admin-read hint (MEDIUM-1)', async () => {
    // The REAL org-admin-read denial shape: a 200 carrying GraphQL FORBIDDEN. It must fire the
    // actionable hint (a permission gap retrying can't fix), NOT the old amber "retry later".
    stub.failLicenses = samlErr(['FORBIDDEN'])
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
  })

  it('representative-org selection — probes the SEAT-BEARING org, not the alphabetically-first empty one (MEDIUM-2)', async () => {
    // Seed a SECOND onboarded org that sorts AFTER app-health-org and (unlike it) has seats +
    // identities. The probe must read the seat-bearing org's externalIdentities, not the empty
    // first — otherwise the enterprise-grain verdict can mask a real seat-bearing org dropping.
    await t.db.insert(schema.providerOrg).values({
      provider: 'github', externalOrgId: 'zzz-prod-org', displayName: 'ZZZ Prod', reconciliationMode: 'reconciled', providerEnterpriseId: appEntId,
    })
    try {
      stub.orgSeats = { 'app-health-org': [], 'zzz-prod-org': [{ login: 'alice' }] }
      stub.orgIdentities = { 'zzz-prod-org': [{ login: 'alice' }, { login: 'bob' }] } // app-health-org → [] (flat default)
      stub.userDailyCredits = [{ login: 'alice' }]
      const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
      // zzz-prod-org's identity count (2), alice matched — NOT the empty first org.
      expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 1 })
      expect(h).toMatchObject({ verdict: 'healthy', color: 'green' })
    } finally {
      await t.client`DELETE FROM provider_org WHERE external_org_id = 'zzz-prod-org' AND provider_enterprise_id = ${appEntId}`
    }
  })

  it('egress-blocked — ECONNREFUSED on externalIdentities', async () => {
    stub.failLicenses = netErr('ECONNREFUSED')
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'egress-blocked', color: 'red' })
  })

  it("upstream-transient AMBER — the client's LITERAL not-ready fail (HTTP 200 in detail, M1)", async () => {
    stub.samlIdentities = [{ login: 'alice' }]
    stub.failMetrics = {
      statusCode: 502,
      data: { status: 502, detail: 'copilot metrics users-1-day (report not ready — no download_links) returned HTTP 200' },
    }
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: false, reason: 'not-ready' })
  })

  it('upstream-transient AMBER — a 429 on externalIdentities is transient, NOT egress-blocked (H1)', async () => {
    stub.failLicenses = upstream(429)
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'rate-limited' })
    expect(h.stages.metrics).toMatchObject({ skipped: true }) // L5: doomed second call not fired
  })

  it('key-malformed — the App-auth ctor throws a github-app-auth error', async () => {
    appAuthStub.throwOnCtor = new Error('github-app-auth: App private key is not valid base64')
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h).toMatchObject({ verdict: 'key-malformed', color: 'red', keyPresent: true })
    expect(JSON.stringify(h)).not.toContain(FAKE_SECRET)
  })

  it('SAFETY — even a failing upstream body carrying the secret never leaks', async () => {
    stub.failMetrics = upstream(403, `token=${FAKE_SECRET}`)
    stub.samlIdentities = [{ login: 'alice' }]
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h.stages.metrics.ok).toBe(false)
    expect(JSON.stringify(h)).not.toContain(FAKE_SECRET)
  })

  it('SAFETY — the admin-read hint is a fixed enum; a secret in the endpoint body never leaks', async () => {
    stub.samlIdentities = [{ login: 'alice' }]
    stub.failLicenses = endpointErr('graphql externalIdentities', 403, `token=${FAKE_SECRET}`)
    const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
    expect(JSON.stringify(h)).not.toContain(FAKE_SECRET)
  })
})

describe('PAT-mode verdicts', () => {
  it('healthy — seats + ai_credit read ok for a matched login (honest usageItems counts)', async () => {
    stub.seats = [{ assignee: { login: 'alice' } }, { assignee: { login: 'bob' } }]
    const h = await call(ev({ session: admin(), enterpriseId: patEntId }))
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green', credentialKind: 'github-pat' })
    expect(h.stages.appAuth).toBeUndefined()
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 1 })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 1, matchedRecords: 1 })
    expect(JSON.stringify(h)).not.toContain(FAKE_SECRET)
  })

  it('auth-failed — 403 on listSeats (PAT mode) → NO enterprise-admin hint (different permission)', async () => {
    stub.failLicenses = endpointErr('enterprises/{ent}/copilot/billing/seats', 403)
    const h = await call(ev({ session: admin(), enterpriseId: patEntId }))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.licenses.hint).toBeUndefined()
    expect(h.stages.appAuth).toBeUndefined()
  })

  it('auth-failed — a PAT-mode 404 is scope/SSO hiding, NOT "not-installed" (M2)', async () => {
    stub.failLicenses = upstream(404)
    const h = await call(ev({ session: admin(), enterpriseId: patEntId }))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed' })
  })
})

describe('no-credential', () => {
  it('an enterprise with no key wired → no-credential (App key env cleared)', async () => {
    // try/finally (L4): the env restore must survive an assertion failure, or every later
    // test in the file inherits a missing key and fails misleadingly.
    delete process.env.NUXT_GITHUB_APP_KEY_APPHEALTH
    try {
      const h = await call(ev({ session: admin(), enterpriseId: appEntId }))
      expect(h).toMatchObject({ verdict: 'no-credential', color: 'red', keyPresent: false })
    } finally {
      process.env.NUXT_GITHUB_APP_KEY_APPHEALTH = FAKE_SECRET
    }
  })
})
