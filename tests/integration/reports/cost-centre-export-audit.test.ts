// @vitest-environment node
/*
 * The Cost-Centre scope's two TEAMMATE-GRAINED exports: they return the whole
 * authorised population, and each one writes a provenance record.
 *
 * THE TWO EXPORTS:
 *
 *   - `report=drivers&axis=teammate` — COALESCE(display_name, email) per row
 *     (`fetchCostCentreBurnDrivers`).
 *   - `report=over-soft-cap` — a column literally named `teammate`.
 *
 * WHAT IS BEING PINNED. Two properties, and they are separate:
 *
 *   1. COMPLETENESS. Every row the caller's scope authorises reaches the file —
 *      no top-N, no folded tail. Which rows a caller may see at all is decided
 *      upstream by the ownership gate (`resolveCostCentreDrill`), and that gate
 *      has its own tests; these assertions are about what happens AFTER it says
 *      yes.
 *
 *   2. PROVENANCE. One `report-export-teammate-axis` row per export, carrying
 *      counts and ids, so an operator can later answer "who pulled this, when,
 *      at what scope". It is a record of the act, NOT a disclosure control.
 *
 * WHY BOTH EXPORTS SHARE ONE FIXTURE AND ONE FILE. They are the same population
 * read two ways: the same 105 placed teammates, each with one untagged §A row
 * homed to this cost centre, are the burn drill's ranking AND the over-soft-cap
 * list.
 *
 * `ccSmall` (3 teammates) is here for the provenance half specifically: a SMALL
 * export is audited exactly like a large one, because the record is "who
 * exported a roster", not "who exported a big one". An implementation that only
 * recorded exports past some size passes every assertion on `ccBig` and fails
 * here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { OverSoftCap } from '#shared/reports/types'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'

let t: TestDb
let region = ''
let ccBig = '' // 105 placed teammates
let ccSmall = '' // 3 placed teammates

/**
 * Distinct teammates on `ccBig`. Deliberately a three-figure population: a
 * truncation defect is invisible on a fixture too small to truncate.
 */
const N = 105
/** The soft cap in force (`NUXT_BASE_ALLOWANCE_USD`), pinned in beforeAll. */
const SOFT_CAP = 100

/*
 * Teammate i (0…N-1) burns 100 + i, untagged, homed to ccBig. Every figure is
 * DISTINCT, so each name maps to exactly one row and a dropped row cannot hide
 * behind a duplicate figure. Every row is over SOFT_CAP too, so the same 105
 * people are the over-soft-cap population — one fixture, both exports.
 */
const BIG_TOTAL = Array.from({ length: N }, (_, i) => 100 + i).reduce((a, b) => a + b, 0) // 15960
const name = (i: number) => `cap${String(i).padStart(3, '0')}@ccx.test`

const MONTH = '2026-03'
const CALLER = '00000000-0000-0000-0000-0000000000c1'

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
  return e as unknown as Parameters<typeof drillHandler>[0]
}
const gfo = (): Session =>
  ({ teammateId: CALLER, email: 'caller@ccx.test', displayName: 'Caller', role: 'global-finops', regionId: region, orgPath: 'ccx', issuedAt: new Date().toISOString() } as unknown as Session)

const exportCsv = async (query: string): Promise<string> =>
  (await exportHandler(ev(gfo(), query))) as unknown as string

interface DrillResp {
  headlineUsd: number
  rows: { key: string; label: string; usd: number }[]
  overSoftCap: OverSoftCap
}
const drill = async (ccId: string, query = `month=${MONTH}&axis=teammate`): Promise<DrillResp> =>
  (await drillHandler(ev(gfo(), query, { ccId }))) as unknown as DrillResp

/** Audit rows this suite's exports wrote, newest first. */
const auditRows = async (report: string, ccId: string) =>
  await t.client<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM audit_event
    WHERE event_type = 'report-export-teammate-axis'
      AND payload->>'report' = ${report}
      AND payload->>'costCentreId' = ${ccId}
    ORDER BY ts_recorded DESC`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  // The over-soft-cap policy input, pinned so the assertions are about the code.
  process.env.NUXT_BASE_ALLOWANCE_USD = String(SOFT_CAP)

  await t.client`INSERT INTO region (code, display_name) VALUES ('ccx', 'Export Audit Region')`
  const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='ccx'`
  region = rg!.id

  const mkUnit = async (path: string, code: string, costOwning: boolean, parentId: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parentId}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  const root = await mkUnit('ccx', 'ccx-root', false)
  ccBig = await mkUnit('ccx.big', 'big', true, root)
  ccSmall = await mkUnit('ccx.small', 'small', true, root)

  // The caller is a real teammate: audit_event.actor_teammate_id REFERENCES teammate(id),
  // so a synthetic session id would make every audit write a FK violation.
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${CALLER}::uuid, 'oid-ccx-caller', 'caller@ccx.test', 'Caller', ${region}::uuid, ${root}::uuid, true)`

  /*
   * N teammates + one instance + one UNTAGGED attribution row each, in three
   * generate_series statements rather than N round trips. `cost_owning_unit_id`
   * is set (so the burn drill sees them) while `project_id` stays NULL (so the
   * over-soft-cap card sees the same money as unallocated).
   */
  await t.client`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    SELECT 'oid-ccx-' || i, 'cap' || lpad(i::text, 3, '0') || '@ccx.test',
           'cap' || lpad(i::text, 3, '0') || '@ccx.test', ${region}::uuid, ${ccBig}::uuid, true
    FROM generate_series(0, ${N - 1}) AS i`
  await t.client`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    SELECT gen_random_uuid(), 'p-' || tm.id, tm.id, 'claude-code', ${region}::uuid, ${ccBig}::uuid, 'h', 'P'
    FROM teammate tm WHERE tm.org_unit_id = ${ccBig}::uuid`
  await t.client`
    INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
    SELECT ia.instance_id, ia.teammate_id, ${region}::uuid, ${ccBig}::uuid, ${ccBig}::uuid, NULL,
           'claude-code', 'claude-sonnet-4-6', 'input', 1000,
           -- 'capNNN@ccx.test' → 100 + NNN, so every teammate's spend is distinct.
           100 + substring(split_part(tm.email, '@', 1) from 4)::int,
           'tier-1', 'estimated', '2026-03-15T00:00:00Z'::timestamptz
    FROM instance_attestation ia JOIN teammate tm ON tm.id = ia.teammate_id
    WHERE ia.org_unit_id = ${ccBig}::uuid`

  // ccSmall — 3 people, every one of them over the soft cap, so BOTH reports have
  // rows and NEITHER is capped.
  await t.client`
    INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    SELECT 'oid-ccxs-' || i, 'sml' || i::text || '@ccx.test', 'sml' || i::text || '@ccx.test',
           ${region}::uuid, ${ccSmall}::uuid, true
    FROM generate_series(0, 2) AS i`
  await t.client`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    SELECT gen_random_uuid(), 'p-' || tm.id, tm.id, 'claude-code', ${region}::uuid, ${ccSmall}::uuid, 'h', 'P'
    FROM teammate tm WHERE tm.org_unit_id = ${ccSmall}::uuid`
  await t.client`
    INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event)
    SELECT ia.instance_id, ia.teammate_id, ${region}::uuid, ${ccSmall}::uuid, ${ccSmall}::uuid, NULL,
           'claude-code', 'claude-sonnet-4-6', 'input', 1000, 150,
           'tier-1', 'estimated', '2026-03-15T00:00:00Z'::timestamptz
    FROM instance_attestation ia JOIN teammate tm ON tm.id = ia.teammate_id
    WHERE ia.org_unit_id = ${ccSmall}::uuid`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

/** The fixture's own arithmetic, before any export is asserted against it. */
describe('the fixture is a three-figure population on both reports', () => {
  it('the screen reports all 105 on both the drill and the over-soft-cap card', async () => {
    const d = await drill(ccBig)
    expect(d.rows.length).toBe(N)
    expect(d.headlineUsd).toBeCloseTo(BIG_TOTAL, 2)
    expect(d.overSoftCap.over.length).toBe(N)
    expect(d.overSoftCap.rosterCount).toBe(N)
  })
})

// ── report=drivers&axis=teammate ─────────────────────────────────────────────
describe('report=drivers&axis=teammate exports the whole population, and is audited', () => {
  it(`writes one row per teammate — all ${N}, footing to the drill headline`, async () => {
    const csv = await exportCsv(`scope=cost-centre&report=drivers&cc=${ccBig}&axis=teammate&month=${MONTH}`)
    const dataRows = csv.trim().split('\n').slice(2)
    // The COUNT is the assertion that matters: a folded tail would still foot to
    // the headline while being short of the population.
    expect(dataRows.length).toBe(N)
    expect(csv).not.toContain('all other')

    const total = dataRows.reduce((a, line) => a + Number(line.split(',')[1]), 0)
    expect(total).toBeCloseTo(BIG_TOTAL, 2)
  })

  it('names every teammate, the smallest spender included', async () => {
    // The lowest spenders are what a top-N would drop first, so they are what is
    // asserted — the top spender alone would survive any truncation.
    const csv = await exportCsv(`scope=cost-centre&report=drivers&cc=${ccBig}&axis=teammate&month=${MONTH}`)
    for (let i = 0; i < N; i += 1) expect(csv).toContain(name(i))
  })

  it('records ONE audit row per export, with counts and ids but NO names', async () => {
    const before = (await auditRows('drivers', ccBig)).length
    await exportCsv(`scope=cost-centre&report=drivers&cc=${ccBig}&axis=teammate&month=${MONTH}`)
    const rows = await auditRows('drivers', ccBig)
    expect(rows.length).toBe(before + 1)
    expect(rows[0]!.payload).toMatchObject({
      scope: 'cost-centre',
      width: null,
      costCentreId: ccBig,
      report: 'drivers',
      axis: 'teammate',
      rowCount: N,
    })
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('@ccx.test')
  })

  it('a non-teammate axis writes NO audit row', async () => {
    // project / model / surface label things, not people — there is no teammate
    // grain to record.
    await exportCsv(`scope=cost-centre&report=drivers&cc=${ccBig}&axis=model&month=${MONTH}`)
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM audit_event
      WHERE event_type = 'report-export-teammate-axis' AND payload->>'axis' <> 'teammate'`
    expect(Number(rows[0]!.n)).toBe(0)
  })
})

// ── report=over-soft-cap ─────────────────────────────────────────────────────
describe('report=over-soft-cap exports the whole population, and is audited', () => {
  it(`writes one row per teammate — all ${N}, footing to the card's own total`, async () => {
    const csv = await exportCsv(`scope=cost-centre&report=over-soft-cap&cc=${ccBig}&month=${MONTH}`)
    const lines = csv.trim().split('\n')
    expect(lines[1]).toBe('teammate,unallocated_usd,cap_multiple,tagged_rate_pct,projects,group')

    const dataRows = lines.slice(2)
    expect(dataRows.length).toBe(N)
    expect(csv).not.toContain('all other')

    // SUM(unallocated_usd) foots to the card's own unallocated total.
    const total = dataRows.reduce((a, line) => a + Number(line.split(',')[1]), 0)
    const d = await drill(ccBig)
    expect(total).toBeCloseTo(d.overSoftCap.over.reduce((a, r) => a + r.unallocatedUsd, 0), 2)
  })

  it('names every teammate, the smallest unallocated sum included', async () => {
    const csv = await exportCsv(`scope=cost-centre&report=over-soft-cap&cc=${ccBig}&month=${MONTH}`)
    for (let i = 0; i < N; i += 1) expect(csv).toContain(name(i))
  })

  it('records ONE audit row per export, with counts and ids but NO names', async () => {
    const before = (await auditRows('over-soft-cap', ccBig)).length
    await exportCsv(`scope=cost-centre&report=over-soft-cap&cc=${ccBig}&month=${MONTH}`)
    const rows = await auditRows('over-soft-cap', ccBig)
    expect(rows.length).toBe(before + 1)
    expect(rows[0]!.payload).toMatchObject({
      scope: 'cost-centre',
      width: null,
      costCentreId: ccBig,
      report: 'over-soft-cap',
      axis: 'teammate',
      rowCount: N,
    })
    expect(JSON.stringify(rows[0]!.payload)).not.toContain('@ccx.test')
  })
})

/*
 * ── SIZE IS NOT WHAT TRIGGERS THE RECORD ─────────────────────────────────────
 * A three-person export is audited exactly like a 105-person one: the record is
 * "who exported a roster", not "who exported a LARGE roster". An implementation
 * that only recorded exports past some threshold passes everything above.
 */
describe('a three-person cost centre is exported whole, and still audited', () => {
  it('drivers: three names, and a provenance row', async () => {
    const csv = await exportCsv(`scope=cost-centre&report=drivers&cc=${ccSmall}&axis=teammate&month=${MONTH}`)
    expect(csv.trim().split('\n').slice(2).length).toBe(3)
    const rows = await auditRows('drivers', ccSmall)
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload).toMatchObject({ costCentreId: ccSmall, rowCount: 3 })
  })

  it('over-soft-cap: three names, and a provenance row', async () => {
    const csv = await exportCsv(`scope=cost-centre&report=over-soft-cap&cc=${ccSmall}&month=${MONTH}`)
    expect(csv.trim().split('\n').slice(2).length).toBe(3)
    const rows = await auditRows('over-soft-cap', ccSmall)
    expect(rows.length).toBe(1)
    expect(rows[0]!.payload).toMatchObject({ costCentreId: ccSmall, rowCount: 3 })
  })
})
