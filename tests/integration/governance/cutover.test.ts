// @vitest-environment node
/*
 * Governance cutover — the preflight/activate/rollback state machine (design
 * §8.1/§8.4, ADR-0011 D1/D2/D11). Real h3 handlers against a real
 * testcontainers Postgres (per AGENTS.md: never mock Drizzle).
 *
 * Covers the tests named in design §9:
 *   - mixed-enterprise abort
 *   - both sides explicit
 *   - exact before/after equivalence
 *   - activation gate
 *   - post-activation heuristic ignored
 *   - rollback allowed before / blocked after a closed period under the new regime
 *   - RBAC + CSRF + audit for every write
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'

import statusGet from '../../../server/api/v1/admin/governance-cutover/index.get'
import preflightPost from '../../../server/api/v1/admin/governance-cutover/preflight.post'
import activatePost from '../../../server/api/v1/admin/governance-cutover/activate.post'
import rollbackPost from '../../../server/api/v1/admin/governance-cutover/rollback.post'
import closePeriodPost from '../../../server/api/v1/admin/finance-periods/[month]/close.post'
import reopenPeriodPost from '../../../server/api/v1/admin/finance-periods/[month]/reopen.post'
import restatePeriodPost from '../../../server/api/v1/admin/finance-periods/[month]/restate.post'

let t: TestDb
let regionId: string
let ouId: string
let finopsId: string
let devId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'gc-r', displayName: 'GC R' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'gc.svc', code: 'gc-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gc-fin', email: 'gc-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [d] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-gc-dev', email: 'gc-dev@x.test', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  devId = d!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// Fully reset every governance-relevant table between tests — each test builds
// its own provider registry + cutover state from a clean slate. audit_event is
// APPEND-ONLY (trigger-enforced) and deliberately NOT reset here — auditCount()
// takes a `since` timestamp instead.
beforeEach(async () => {
  await t.client`DELETE FROM finance_period`
  await t.client`UPDATE governance_cutover_state SET status = 'not_started', preflight_snapshot = NULL, preflight_verified_at = NULL, preflight_verified_by = NULL, activated_at = NULL, activated_by = NULL, rolled_back_at = NULL, rolled_back_by = NULL WHERE id = 1`
  await t.client`DELETE FROM actual_spend`
  await t.client`DELETE FROM provider_org`
  await t.client`DELETE FROM provider_enterprise`
  delete process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ORGS
  delete process.env.NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES
  delete process.env.NUXT_GITHUB_NFR_DEMO_ORGS
})

function ev(opts: {
  method: string
  body?: unknown
  session: Session
  params?: Record<string, string>
  origin?: string
}) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: opts.origin ?? 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof statusGet>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'gc-fin@x.test', displayName: 'Fin', role: 'global-finops', regionId, orgPath: 'gc.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'gc-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'gc.svc' })

async function auditCount(eventType: string, since: Date): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM audit_event WHERE event_type = ${eventType} AND ts_recorded >= ${since.toISOString()}::timestamptz`
  return Number(rows[0]!.n)
}

interface SeedEnterpriseOpts {
  externalId: string
  orgs: { externalOrgId: string }[]
}
async function seedGithubEnterprise(opts: SeedEnterpriseOpts): Promise<{ enterpriseId: string; orgIds: string[] }> {
  const [ent] = await t.db
    .insert(schema.providerEnterprise)
    .values({ provider: 'github', externalId: opts.externalId, displayName: opts.externalId, reconciliationMode: 'reconciled' })
    .returning()
  const orgIds: string[] = []
  for (const o of opts.orgs) {
    const [org] = await t.db
      .insert(schema.providerOrg)
      .values({
        provider: 'github',
        externalOrgId: o.externalOrgId,
        displayName: o.externalOrgId,
        reconciliationMode: 'reconciled',
        providerEnterpriseId: ent!.id,
      })
      .returning()
    orgIds.push(org!.id)
  }
  return { enterpriseId: ent!.id, orgIds }
}

describe('RBAC', () => {
  it('a non-global-finops (developer) is 403 on every cutover route', async () => {
    await expect(statusGet(ev({ method: 'GET', session: dev() }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(preflightPost(ev({ method: 'POST', session: dev(), body: {} }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(activatePost(ev({ method: 'POST', session: dev(), body: {} }))).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      rollbackPost(ev({ method: 'POST', session: dev(), body: { reason: 'test' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('preflight — mixed enterprise abort', () => {
  it('aborts and writes NOTHING when a github enterprise has orgs that disagree on the legacy verdict', async () => {
    await seedGithubEnterprise({ externalId: 'mixed-ent', orgs: [{ externalOrgId: 'mixed-demo' }, { externalOrgId: 'mixed-prod' }] })

    await expect(preflightPost(ev({ method: 'POST', session: finops(), body: {} }))).rejects.toMatchObject({
      statusCode: 422,
      data: { code: 'mixed-enterprise' },
    })

    // Nothing written: state stays not_started, billing stays at the schema default.
    const status = (await statusGet(ev({ method: 'GET', session: finops() }))) as { status: string }
    expect(status.status).toBe('not_started')
    const orgRows = await t.client<{ billing: string }[]>`SELECT billing FROM provider_org WHERE provider = 'github'`
    expect(orgRows.every((r) => r.billing === 'tracked')).toBe(true) // untouched schema default
  })
})

describe('preflight — both sides explicit + exact equivalence', () => {
  it('writes BOTH billed and tracked explicitly and the verified snapshot matches the legacy verdict', async () => {
    const since = new Date()
    const { enterpriseId } = await seedGithubEnterprise({
      externalId: 'uniform-ent',
      orgs: [{ externalOrgId: 'uniform-demo' }, { externalOrgId: 'uniform-demo-2' }], // both match the demo heuristic -> uniform exempt
    })
    const [anthOrg] = await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'anthropic-org-1', displayName: 'A1', reconciliationMode: 'reconciled' })
      .returning()

    const result = (await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))) as {
      status: string
      unitsVerified: number
    }
    expect(result.status).toBe('preflight_verified')
    expect(result.unitsVerified).toBeGreaterThanOrEqual(2) // the enterprise + the anthropic org

    const [entRow] = await t.client<{ billing: string }[]>`SELECT billing FROM provider_enterprise WHERE id = ${enterpriseId}::uuid`
    expect(entRow!.billing).toBe('tracked') // both orgs were '-demo' -> exempt -> tracked, WRITTEN explicitly

    const [anthRow] = await t.client<{ billing: string }[]>`SELECT billing FROM provider_org WHERE id = ${anthOrg!.id}::uuid`
    expect(anthRow!.billing).toBe('billed') // Anthropic never had a heuristic -> always billed, WRITTEN explicitly

    expect(await auditCount('governance-cutover-preflight-verified', since)).toBe(1)
  })

  it('is idempotent — re-running preflight recomputes the same result', async () => {
    const since = new Date()
    await seedGithubEnterprise({ externalId: 'idem-ent', orgs: [{ externalOrgId: 'idem-prod' }] })
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    const second = (await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))) as { status: string }
    expect(second.status).toBe('preflight_verified')
    expect(await auditCount('governance-cutover-preflight-verified', since)).toBe(2) // re-run audits again, but state is stable
  })
})

describe('activation gate', () => {
  it('activate is rejected before a verified preflight', async () => {
    await seedGithubEnterprise({ externalId: 'gate-ent', orgs: [{ externalOrgId: 'gate-prod' }] })
    await expect(activatePost(ev({ method: 'POST', session: finops(), body: {} }))).rejects.toMatchObject({
      statusCode: 409,
      data: { code: 'wrong-state' },
    })
  })

  it('activate succeeds after a verified preflight, and rollback is rejected before activation', async () => {
    const since = new Date()
    await seedGithubEnterprise({ externalId: 'act-ent', orgs: [{ externalOrgId: 'act-prod' }] })
    await expect(
      rollbackPost(ev({ method: 'POST', session: finops(), body: { reason: 'too early' } })),
    ).rejects.toMatchObject({ statusCode: 409, data: { code: 'wrong-state' } })

    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    const activated = (await activatePost(ev({ method: 'POST', session: finops(), body: {} }))) as { status: string }
    expect(activated.status).toBe('activated')
    expect(await auditCount('governance-cutover-activated', since)).toBe(1)

    const status = (await statusGet(ev({ method: 'GET', session: finops() }))) as { status: string }
    expect(status.status).toBe('activated')
  })
})

describe('post-activation: name/env heuristic is ignored everywhere', () => {
  it('an org named "*-demo" under a BILLED enterprise is chargeable once activated, even with the heuristic still matching', async () => {
    // Regression guard for the exact failure the cutover exists to prevent:
    // pre-activation this org would read exempt (name heuristic); post-activation
    // it must read whatever the ENTERPRISE's billing says, full stop.
    const { enterpriseId } = await seedGithubEnterprise({ externalId: 'ignore-ent', orgs: [{ externalOrgId: 'ignore-demo' }] })
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))

    // A GENUINE post-activation governance decision (not a preflight/activate
    // drift): an operator explicitly flips this demo-named enterprise to
    // billed via the normal governance data path, same as PATCH .../enterprises/{id}.
    await t.client`UPDATE provider_enterprise SET billing = 'billed' WHERE id = ${enterpriseId}::uuid`

    const { resolveGithubVerdict, loadGovernanceResolutionContext } = await import('../../../server/governance/verdict')
    const ctx = await loadGovernanceResolutionContext(t.db)
    expect(ctx.activated).toBe(true)
    const verdict = resolveGithubVerdict(ctx, { providerEnterpriseId: enterpriseId, enterpriseSlug: 'ignore-ent', licenseOrg: 'ignore-demo' })
    expect(verdict.exempt).toBe(false) // heuristic would have said true; governance data wins
    expect(verdict.source).toBe('governance:billed')
  })
})

describe('DB constraint — provider_org.billing is locked for GitHub once activated (defence in depth)', () => {
  it('a raw SQL UPDATE bypassing the app layer is rejected by the trigger once activated', async () => {
    const { orgIds } = await seedGithubEnterprise({ externalId: 'trig-ent', orgs: [{ externalOrgId: 'trig-org' }] })
    // Before activation, a direct billing write is unrestricted (the rollback seam).
    await expect(t.client`UPDATE provider_org SET billing = 'billed' WHERE id = ${orgIds[0]}::uuid`).resolves.toBeDefined()

    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))

    await expect(
      t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${orgIds[0]}::uuid`,
    ).rejects.toThrow(/not writable/i)

    // A no-op write (same value) is NOT a "change" and must still be allowed —
    // the trigger only blocks an actual value change.
    const [cur] = await t.client<{ billing: string }[]>`SELECT billing FROM provider_org WHERE id = ${orgIds[0]}::uuid`
    await expect(
      t.client`UPDATE provider_org SET billing = ${cur!.billing} WHERE id = ${orgIds[0]}::uuid`,
    ).resolves.toBeDefined()

    // Anthropic orgs are NEVER locked by this trigger (D11: the org remains
    // its own billing unit for that provider).
    const [anthOrg] = await t.db
      .insert(schema.providerOrg)
      .values({ provider: 'anthropic', externalOrgId: 'trig-anth-org', displayName: 'X', reconciliationMode: 'reconciled' })
      .returning()
    await expect(
      t.client`UPDATE provider_org SET billing = 'tracked' WHERE id = ${anthOrg!.id}::uuid`,
    ).resolves.toBeDefined()
  })
})

describe('rollback — allowed before, blocked after a closed period under the new regime', () => {
  it('rollback succeeds when no period has closed since activation', async () => {
    const since = new Date()
    await seedGithubEnterprise({ externalId: 'rb-ent', orgs: [{ externalOrgId: 'rb-prod' }] })
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))

    const result = (await rollbackPost(ev({ method: 'POST', session: finops(), body: { reason: 'testing rollback' } }))) as {
      status: string
    }
    expect(result.status).toBe('rolled_back')
    expect(await auditCount('governance-cutover-rolled-back', since)).toBe(1)
  })

  it('rollback is rejected once a finance period has closed under the activated regime', async () => {
    await seedGithubEnterprise({ externalId: 'rb2-ent', orgs: [{ externalOrgId: 'rb2-prod' }] })
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))

    await closePeriodPost(ev({ method: 'POST', session: finops(), body: {}, params: { month: '2026-06' } }))

    await expect(
      rollbackPost(ev({ method: 'POST', session: finops(), body: { reason: 'too late' } })),
    ).rejects.toMatchObject({ statusCode: 409, data: { code: 'closed-period-since-activation' } })
  })

  it('reopening a period closed after activation does not make rollback safe again', async () => {
    await seedGithubEnterprise({ externalId: 'rb3-ent', orgs: [{ externalOrgId: 'rb3-prod' }] })
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))
    await closePeriodPost(ev({ method: 'POST', session: finops(), body: {}, params: { month: '2026-06' } }))
    await reopenPeriodPost(
      ev({ method: 'POST', session: finops(), body: { reason: 'late correction' }, params: { month: '2026-06' } }),
    )

    await expect(
      rollbackPost(ev({ method: 'POST', session: finops(), body: { reason: 'still too late' } })),
    ).rejects.toMatchObject({ statusCode: 409, data: { code: 'closed-period-since-activation' } })
  })

  it('restating a period after activation blocks rollback even when its original close predates activation', async () => {
    await seedGithubEnterprise({ externalId: 'rb4-ent', orgs: [{ externalOrgId: 'rb4-prod' }] })
    await closePeriodPost(ev({ method: 'POST', session: finops(), body: {}, params: { month: '2026-06' } }))
    await preflightPost(ev({ method: 'POST', session: finops(), body: {} }))
    await activatePost(ev({ method: 'POST', session: finops(), body: {} }))
    await restatePeriodPost(
      ev({ method: 'POST', session: finops(), body: { reason: 'post-cutover correction' }, params: { month: '2026-06' } }),
    )

    await expect(
      rollbackPost(ev({ method: 'POST', session: finops(), body: { reason: 'too late after restatement' } })),
    ).rejects.toMatchObject({ statusCode: 409, data: { code: 'closed-period-since-activation' } })
  })
})

describe('CSRF', () => {
  it('a cross-origin POST is rejected', async () => {
    await seedGithubEnterprise({ externalId: 'csrf-ent', orgs: [{ externalOrgId: 'csrf-prod' }] })
    await expect(
      preflightPost(ev({ method: 'POST', session: finops(), body: {}, origin: 'http://evil.example' })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
