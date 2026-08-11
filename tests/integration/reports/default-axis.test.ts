// @vitest-environment node
/*
 * THE DEFAULT DRILL AXIS IS THE PROJECT, ON EVERY API — asserted on RESPONSES.
 *
 * `docs/design/reporting-stakeholder-visibility/00-decisions.md` D1: reporting is
 * organised around projects and budgets; person-level detail is a spot-check,
 * reachable and audited, never a default view.
 *
 * This file exists because the first attempt at pinning that rule asserted the
 * SOURCE TEXT — that each server enum ADMITTED 'project' — and every endpoint
 * whose default was still 'teammate' (or 'region') passed it. Admitting an axis
 * and defaulting to it are different facts, and only one of them decides what a
 * caller who names no axis is shown. The browser sends `axis=project` explicitly,
 * so a screen check could not catch it either: the wrong default was reachable
 * only by the callers nobody was watching — a script, a saved link, and the CSV
 * export that every one of these scopes offers.
 *
 * So: call each handler with NO axis, and read the axis off the response.
 *
 * The client half of the rule (each Scope container's own default + its drill
 * reset) stays in tests/unit/components/reporting-default-axis.test.ts — those
 * are Nuxt-runtime containers that cannot be mounted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import ccDrillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import regionDrivers from '../../../server/api/v1/reports/region/drivers.get'
import exportHandler from '../../../server/api/v1/reports/export.get'

let t: TestDb
let regionId = ''
let ccId = ''

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
  return e as unknown as Parameters<typeof ccDrillHandler>[0]
}
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here - it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '', params: Record<string, string> = {}) =>
  ev(session, query ? `${query}&region=all` : 'region=all', params)

const gfo = (): Session =>
  ({
    teammateId: '00000000-0000-0000-0000-000000000009',
    email: 'g@a.test',
    displayName: 'G',
    role: 'global-finops',
    regionId,
    orgPath: 'd',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

interface AxisResp {
  axis: string
  rows: { label: string; usd: number }[]
  headlineUsd: number
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('rd', 'Region D')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rd'`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'd'::ltree, 'd', 'Practice D', 'bu', true)`
  ;[{ id: ccId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='d'`
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-d', 'dana@d.test', 'Dana', ${regionId}::uuid, ${ccId}::uuid, true)`
  const [{ id: dana }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='dana@d.test'`
  await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PROJ-D', 'hash-d', 'Project D', 'billable', ${regionId}::uuid, ${ccId}::uuid)`
  const [{ id: projD }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code='PROJ-D'`
  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${dana}::uuid, 'claude-code', ${regionId}::uuid, ${ccId}::uuid, 'h', 'P')`
  const [{ id: inst }] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${dana}::uuid LIMIT 1`
  // ONE tagged row, so a project-axis answer names the project and a teammate-axis
  // answer names the person — the two are told apart by the label, not by a total.
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${inst}::uuid, ${dana}::uuid, ${regionId}::uuid, ${ccId}::uuid, ${ccId}::uuid, ${projD}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, 12, 'tier-1', 'estimated', '2026-07-02T00:00:00Z'::timestamptz, 'conv-d')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('a caller who names NO axis gets the PROJECT breakdown, on every scope', () => {
  it('cost-centre drill', async () => {
    const d = (await ccDrillHandler(ev(gfo(), 'month=2026-07', { ccId }))) as unknown as AxisResp
    expect(d.axis).toBe('project')
    // …and the rows really are projects, not people: the label proves which
    // breakdown ran, where `axis` alone only proves what was echoed back.
    expect(d.rows.map((r) => r.label)).toEqual(['Project D'])
  })

  it('regional drivers', async () => {
    const d = (await regionDrivers(
      ev(gfo(), `month=2026-07&region=${regionId}`),
    )) as unknown as AxisResp
    expect(d.axis).toBe('project')
    expect(d.rows.map((r) => r.label)).toEqual(['Project D'])
  })

  it('across-regions drivers (the whole-company default was `region`)', async () => {
    const d = (await regionDrivers(evAll(gfo(), 'month=2026-07'))) as unknown as AxisResp
    expect(d.axis).toBe('project')
    expect(d.rows.map((r) => r.label)).toEqual(['Project D'])
  })

  it('the CSV export — all three scopes, stamped in the header line', async () => {
    // The export is the caller that CANNOT send an axis by accident: the button
    // passes the screen's, but the URL is shareable and the params are optional.
    const cc = (await exportHandler(
      ev(gfo(), `scope=cost-centre&report=drivers&cc=${ccId}&month=2026-07`),
    )) as unknown as string
    expect(cc).toContain('axis=project')
    expect(cc).toContain('Project D,12.00')

    const regional = (await exportHandler(
      ev(gfo(), `scope=region&report=drivers&region=${regionId}&month=2026-07`),
    )) as unknown as string
    expect(regional).toContain('axis=project')
    expect(regional).toContain('Project D,12.00')

    const across = (await exportHandler(
      ev(gfo(), 'scope=region&region=all&report=drivers&month=2026-07'),
    )) as unknown as string
    expect(across).toContain('axis=project')
    expect(across).toContain('Project D,12.00')
  })

  it('naming an axis still wins — the default is a default, not a clamp', async () => {
    const d = (await regionDrivers(
      evAll(gfo(), 'month=2026-07&axis=teammate'),
    )) as unknown as AxisResp
    expect(d.axis).toBe('teammate')
    expect(d.rows.map((r) => r.label)).toEqual(['Dana'])
  })
})
