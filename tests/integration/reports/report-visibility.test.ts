// @vitest-environment node
/*
 * Report-visibility policy — enforcement threading (task #19).
 *
 * Per-literal-endpoint proof (sg-M6/M8): every across-regions route (×5) and every
 * /reports/finance surface (index + drill + export) asserts 200/403 against
 * reportGrants for a region admin AND a cost-centre owner (developer + active
 * ownership) across all three modes. Plus:
 *   - sg-H3 leak fix: velocity foreign-ouId 403 under all three modes (mode never
 *     threads into it — proven empirically).
 *   - sg-L11: dropping the table degrades /reports to 'standard', 200, no throw.
 *   - getReportVisibilityMode default 'standard' with no seeded row.
 *
 * The policy row is written DIRECTLY (the admin PUT belongs to the admin-pane agent);
 * this suite exercises ENFORCEMENT, not the config write path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { consola } from 'consola'
import * as auditModule from '../../../server/db/audit'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { withRlsContext } from '../../../server/db/rls'
import { getReportVisibilityMode } from '../../../server/auth/report-scope'
import {
  REPORT_VISIBILITY_MODES,
  type ReportVisibilityMode,
} from '../../../shared/auth/report-visibility'
import type { Session } from '../../../server/utils/auth'

import acrossIndex from '../../../server/api/v1/reports/across-regions/index.get'
import acrossDrivers from '../../../server/api/v1/reports/across-regions/drivers.get'
import acrossTrend from '../../../server/api/v1/reports/across-regions/trend.get'
import acrossActiveTrend from '../../../server/api/v1/reports/across-regions/active-trend.get'
import acrossSeasonality from '../../../server/api/v1/reports/across-regions/seasonality.get'
import financeIndex from '../../../server/api/v1/reports/finance/index.get'
import financeCou from '../../../server/api/v1/reports/finance/[couId].get'
import reportsExport from '../../../server/api/v1/reports/export.get'
import velocity from '../../../server/api/v1/rollups/practice/[ouId]/velocity.get'
import regionalIndex from '../../../server/api/v1/reports/regional/index.get'

let t: TestDb
let regionA = ''
let regionB = ''
let couA = '' // cost-owning unit, region A
let couB = '' // cost-owning unit, region B
let adminId = ''
let ownerId = '' // developer WITH an active cou_owner row on couA

const ev = (session: Session, query = '', params: Record<string, string> = {}) => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof acrossIndex>[0]
}

const adminSess = (): Session =>
  ({ teammateId: adminId, email: 'admin@a.test', displayName: 'A', role: 'admin', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)
const ownerSess = (): Session =>
  ({ teammateId: ownerId, email: 'owner@a.test', displayName: 'O', role: 'developer', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

async function setMode(mode: ReportVisibilityMode | null): Promise<void> {
  await t.client`DELETE FROM report_visibility_setting`
  if (mode) await t.client`INSERT INTO report_visibility_setting (mode) VALUES (${mode})`
}

const ok = (p: Promise<unknown>) => expect(p).resolves.toBeDefined()
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ statusCode: 403 })

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const mkRegion = async (code: string, name: string) => {
    await t.client`INSERT INTO region (code, display_name) VALUES (${code}, ${name})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code=${code}`
    return r!.id
  }
  regionA = await mkRegion('ra', 'Region A')
  regionB = await mkRegion('rb', 'Region B')

  const mkUnit = async (region: string, path: string, code: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  couA = await mkUnit(regionA, 'a', 'a')
  couB = await mkUnit(regionB, 'b', 'b')

  const mkTeammate = async (region: string, unit: string, email: string, role: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${unit}::uuid, ${role}, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  adminId = await mkTeammate(regionA, couA, 'admin@a.test', 'admin')
  ownerId = await mkTeammate(regionA, couA, 'owner@a.test', 'developer')
  const billerA = await mkTeammate(regionA, couA, 'billa@a.test', 'developer')
  const billerB = await mkTeammate(regionB, couB, 'billb@b.test', 'developer')

  // Active ownership → the developer 'owner' is a cost-centre owner of couA.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${couA}::uuid, ${ownerId}::uuid)`

  // A July bill per region so the finance surfaces have real bill rows to read
  // (billerA → couA/region A; billerB → couB/region B).
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${billerA}::uuid, '2026-07-05'::date, 'claude-code', 500, 500, 12, 'anthropic-analytics-api', false)`
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt)
    VALUES (${billerB}::uuid, '2026-07-05'::date, 'claude-code', 500, 500, 20, 'anthropic-analytics-api', false)`
}, 120_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
})

// The reportGrants-derived expectation per (mode × persona) for each scope group.
type Expect = { across: boolean; reportsFinance: boolean }
const EXPECT: Record<ReportVisibilityMode, { admin: Expect; owner: Expect }> = {
  standard: {
    admin: { across: false, reportsFinance: false }, // finance false (region admin, standard)
    owner: { across: false, reportsFinance: false }, // finance false
  },
  'region-admins-see-all': {
    admin: { across: true, reportsFinance: true }, // FULL
    owner: { across: false, reportsFinance: false }, // unchanged
  },
  'all-admins-see-all': {
    admin: { across: true, reportsFinance: true }, // FULL
    owner: { across: true, reportsFinance: true }, // FULL (ownership)
  },
}

describe('across-regions ×5 + /reports/finance ×3 — 200/403 vs reportGrants', () => {
  for (const mode of REPORT_VISIBILITY_MODES) {
    for (const who of ['admin', 'owner'] as const) {
      const exp = EXPECT[mode][who]
      const sess = () => (who === 'admin' ? adminSess() : ownerSess())

      it(`${mode} × ${who}: across-regions ×5 → ${exp.across ? 200 : 403}`, async () => {
        await setMode(mode === 'standard' ? null : mode)
        const q = 'month=2026-07'
        const calls = [
          () => acrossIndex(ev(sess(), q)),
          () => acrossDrivers(ev(sess(), q)),
          () => acrossTrend(ev(sess(), q)),
          () => acrossActiveTrend(ev(sess(), q)),
          () => acrossSeasonality(ev(sess(), q)),
        ]
        for (const call of calls) await (exp.across ? ok(call()) : forbidden(call()))
      })

      it(`${mode} × ${who}: /reports/finance index+drill+export → ${exp.reportsFinance ? 200 : 403}`, async () => {
        await setMode(mode === 'standard' ? null : mode)
        const calls = [
          () => financeIndex(ev(sess(), 'month=2026-06')),
          () => financeCou(ev(sess(), 'month=2026-06', { couId: couA })),
          () => reportsExport(ev(sess(), 'scope=finance&format=csv')),
        ]
        for (const call of calls) await (exp.reportsFinance ? ok(call()) : forbidden(call()))
      })
    }
  }
})

describe('sg-M4: every deny on across + /reports/finance is audited', () => {
  it('a real-teammate deny writes a report-scope-denied audit (survives the 403 rollback)', async () => {
    await setMode(null) // standard → owner (developer) is denied across + finance
    await forbidden(acrossIndex(ev(ownerSess(), 'month=2026-07')))
    await forbidden(financeIndex(ev(ownerSess(), 'month=2026-06')))
    // audit_event is append-only, so we assert existence (never clear). The deny is
    // written on a SEPARATE connection, so it survives the 403's request-tx rollback.
    const rows = await t.client<{ actor_teammate_id: string; payload: { scope: string } }[]>`
      SELECT actor_teammate_id::text AS actor_teammate_id, payload
      FROM audit_event
      WHERE event_type = 'report-scope-denied' AND actor_teammate_id = ${ownerId}::uuid`
    const scopes = rows.map((r) => r.payload.scope)
    expect(scopes).toContain('across')
    expect(scopes).toContain('finance')
  })

  it('an audit-write failure still returns 403 AND emits the [SECURITY-AUDIT-WRITE-FAILED] alertable marker', async () => {
    await setMode(null) // standard → owner (developer) is denied across
    // For across/finance the audit IS the only record, so a write failure is itself a
    // security-critical event ops must alert on. Force the write to throw (spy, not a
    // module-wide vi.mock, so the real-audit test above is unaffected).
    const auditSpy = vi.spyOn(auditModule, 'recordAuditEvent').mockRejectedValue(new Error('boom'))
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {})
    try {
      // The deny must STILL return 403 — audit is best-effort by nature.
      await forbidden(acrossIndex(ev(ownerSess(), 'month=2026-07')))
      expect(auditSpy).toHaveBeenCalled()
      const marked = errSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('[SECURITY-AUDIT-WRITE-FAILED]'),
      )
      expect(marked, 'expected the [SECURITY-AUDIT-WRITE-FAILED] marker line').toBeTruthy()
      // Ids-only structured fields (no PII) ride the marker for alert routing.
      expect(marked?.[1]).toMatchObject({ scope: 'across', actorTeammateId: ownerId })
    } finally {
      auditSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe('sg-H3 leak fix: velocity foreign-ouId 403 under ALL modes (mode never threads in)', () => {
  for (const mode of REPORT_VISIBILITY_MODES) {
    it(`${mode}: region-A admin → 403 on a region-B ouId, 200 on own`, async () => {
      await setMode(mode === 'standard' ? null : mode)
      await forbidden(velocity(ev(adminSess(), '', { ouId: couB })))
      await ok(velocity(ev(adminSess(), '', { ouId: couA })))
    })
  }
})

describe('sg-L11 + default: absent row / dropped table degrade to standard (no throw)', () => {
  it("getReportVisibilityMode returns 'standard' with no seeded row", async () => {
    await setMode(null)
    const mode = await withRlsContext(
      t.db as never,
      { userRegionId: regionA, userOrgPath: 'a', userRole: 'admin', userTeammateId: adminId },
      async (tx) => getReportVisibilityMode({ context: {} } as never, tx as never),
    )
    expect(mode).toBe('standard')
  })

  it('dropping the table still lets /reports render as standard (200)', async () => {
    await t.client`DROP TABLE report_visibility_setting`
    // A region admin still gets their own-region regional report (standard behaviour).
    await ok(regionalIndex(ev(adminSess(), 'month=2026-07')))
    // …and is still denied the whole-company across scope (fail-closed to standard).
    await forbidden(acrossIndex(ev(adminSess(), 'month=2026-07')))
  })
})
