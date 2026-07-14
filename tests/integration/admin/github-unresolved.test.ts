// @vitest-environment node
/*
 * Admin "Unresolved Copilot users" surface (identity-tail layer 3):
 *   GET  /api/v1/admin/reconciliation/github/unresolved — the live provider roster diffed
 *        against teammate_identity_map (both lanes) → the unmatched logins + context.
 *   POST /api/v1/admin/reconciliation/github/map — map a login → an existing teammate; writes
 *        the ENTERPRISE lane (source='admin-manual'), audited, so the reconciler then resolves it.
 *
 * The GitHub client + App-auth are MOCKED (no live calls); the DB is a real testcontainers PG
 * (so the roster read, the upsert, and the audit row are honest). Covers:
 *   - RBAC (developer → 403), input validation, not-found / non-github → 404/400
 *   - GET returns ONLY genuinely-unresolved logins (a mapped login drops out); PAT context
 *     (license org) vs App context (credits/day); a probe failure → clean 502 (never a partial
 *     list); SAFETY — the fake key never leaks
 *   - POST upserts the enterprise-lane row + audit event; rejects a provisional teammate; and the
 *     mapped login then RESOLVES through resolveGithubRoster (the money-path loop closes)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import unresolvedGet from '../../../server/api/v1/admin/reconciliation/github/unresolved.get'
import mapPost from '../../../server/api/v1/admin/reconciliation/github/map.post'
import { resolveGithubRoster } from '../../../server/reconciliation/adapters/github'
import * as schema from '../../../drizzle/schema'

const FAKE_SECRET = 'SUPER-SECRET-APP-KEY-DO-NOT-LEAK-xyz789'

// Mutable client behaviour, shared with the hoisted mock.
const stub = vi.hoisted(() => ({
  seats: [] as Array<{ assignee: { login: string }; organization?: { login: string } | null }>,
  userDailyCredits: [] as Array<{ login: string; credits: number }>,
  failSeats: null as unknown,
  failMetrics: null as unknown,
}))

vi.mock('../../../server/reconciliation/adapters/github-client', () => {
  class GithubCopilotClient {
    async listSeats() { if (stub.failSeats) throw stub.failSeats; return stub.seats }
    async getUserDailyCredits() { if (stub.failMetrics) throw stub.failMetrics; return stub.userDailyCredits }
    static withApp() { return new GithubCopilotClient() }
    static withPat() { return new GithubCopilotClient() }
  }
  return { GithubCopilotClient }
})
vi.mock('../../../server/reconciliation/adapters/github-app-auth', () => {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class GithubAppAuth {}
  return { GithubAppAuth }
})

let t: TestDb
let regionId = ''
let ouId = ''
let adminId = ''
let devId = ''
let aliceId = ''
let bobId = ''
let provisionalId = ''
let appEntId = ''
let patEntId = ''
let anthEntId = ''

const APP_SLUG = 'app-unres-ent'
const PAT_SLUG = 'pat-unres-ent'

function evGet(opts: { session: Session; enterpriseId?: string; raw?: string }) {
  const qs = opts.raw !== undefined ? opts.raw : opts.enterpriseId !== undefined ? `?enterpriseId=${opts.enterpriseId}` : ''
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: `/x${qs}`,
    context: { params: {} },
    node: {
      req: { method: 'GET', url: `/x${qs}`, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: baseRes(),
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof unresolvedGet>[0]
}

function evPost(opts: { session: Session; body?: unknown; origin?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: baseRes(),
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof mapPost>[0]
}

function baseRes() {
  return {
    _headers: {} as Record<string, string | string[]>, statusCode: 200,
    getHeader(n: string) { return this._headers[n.toLowerCase()] },
    setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
    appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
    get headersSent() { return false },
  }
}

const admin = (): Session => ({ teammateId: adminId, email: 'a@x.test', displayName: 'A', role: 'global-finops', regionId, orgPath: 'd.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'd@x.test', displayName: 'D', role: 'developer', regionId, orgPath: 'd.svc' })

type UnresolvedResult = Awaited<ReturnType<typeof unresolvedGet>>
const callGet = (e: ReturnType<typeof evGet>) => unresolvedGet(e) as Promise<UnresolvedResult>

async function auditCount(eventType: string, subjectId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType} AND subject_id = ${subjectId}::uuid`
  return Number(rows[0]!.n)
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ur-r', displayName: 'UR R' }).returning()
  regionId = r!.id
  const [o] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'd.svc', code: 'd-svc', displayName: 'Svc', unitType: 'bu' }).returning()
  ouId = o!.id
  const [a] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-a', email: 'a@x.test', role: 'global-finops', regionId, orgUnitId: ouId }).returning()
  adminId = a!.id
  const [d] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-d', email: 'd@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  devId = d!.id
  const [alice] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-alice', email: 'alice@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  aliceId = alice!.id
  const [bob] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ur-bob', email: 'bob@x.test', role: 'developer', regionId, orgUnitId: ouId }).returning()
  bobId = bob!.id
  const [prov] = await t.db.insert(schema.teammate).values({ entraOid: 'provisional:ur-1', email: 'shadow@x.test', role: 'developer', regionId, orgUnitId: ouId, provisional: true }).returning()
  provisionalId = prov!.id

  // App-mode enterprise (github_app_id set), App key wired to the fake secret.
  process.env.NUXT_GITHUB_APP_KEY_URAPP = FAKE_SECRET
  const [appEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: APP_SLUG, displayName: 'App Unres Ent', reconciliationMode: 'reconciled', credentialSecretName: 'urapp', githubAppId: '9990001',
  }).returning()
  appEntId = appEnt!.id

  // PAT-mode enterprise, PAT wired to the fake secret.
  process.env.NUXT_GITHUB_PAT_URPAT = FAKE_SECRET
  const [patEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'github', externalId: PAT_SLUG, displayName: 'PAT Unres Ent', reconciliationMode: 'reconciled', credentialSecretName: 'urpat',
  }).returning()
  patEntId = patEnt!.id

  const [anthEnt] = await t.db.insert(schema.providerEnterprise).values({
    provider: 'anthropic', externalId: 'anth-unres-ent', displayName: 'Anth', reconciliationMode: 'reconciled',
  }).returning()
  anthEntId = anthEnt!.id
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_APP_KEY_URAPP
  delete process.env.NUXT_GITHUB_PAT_URPAT
  await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  stub.seats = []
  stub.userDailyCredits = []
  stub.failSeats = null
  stub.failMetrics = null
  // A clean identity map each test (both lanes).
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

describe('GET unresolved — RBAC + validation', () => {
  it('a developer → 403', async () => {
    await expect(callGet(evGet({ session: dev(), enterpriseId: patEntId }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('a missing/invalid enterpriseId → 400', async () => {
    await expect(callGet(evGet({ session: admin(), raw: '' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callGet(evGet({ session: admin(), raw: '?enterpriseId=nope' }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an unknown enterprise → 404; an anthropic enterprise → 400', async () => {
    await expect(callGet(evGet({ session: admin(), enterpriseId: '00000000-0000-0000-0000-000000000001' }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(callGet(evGet({ session: admin(), enterpriseId: anthEntId }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('GET unresolved — PAT mode (seat roster)', () => {
  it('returns ONLY the unmapped seat logins, with license-org context', async () => {
    // alice is already bound (enterprise lane); bob + carol are not.
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'alice', identifierKind: 'username', enterpriseSlug: PAT_SLUG,
    })
    stub.seats = [
      { assignee: { login: 'alice' }, organization: { login: 'acme-prod' } },
      { assignee: { login: 'bob' }, organization: { login: 'acme-prod' } },
      { assignee: { login: 'carol' }, organization: { login: 'acme-demo' } },
    ]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.credentialKind).toBe('github-pat')
    expect(res.logins.map((l) => l.login)).toEqual(['bob', 'carol']) // alice excluded, sorted
    expect(res.logins.find((l) => l.login === 'bob')).toMatchObject({ licenseOrg: 'acme-prod', credits: null })
    expect(res.logins.find((l) => l.login === 'carol')).toMatchObject({ licenseOrg: 'acme-demo' })
    expect(JSON.stringify(res)).not.toContain(FAKE_SECRET)
  })

  it('a self-linked login (NULL lane) is treated as RESOLVED (drops from the list)', async () => {
    // The self lane resolves under any enterprise (identity-tail layer 2) → not unresolved.
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: bobId, system: 'github', identifier: 'bob', identifierKind: 'username', source: 'self',
    })
    stub.seats = [{ assignee: { login: 'bob' }, organization: { login: 'acme-prod' } }, { assignee: { login: 'carol' }, organization: null }]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins.map((l) => l.login)).toEqual(['carol']) // bob is self-resolved
    expect(res.logins[0]).toMatchObject({ licenseOrg: null })
  })

  it('dedups a multi-org unmapped login to ONE entry', async () => {
    stub.seats = [
      { assignee: { login: 'dave' }, organization: { login: 'org-a' } },
      { assignee: { login: 'dave' }, organization: { login: 'org-b' } },
    ]
    const res = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(res.logins).toHaveLength(1)
    expect(res.logins[0]!.login).toBe('dave')
  })

  it('a provider failure → clean 502 (never a partial/empty list)', async () => {
    stub.failSeats = { statusCode: 502, data: { status: 502, detail: `seats returned HTTP 403 token=${FAKE_SECRET}` } }
    await expect(callGet(evGet({ session: admin(), enterpriseId: patEntId }))).rejects.toMatchObject({ statusCode: 502 })
    // And the thrown error carries no secret.
    const err = await callGet(evGet({ session: admin(), enterpriseId: patEntId })).catch((e) => e)
    expect(JSON.stringify(err.data ?? err)).not.toContain(FAKE_SECRET)
  })
})

describe('GET unresolved — App mode (metrics report)', () => {
  it('returns the unmapped users with credits + day context', async () => {
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'alice', identifierKind: 'username', enterpriseSlug: APP_SLUG,
    })
    stub.userDailyCredits = [{ login: 'alice', credits: 100 }, { login: 'erin', credits: 42 }]
    const res = await callGet(evGet({ session: admin(), enterpriseId: appEntId }))
    expect(res.credentialKind).toBe('github-app')
    expect(res.logins.map((l) => l.login)).toEqual(['erin'])
    expect(res.logins[0]).toMatchObject({ credits: 42, licenseOrg: null })
    expect(res.logins[0]!.lastSeenDay).toBe(res.probeDay)
    expect(res.probeDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a metrics-report failure → clean 502 (never a partial list), key-safe', async () => {
    stub.failMetrics = { statusCode: 502, data: { status: 502, detail: `users-1-day returned HTTP 404 token=${FAKE_SECRET}` } }
    const err = await callGet(evGet({ session: admin(), enterpriseId: appEntId })).catch((e) => e)
    expect(err).toMatchObject({ statusCode: 502 })
    expect(JSON.stringify(err.data ?? err)).not.toContain(FAKE_SECRET)
  })
})

describe('POST map — RBAC, CSRF, validation', () => {
  it('a developer → 403', async () => {
    await expect(mapPost(evPost({ session: dev(), body: { enterpriseId: patEntId, login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('a cross-origin request → CSRF rejection', async () => {
    await expect(
      mapPost(evPost({ session: admin(), origin: 'https://evil.example', body: { enterpriseId: patEntId, login: 'bob', teammateId: bobId } })),
    ).rejects.toMatchObject({ statusCode: expect.any(Number) })
  })
  it('an unknown enterprise → 404; an anthropic enterprise → 400', async () => {
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: '00000000-0000-0000-0000-000000000001', login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: anthEntId, login: 'bob', teammateId: bobId } }))).rejects.toMatchObject({ statusCode: 400 })
  })
  it('an unknown teammate → 404; a provisional teammate → 400', async () => {
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'bob', teammateId: '00000000-0000-0000-0000-000000000002' } }))).rejects.toMatchObject({ statusCode: 404 })
    await expect(mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'bob', teammateId: provisionalId } }))).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('POST map — the money-path loop closes', () => {
  it('upserts the ENTERPRISE-lane row + audit event; the mapped login then RESOLVES', async () => {
    const res = (await mapPost(evPost({
      session: admin(),
      body: { enterpriseId: patEntId, login: 'Bob', teammateId: bobId, licenseOrg: 'acme-prod' },
    }))) as { id: string; enterpriseSlug: string; login: string; teammateId: string; source: string }
    expect(res).toMatchObject({ enterpriseSlug: PAT_SLUG, login: 'bob', teammateId: bobId, source: 'admin-manual' })

    // The row is the enterprise lane (enterprise_slug = slug), source admin-manual, verified.
    const rows = await t.client<{ enterprise_slug: string | null; source: string; teammate_id: string; verified_at: string | null; license_org: string | null }[]>`
      SELECT enterprise_slug, source, teammate_id::text AS teammate_id, verified_at, license_org
      FROM teammate_identity_map WHERE system = 'github' AND lower(identifier) = 'bob'`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ enterprise_slug: PAT_SLUG, source: 'admin-manual', teammate_id: bobId, license_org: 'acme-prod' })
    expect(rows[0]!.verified_at).not.toBeNull()

    // Audit event written (subject = the teammate).
    expect(await auditCount('copilot-login-mapped', bobId)).toBe(1)

    // The reconciler's roster reader now resolves the login → the loop is closed.
    const roster = await resolveGithubRoster(t.db, PAT_SLUG)
    expect(roster.get('bob')).toBe(bobId)

    // And the login no longer appears as unresolved for the same seat roster.
    stub.seats = [{ assignee: { login: 'bob' }, organization: { login: 'acme-prod' } }]
    const unres = await callGet(evGet({ session: admin(), enterpriseId: patEntId }))
    expect(unres.logins).toHaveLength(0)
  })

  it('is idempotent — a re-map cleanly re-binds (ON CONFLICT DO UPDATE), no 409', async () => {
    await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: bobId } }))
    // Re-map the SAME login to a DIFFERENT teammate (admin override).
    const res = (await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: aliceId } }))) as { teammateId: string }
    expect(res.teammateId).toBe(aliceId)
    const rows = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM teammate_identity_map WHERE system='github' AND lower(identifier)='carol'`
    expect(rows).toHaveLength(1)
    expect(rows[0]!.teammate_id).toBe(aliceId)
  })

  it('does NOT clobber a self-service link (NULL lane survives; enterprise lane still wins on read)', async () => {
    // Self-link carol → alice (NULL lane); then admin-map carol → bob (enterprise lane).
    await t.db.insert(schema.teammateIdentityMap).values({
      teammateId: aliceId, system: 'github', identifier: 'carol', identifierKind: 'username', source: 'self',
    })
    await mapPost(evPost({ session: admin(), body: { enterpriseId: patEntId, login: 'carol', teammateId: bobId } }))
    // BOTH rows coexist (different lanes).
    const rows = await t.client<{ enterprise_slug: string | null; teammate_id: string }[]>`
      SELECT enterprise_slug, teammate_id::text AS teammate_id FROM teammate_identity_map
      WHERE system='github' AND lower(identifier)='carol' ORDER BY enterprise_slug NULLS LAST`
    expect(rows).toHaveLength(2)
    // The reader picks the ENTERPRISE lane (bob), never the self-link (alice).
    const roster = await resolveGithubRoster(t.db, PAT_SLUG)
    expect(roster.get('carol')).toBe(bobId)
  })
})
