// @vitest-environment node
/*
 * Teammate driver rows: per-surface + per-provenance breakdown (requirements 3/4
 * — "teammate drivers discard client/tool"). Covers:
 *   - `surfaceBreakdown` — a properly TYPED structured breakdown (not JSON in
 *     `dims`), exact per-surface amounts + registry labels, Σ segments === the
 *     row's own `usd` (the sum-back invariant, build-design §7(4), extended to
 *     the segment level);
 *   - `provenanceBreakdown` — a blended row (OTel-emitted Claude Code + Claude
 *     Chat's structural provider-usage) carries BOTH provenances, summing to
 *     the row total;
 *   - `pooled-usage` gate: a teammate whose ENTIRE usage is a GitHub USAGE lane
 *     (copilot OR copilot-agent — both draw the SAME pooled allowance) is
 *     `pooled-usage`; the pre-existing 'copilot-cli'-only case keeps working
 *     unchanged, and the WIDENED 'copilot-agent'-only case (unreachable before
 *     migration 0101 made the lane live) now ALSO reads pooled;
 *   - Across, Regional, and Cost-Centre all compute the SAME shape from the SAME
 *     single combined query (no drift between the row total and its breakdowns).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import regionDrivers from '../../../server/api/v1/reports/region/drivers.get'
import ccDrillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import type { DriverRow } from '../../../shared/reports/types'

let t: TestDb
let regionA = ''
let unitA = ''
let alice = ''
let bob = ''
let carol = ''
let instAlice = ''
let instCarol = ''

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
// rows (dated `now()`/`current_date`) always fall inside it, regardless of when
// the suite runs.
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const RANGE = `from=${isoDay(new Date(Date.now() - 300 * 86_400_000))}&to=${isoDay(new Date(Date.now() + 5 * 86_400_000))}`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('dtba', 'DTB Region A')`
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='dtba'`

  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionA}::uuid, 'dtba'::ltree, 'dtba', 'DTBA', 'bu', true)`
  ;[{ id: unitA }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='dtba'`

  const mkTeammate = async (email: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${email}, ${regionA}::uuid, ${unitA}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  alice = await mkTeammate('dtb-alice@x.test')
  bob = await mkTeammate('dtb-bob@x.test')
  carol = await mkTeammate('dtb-carol@x.test')

  const mkInstance = async (teammate: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p-'||${teammate}, ${teammate}::uuid, 'claude-code', ${regionA}::uuid, ${unitA}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammate}::uuid LIMIT 1`
    return r!.id
  }
  instAlice = await mkInstance(alice)
  instCarol = await mkInstance(carol)

  // Alice — BLENDED: OTel-emitted Claude Code (arm1) + structurally-provider-usage
  // Claude Chat (arm3, a lane we carry no model for) + copilot-cli — three surfaces, two provenances.
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instAlice}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid,
            'claude-code', 'claude-sonnet-4-6', 'input', 1000, 20, 'tier-1', 'estimated', now(), 'conv-dtb-alice-cc')`
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instAlice}::uuid, ${alice}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL,
            'copilot-cli', 'gpt-copilot', 'input', 1000, 5, 'tier-1', 'estimated', now(), 'conv-dtb-alice-cp')`
  await t.client`INSERT INTO actual_spend (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source,
      region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${alice}::uuid, current_date, 'claude-ai', 500, 500, 8, 'anthropic-analytics-api',
      ${regionA}::uuid, ${unitA}::uuid, ${unitA}::uuid, 'ingest-snapshot')`

  // Bob — copilot-agent ONLY (the WIDENED pooled case, unreachable before mig 0101).
  await t.client`INSERT INTO reconciliation_record
      (teammate_id, provider, enterprise_ref, period_date, category, scope, region_id, org_unit_id, cost_owning_unit_id,
       actual_qty, actual_unit_type, actual_usd, otel_attributed_usd, delta_usd, spend_class, disposition, status)
    VALUES (${bob}::uuid, 'github', 'ent-dtb', current_date, 'copilot_coding_agent', 'teammate',
      ${regionA}::uuid, ${unitA}::uuid, NULL,
      '10', 'ai-credits', '30.00', '0', '30.00', 'indicative', 'ingest_only', 'proposed')`

  // Carol — copilot-cli ONLY (the pre-existing narrow pooled case — keeps working).
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instCarol}::uuid, ${carol}::uuid, ${regionA}::uuid, ${unitA}::uuid, NULL,
            'copilot-cli', 'gpt-copilot', 'input', 1000, 15, 'tier-1', 'estimated', now(), 'conv-dtb-carol-cp')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

interface DriversResp {
  headlineUsd: number
  rows: DriverRow[]
}

function findRow(rows: DriverRow[], label: string): DriverRow {
  const row = rows.find((r) => r.label === label)
  if (!row) throw new Error(`row not found: ${label}`)
  return row
}

describe('teammate driver rows — surface + provenance breakdown (Across)', () => {
  it('surfaceBreakdown: exact per-surface amounts, registry labels, Σ segments === row usd', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const aliceRow = findRow(r.rows, 'dtb-alice@x.test')
    expect(cents(aliceRow.usd)).toBe(cents(33)) // 20 + 5 + 8
    expect(aliceRow.surfaceBreakdown).toBeDefined()
    const segSum = aliceRow.surfaceBreakdown!.reduce((a, s) => a + s.usd, 0)
    expect(cents(segSum)).toBe(cents(aliceRow.usd))
    const byLane = new Map(aliceRow.surfaceBreakdown!.map((s) => [s.lane, s]))
    expect(cents(byLane.get('claude')!.usd)).toBe(cents(20))
    expect(byLane.get('claude')!.label).toBe('Claude Code')
    expect(cents(byLane.get('claude-ai')!.usd)).toBe(cents(8))
    expect(byLane.get('claude-ai')!.label).toBe('Claude Chat')
    expect(cents(byLane.get('copilot')!.usd)).toBe(cents(5))
  })

  it('provenanceBreakdown: a blended row carries BOTH provenances, summing to the row total', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const aliceRow = findRow(r.rows, 'dtb-alice@x.test')
    expect(aliceRow.provenanceBreakdown).toBeDefined()
    const byProv = new Map(aliceRow.provenanceBreakdown!.map((p) => [p.provenance, p.usd]))
    expect(cents(byProv.get('otel-emitted')!)).toBe(cents(20 + 5)) // claude-code + copilot-cli
    expect(cents(byProv.get('provider-usage')!)).toBe(cents(8)) // claude-ai, no model axis
    const provSum = aliceRow.provenanceBreakdown!.reduce((a, p) => a + p.usd, 0)
    expect(cents(provSum)).toBe(cents(aliceRow.usd))
  })

  it('pooled-usage gate: copilot-cli-only (pre-existing) AND copilot-agent-only (widened, mig-0101) both read pooled', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const carolRow = findRow(r.rows, 'dtb-carol@x.test')
    expect(carolRow.spendClass).toBe('pooled-usage')
    expect(carolRow.indicativeReason).toBeUndefined()
    const bobRow = findRow(r.rows, 'dtb-bob@x.test')
    expect(bobRow.spendClass).toBe('pooled-usage')
    expect(cents(bobRow.usd)).toBe(cents(30))
    // Alice is mixed (Claude present) — indicative, with the precise reporting reason.
    const aliceRow = findRow(r.rows, 'dtb-alice@x.test')
    expect(aliceRow.spendClass).toBe('indicative')
    expect(aliceRow.indicativeReason).toBe('usage-not-yet-billed')
  })

  it('the whole-scope headline still sums back exactly (requirement 3 conservation)', async () => {
    const r = (await regionDrivers(evAll(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const sum = r.rows.reduce((a, x) => a + x.usd, 0)
    expect(cents(sum)).toBe(cents(r.headlineUsd))
    expect(cents(r.headlineUsd)).toBe(cents(33 + 30 + 15))
  })
})

describe('teammate driver rows — surface + provenance breakdown (Regional)', () => {
  it('mirrors the Across shape, region-clamped', async () => {
    const r = (await regionDrivers(ev(gfo(), `${RANGE}&axis=teammate`))) as unknown as DriversResp
    const aliceRow = findRow(r.rows, 'dtb-alice@x.test')
    expect(aliceRow.surfaceBreakdown).toBeDefined()
    const segSum = aliceRow.surfaceBreakdown!.reduce((a, s) => a + s.usd, 0)
    expect(cents(segSum)).toBe(cents(aliceRow.usd))
    expect(findRow(r.rows, 'dtb-bob@x.test').spendClass).toBe('pooled-usage')
  })
})

describe('teammate driver rows — surface breakdown (Cost-Centre)', () => {
  it('a CC-homed teammate keeps its Claude surface breakdown (Copilot pooled rows are structurally out of scope)', async () => {
    const r = (await ccDrillHandler(ev(gfo(), `${RANGE}&axis=teammate`, { ccId: unitA }))) as unknown as DriversResp
    const aliceRow = findRow(r.rows, 'dtb-alice@x.test')
    // Only claude-code (20) + claude-ai (8) are CC-homed; copilot-cli's NULL CoU excludes it.
    expect(cents(aliceRow.usd)).toBe(cents(28))
    const segSum = aliceRow.surfaceBreakdown!.reduce((a, s) => a + s.usd, 0)
    expect(cents(segSum)).toBe(cents(28))
    expect(aliceRow.surfaceBreakdown!.some((s) => s.lane === 'copilot')).toBe(false)
  })
})
