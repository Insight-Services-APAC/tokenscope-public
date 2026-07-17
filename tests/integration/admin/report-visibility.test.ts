// @vitest-environment node
/*
 * Admin report-visibility policy (mig 0087) — the single org-wide knob.
 *
 * Covers: GET returns the current mode + the three presets (with the
 * WHO-SEES-WHAT matrix from the shared source of truth); PUT happy path
 * (global-finops) upserts the single row + audits before/after; a REGION admin
 * cannot write (403 — org-wide config); and the ABSENT-row default is
 * 'standard' (fail-closed on a fresh upgrade).
 *
 * NOTE: depends on the core agent's shared/auth/report-visibility.ts +
 * migration 0087 (report_visibility_setting). Until those land this file is
 * expected to fail at import/DDL time — it is written to the design contract.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import getHandler from '../../../server/api/v1/admin/report-visibility.get'
import putHandler from '../../../server/api/v1/admin/report-visibility.put'

let t: TestDb
let regionId = ''
let unitId = ''
const FINOPS_ID = '00000000-0000-0000-0000-0000000000f1'
const ADMIN_ID = '00000000-0000-0000-0000-0000000000a1'

function ev(opts: { session: Session; body?: unknown; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const method = opts.method ?? 'GET'
  const e = {
    method,
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, unknown>,
        statusCode: 200,
        getHeader() {},
        setHeader() {},
        removeHeader() {},
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}

const finops = (): Session =>
  ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'global-finops', regionId, orgPath: 'de' } as Session)
const regionAdmin = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'ra@x.test', displayName: 'Ra', role: 'admin', regionId, orgPath: 'de' } as Session)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('de', 'DE') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionId}::uuid, NULL, 'de'::ltree, 'default', 'DE', 'bu') RETURNING id::text AS id`
  unitId = u!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${FINOPS_ID}::uuid, 'oid-fx', 'fx@x.test', 'Fx', ${regionId}::uuid, ${unitId}::uuid, 'global-finops')`
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${ADMIN_ID}::uuid, 'oid-ra', 'ra@x.test', 'Ra', ${regionId}::uuid, ${unitId}::uuid, 'admin')`
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM report_visibility_setting`
})

describe('admin report-visibility GET', () => {
  it('defaults to standard when no row is set, and lists the three presets', async () => {
    const got = (await getHandler(ev({ session: finops(), method: 'GET' }))) as {
      mode: string
      updated_by: string | null
      modes: { mode: string; label: string; matrix: unknown[] }[]
    }
    expect(got.mode).toBe('standard')
    expect(got.updated_by).toBeNull()
    expect(got.modes.map((m) => m.mode)).toEqual([
      'standard',
      'region-admins-see-all',
      'all-admins-see-all',
    ])
    // Each preset carries a matrix (the shared WHO-SEES-WHAT export).
    for (const m of got.modes) expect(Array.isArray(m.matrix)).toBe(true)
  })

  it('a region admin may READ the org-wide policy', async () => {
    const got = (await getHandler(ev({ session: regionAdmin(), method: 'GET' }))) as { mode: string }
    expect(got.mode).toBe('standard')
  })
})

describe('admin report-visibility PUT', () => {
  it('global-finops sets the mode; the single row upserts; audited before/after', async () => {
    const first = (await putHandler(
      ev({ session: finops(), method: 'PUT', body: { mode: 'region-admins-see-all' } }),
    )) as { mode: string }
    expect(first.mode).toBe('region-admins-see-all')
    await putHandler(ev({ session: finops(), method: 'PUT', body: { mode: 'all-admins-see-all' } }))

    const rows = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM report_visibility_setting`
    expect(Number(rows[0]!.n)).toBe(1)

    const got = (await getHandler(ev({ session: finops(), method: 'GET' }))) as {
      mode: string
      updated_by: string | null
    }
    expect(got.mode).toBe('all-admins-see-all')
    expect(got.updated_by).toBe(FINOPS_ID)

    const audits = await t.client<{ payload: { before: string; after: string } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'report-visibility-changed'
      ORDER BY ts_recorded`
    expect(audits.length).toBe(2)
    expect(audits[0]!.payload.before).toBe('standard') // absent ⇒ standard
    expect(audits[0]!.payload.after).toBe('region-admins-see-all')
    expect(audits[1]!.payload.before).toBe('region-admins-see-all')
    expect(audits[1]!.payload.after).toBe('all-admins-see-all')
  })

  it('rejects an unknown mode with 400', async () => {
    await expect(
      putHandler(ev({ session: finops(), method: 'PUT', body: { mode: 'everyone-sees-everything' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('a region admin cannot change the org-wide policy (403)', async () => {
    await expect(
      putHandler(ev({ session: regionAdmin(), method: 'PUT', body: { mode: 'region-admins-see-all' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
