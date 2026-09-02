// @vitest-environment node
/*
 * The `surface` driver axis (requirement 2 — Add surface/client axis to Across,
 * Regional, and Cost-centre driver contracts/routes/exports/UI selectors using
 * registry-derived labels and ordering, no hand-coded tool predicates).
 *
 * Covers:
 *   - rows render in CANONICAL REGISTRY order (VENDOR_LANES), never $-desc —
 *     proven by seeding the SMALLER lane first in the registry but LARGER in $;
 *   - labels are registry-derived (VENDOR_LABELS), never hand-typed;
 *   - sum-back to the headline (build-design §7(4));
 *   - a GitHub USAGE lane ('copilot') is `pooled-usage` — never a per-user charge;
 *   - Cost-Centre's surface axis EXCLUDES Copilot lanes structurally (pooled usage
 *     carries NULL cost_owning_unit_id — the same exclusion CcDrill's "Burn by
 *     vendor" donut already documents);
 *   - CSV export stays byte-identical to the screen rows (requirement 8).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { buildUsageRollup } from '../helpers/usage-rollup'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import regionDrivers from '../../../server/api/v1/reports/region/drivers.get'
import ccDrillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import type { DriverRow } from '../../../shared/reports/types'

let t: TestDb
let regionA = ''
let unitA = ''
let alice = ''
let instAlice = ''

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
  return e as unknown as Parameters<typeof regionDrivers>[0]
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
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: regionA, orgPath: 'a', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)
// A bounded custom range (MAX_RANGE_DAYS = 400) anchored on "now" so the fixture
// rows (dated `now()`) always fall inside it, regardless of when the suite runs.
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const RANGE = `from=${isoDay(new Date(Date.now() - 300 * 86_400_000))}&to=${isoDay(new Date(Date.now() + 5 * 86_400_000))}`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('dsxa', 'DSX Region A')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='dsxa'`

  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'dsxa'::ltree, 'dsxa', 'DSXA', 'bu', true)`
  ;[{ id: unitA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='dsxa'`

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-dsx-alice', 'dsx-alice@x.test', 'Alice', ${regionA}::uuid, ${unitA}::uuid, true)`
  ;[{ id: alice }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='dsx-alice@x.test'`

  /*
   * mig 0129: `gfo()` below resolves to this DEDICATED sentinel id — the ONLY
   * place in this file that id appears (grep confirms no other role/persona
   * shares it). A real backing row is required for the `report_access_grant`
   * FK; both permissions are granted so the whole-company (`region=all`) width
   * and the cost-centre drill the tests below exercise keep working under the
   * new per-teammate grants model.
   */
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('00000000-0000-0000-0000-000000000009'::uuid, 'oid-dsx-finops', 'dsx-finops@x.test', 'DSX Finops', ${regionA}::uuid, ${unitA}::uuid, true)`
  await grantReportAccess(t.client, '00000000-0000-0000-0000-000000000009')

  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p-dsx-alice', ${alice}::uuid, 'claude-code', ${regionA}::uuid, ${unitA}::uuid, 'h', 'P')`
  ;[{ id: instAlice }] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${alice}::uuid LIMIT 1`

  // The 'claude' lane is FIRST in the registry but carries the SMALLER $ — proves
  // ordering is registry-derived, not magnitude-sorted, on the surface axis.
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instAlice}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 1000, 10, 'tier-1', 'estimated', now(), 'conv-dsx-claude')`
  // 'copilot' (copilot-cli) — a LARGER $ but LATER in the registry; ALSO the pooled
  // lane, carrying NULL cost_owning_unit_id (the real-world "no per-CC homing" shape
  // Cost-Centre's own burn/vendor-donut structurally excludes).
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instAlice}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL,
            'copilot-cli', 'gpt-copilot', 'input', 1000, 50, 'tier-1', 'estimated', now(), 'conv-dsx-copilot')`

  // The region reports' §A reads come from usage_rollup_daily (usage-rollup-
  // lane.md R5/R8): materialise it from the seeds above via the real worker.
  await buildUsageRollup(t.db)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface DriversResp {
  headlineUsd: number
  rows: DriverRow[]
}

describe('surface axis — Across', () => {
  it('renders in REGISTRY order (claude before copilot) despite copilot carrying the bigger $', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=surface`))) as unknown as DriversResp
    const keys = r.rows.map((x) => x.key)
    expect(keys.indexOf('claude')).toBeLessThan(keys.indexOf('copilot'))
    expect(r.rows.find((x) => x.key === 'claude')!.label).toBe('Claude Code')
    expect(r.rows.find((x) => x.key === 'copilot')!.label).toBe('Copilot')
  })

  it('sums back to the headline; the copilot lane is pooled-usage', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=surface`))) as unknown as DriversResp
    const sum = r.rows.reduce((a, x) => a + x.usd, 0)
    expect(cents(sum)).toBe(cents(r.headlineUsd))
    expect(cents(r.headlineUsd)).toBe(cents(60))
    const copilot = r.rows.find((x) => x.key === 'copilot')!
    expect(copilot.spendClass).toBe('pooled-usage')
    expect(cents(copilot.usd)).toBe(cents(50))
    const claude = r.rows.find((x) => x.key === 'claude')!
    expect(claude.spendClass).toBe('indicative')
    expect(cents(claude.usd)).toBe(cents(10))
  })

  it('CSV export stays byte-identical (same rows, same order, same sums)', async () => {
    const csv = (await exportHandler(
      ev(gfo(), `scope=region&region=all&report=drivers&axis=surface&${RANGE}`),
    )) as unknown as string
    expect(csv).toContain('axis=surface')
    const lines = csv.trim().split('\n')
    const claudeLine = lines.find((l) => l.startsWith('Claude Code,'))!
    const copilotLine = lines.find((l) => l.startsWith('Copilot,'))!
    expect(lines.indexOf(claudeLine)).toBeLessThan(lines.indexOf(copilotLine))
    expect(claudeLine).toContain('10.00')
    expect(copilotLine).toContain('50.00')
    expect(copilotLine).toContain('pooled-usage')
  })
})

describe('surface axis — Regional', () => {
  it('region-clamped, registry order, sum-back', async () => {
    const r = (await regionDrivers(
      ev(gfo(), `${RANGE}&axis=surface`),
    )) as unknown as DriversResp
    const keys = r.rows.map((x) => x.key)
    expect(keys.indexOf('claude')).toBeLessThan(keys.indexOf('copilot'))
    const sum = r.rows.reduce((a, x) => a + x.usd, 0)
    expect(cents(sum)).toBe(cents(r.headlineUsd))
    expect(cents(r.headlineUsd)).toBe(cents(60))
  })
})

describe('surface axis — Cost-Centre', () => {
  it('EXCLUDES the pooled Copilot lane (no cost-owning unit) — only the CC-homed Claude Code lane shows', async () => {
    const r = (await ccDrillHandler(
      ev(gfo(), `${RANGE}&axis=surface`, { ccId: unitA }),
    )) as unknown as DriversResp
    const keys = r.rows.map((x) => x.key)
    expect(keys).toEqual(['claude'])
    expect(cents(r.rows[0]!.usd)).toBe(cents(10))
  })
})
