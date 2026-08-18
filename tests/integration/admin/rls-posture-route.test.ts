// @vitest-environment node
/*
 * GET /api/v1/admin/diagnostics/rls-posture — the operator's door onto the RLS
 * capability measurement.
 *
 * A module test is not a route test (CLAUDE.md rule 10): the probe's own suite
 * (tests/integration/db/rls-posture-probe.test.ts) proves what it MEASURES, and
 * cannot see the boundary. This file covers the boundary — the RBAC gate, the
 * fact that the route wires the bootstrap constant through rather than dropping
 * it, and that nothing credential-shaped rides out in the payload.
 *
 * RBAC matters more than usual here: the response names database roles, the
 * table owner, and exactly which security controls are NOT in force. That is a
 * map of where the boundary is thin, which is why the gate is platform-admin
 * only — the same bar as network.get.ts and otel-logs.get.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import { RLS_APP_ROLE, RLS_BOOTSTRAP_TABLE_NAMES } from '../../../server/db/rls-bootstrap'
import type { RlsPostureReport } from '../../../scripts/preflight-rls'
import handler from '../../../server/api/v1/admin/diagnostics/rls-posture.get'

let t: TestDb
let regionId: string
let ouId: string
let devId: string
let adminId: string
let finopsId: string
let platformId: string

/** Minimal h3-shaped event with an injected session (no OIDC, no cookies). */
function ev(session: Session) {
  const path = '/api/v1/admin/diagnostics/rls-posture'
  const e = {
    path,
    node: {
      req: {
        method: 'GET',
        url: path,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { 'content-type': 'application/json' }
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
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}

const dev = (): Session => ({
  teammateId: devId,
  email: 'rp-dev@x.test',
  displayName: 'Dev',
  role: 'developer',
  regionId,
  orgPath: 'rp.svc',
})
const admin = (): Session => ({
  teammateId: adminId,
  email: 'rp-admin@x.test',
  displayName: 'Admin',
  role: 'admin',
  regionId,
  orgPath: 'rp.svc',
})
const finops = (): Session => ({
  teammateId: finopsId,
  email: 'rp-fin@x.test',
  displayName: 'Fin',
  role: 'global-finops',
  regionId,
  orgPath: 'rp.svc',
})
const platform = (): Session => ({
  teammateId: platformId,
  email: 'rp-pa@x.test',
  displayName: 'PA',
  role: 'platform-admin',
  regionId,
  orgPath: 'rp.svc',
})

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'rp-r', displayName: 'RP R' })
    .returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'rp.svc',
      code: 'rp-svc',
      displayName: 'Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = o!.id
  const mk = async (role: string, email: string, oid: string) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, role, regionId, orgUnitId: ouId })
      .returning()
    return row!.id
  }
  devId = await mk('developer', 'rp-dev@x.test', 'oid-rp-dev')
  adminId = await mk('admin', 'rp-admin@x.test', 'oid-rp-admin')
  finopsId = await mk('global-finops', 'rp-fin@x.test', 'oid-rp-fin')
  platformId = await mk('platform-admin', 'rp-pa@x.test', 'oid-rp-pa')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('GET /admin/diagnostics/rls-posture — RBAC', () => {
  it('REJECTS a developer', async () => {
    await expect(handler(ev(dev()))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REJECTS a region admin — this is not region-scoped operational data', async () => {
    await expect(handler(ev(admin()))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('REJECTS global-finops — the finance super-role is still not an infra role', async () => {
    await expect(handler(ev(finops()))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('allows platform-admin', async () => {
    const res = (await handler(ev(platform()))) as RlsPostureReport
    expect(res.capability.currentUser).toBeTruthy()
  })
})

describe('GET /admin/diagnostics/rls-posture — payload', () => {
  it('answers all four questions the runbook currently guesses at', async () => {
    const res = (await handler(ev(platform()))) as RlsPostureReport

    // 1. can this connection provision the role?
    expect(typeof res.capability.canProvisionRole).toBe('boolean')
    expect(res.capability.provisionBasis).toBeTruthy()
    expect(res.capability.azurePgAdmin.rolePresent).toBe(false)
    expect(res.capability.azurePgAdmin.isMember).toBeNull()

    // 2. does the app role exist yet?
    expect(res.appRole.roleName).toBe(RLS_APP_ROLE)
    expect(res.appRole.exists).toBe(false)

    // 3. the live posture, per table
    expect(res.summary.rlsEnabled).toBeGreaterThan(0)
    expect(res.summary.policies).toBeGreaterThan(0)
    expect(res.tables.length).toBe(res.summary.tablesReported)
    expect(res.tables.every((tbl) => typeof tbl.rlsForced === 'boolean')).toBe(true)

    // 4. which connection is in use
    expect(res.connection.lane).toBe('owner')
    expect(res.summary.policiesApply).toBe(0)
  })

  it('wires the bootstrap constant through — the module cannot prove this itself', async () => {
    const res = (await handler(ev(platform()))) as RlsPostureReport
    const flagged = res.tables
      .filter((tbl) => tbl.bootstrap)
      .map((tbl) => tbl.table)
      .sort()
    expect(flagged).toEqual([...RLS_BOOTSTRAP_TABLE_NAMES].sort())
    expect(res.summary.bootstrapStillEnabled.length).toBeGreaterThan(0)
  })

  it('carries the one-line summary an operator can paste', async () => {
    const res = (await handler(ev(platform()))) as RlsPostureReport
    expect(res.line).toMatch(/^rls: owner-connection as '/)
    expect(res.line).toContain(`app-role '${RLS_APP_ROLE}' absent`)
  })

  it('never returns a connection string or a password', async () => {
    const res = (await handler(ev(platform()))) as RlsPostureReport
    const body = JSON.stringify(res)
    expect(body).not.toContain('postgres://')
    expect(body).not.toContain('postgresql://')
    expect(body).not.toContain('password')
    // the test container's own credentials, in whatever form
    expect(body).not.toContain(t.url)
    expect(body.toLowerCase()).not.toContain('secret')
  })

  it('is READ-ONLY: two calls in a row report identical posture', async () => {
    const a = (await handler(ev(platform()))) as RlsPostureReport
    const b = (await handler(ev(platform()))) as RlsPostureReport
    // measuredAt is the only field allowed to move.
    expect({ ...b, measuredAt: a.measuredAt }).toEqual(a)
  })
})
