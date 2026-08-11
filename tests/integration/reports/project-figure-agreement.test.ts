// @vitest-environment node
/*
 * ONE PROJECT, ONE FIGURE — and a project axis that cannot grow without bound.
 *
 * ── WHY THIS FILE ────────────────────────────────────────────────────────────
 * The Cost-Centre scope renders TWO project surfaces on the same page: the P&L
 * owner's project table (`/me/cost-centres`) and the burn drill's project axis
 * (`/reports/cost-centres/[ccId]?axis=project`). They read the same seam, the same
 * lane and the same window — but the drill did not pass `excludeProvisional`, so
 * the same project under the same header showed two different totals depending on
 * which of the two a reader looked at. That is the exact defect the spend seam
 * exists to remove, reappearing one level down.
 *
 * The second half is what defaulting to the project axis created: the axis groups
 * EVERY project in scope, and the whole-company scope's "in scope" is the estate.
 * It is ranked and capped in SQL now, with the tail folded into ONE explicit
 * remainder row so the rows still sum back to the headline.
 *
 * The fixture is deliberately arithmetic-heavy: 52 projects burning $1…$52, plus
 * a PROVISIONAL row and an UNTAGGED row, so every claim below is a number that
 * could only come from the rule being right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { grantReportAccess } from '../helpers/report-access'
import type { Session } from '../../../server/utils/auth'
import { PROJECT_AXIS_ROW_CAP } from '../../../server/usage/complete-spend'
import meHandler from '../../../server/api/v1/me/cost-centres.get'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import regionDrivers from '../../../server/api/v1/reports/region/drivers.get'
// Asserted through the CONSTANT: these check WHICH DENOMINATOR the payload
// names, not the noun it is currently spelled with.
import { BU_LABEL_LOWER } from '../../../shared/reports/vocabulary'

let t: TestDb
let regionId = ''
let ccP = ''
let patId = ''

const now = new Date()
const currentMonth = now.toISOString().slice(0, 7)
const monthStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

/** $1 … $52 — Σ = 1378, and every project's burn is unique. */
const PROJECTS = 52
const TOTAL_CONFIRMED = (PROJECTS * (PROJECTS + 1)) / 2
/** Tagged to the TOP-ranked project, and excluded from every project figure. */
const PROVISIONAL_USD = 100
/** No project claim at all — the whole-company axis's untagged bucket. */
const UNTAGGED_USD = 0.5

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
/*
 * The WHOLE-COMPANY width of the merged `/reports/region*` family (was the
 * separate `/reports/across-regions*` routes). `region=all` is not an optional
 * extra here - it is what selects the unclamped engine scope, so every call that
 * used to reach an across route reaches it through this.
 */
const evAll = (session: Session, query = '', params: Record<string, string> = {}) =>
  ev(session, query ? `${query}&region=all` : 'region=all', params)

const patSession = (role = 'global-finops'): Session =>
  ({
    teammateId: patId,
    email: 'pat@p.test',
    displayName: 'Pat',
    role,
    regionId,
    orgPath: 'p',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

interface DriverRow {
  key: string
  label: string
  usd: number
}
interface DrillResp {
  axis: string
  burnUsd: number
  headlineUsd: number
  denominatorLabel: string
  rows: DriverRow[]
}
interface AcrossResp {
  headlineUsd: number
  rows: DriverRow[]
}
interface MeResp {
  cost_centres: {
    code: string
    mtd_cost_usd: string
    projects: { code: string; mtd_cost_usd: string }[]
    omitted_projects: { count: number; cost_usd: string; dormant_count: number }
  }[]
}

const topProject = `PROJ-P${PROJECTS}`

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('rp', 'Region P')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rp'`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'p'::ltree, 'p', 'Practice P', 'bu', true)`
  ;[{ id: ccP }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='p'`
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-p', 'pat@p.test', 'Pat', ${regionId}::uuid, ${ccP}::uuid, true)`
  ;[{ id: patId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email='pat@p.test'`
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${ccP}::uuid, ${patId}::uuid)`
  /*
   * mig 0129: `patId` is a REAL, dedicated row used ONLY by `patSession()` (any
   * role label it is called with still resolves to this same id) — no other
   * persona in this file shares it, and nothing here asserts a 403 or a
   * narrower scope for it, so a direct grant is safe. Granted BOTH permissions
   * to restore the pre-mig-0129 unconditional org-wide reach the default
   * 'global-finops' `patSession()` used to get from its role alone (needed for
   * the whole-company `region=all` drivers calls below). `/me/cost-centres`
   * (meHandler) is unaffected — it is grants-free by design (project-depth.ts's
   * own comment), and `resolveCostCentreDrill`'s unbounded/owner-only arms both
   * admit the SAME already-owned `ccP`, so the owner-table/drill agreement this
   * file exists to prove is untouched by the elevation.
   */
  await grantReportAccess(t.client, patId)
  await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${patId}::uuid, 'claude-code', ${regionId}::uuid, ${ccP}::uuid, 'h', 'P')`
  const [{ id: inst }] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${patId}::uuid LIMIT 1`

  const ar = async (
    cost: number,
    key: string,
    projectId: string | null,
    identity: 'confirmed' | 'provisional' = 'confirmed',
    cou: string | null = ccP,
  ) => {
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id, identity_state)
      VALUES (${inst}::uuid, ${patId}::uuid, ${regionId}::uuid, ${ccP}::uuid, ${cou}::uuid, ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 10, ${cost}, 'tier-1', 'estimated', ${monthStartIso}::timestamptz, ${key}, ${identity})`
  }

  for (let i = 1; i <= PROJECTS; i++) {
    const code = `PROJ-P${i}`
    await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES (${code}, 'hash-'||${code}, ${code}, 'billable', ${regionId}::uuid, ${ccP}::uuid)`
    const [{ id }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
    await ar(i, `conv-${i}`, id)
    // The provisional dollar rides the TOP-ranked project, so it lands on a row
    // both surfaces render — a difference hidden on a ranked-out row proves nothing.
    if (i === PROJECTS) await ar(PROVISIONAL_USD, `conv-prov`, id, 'provisional')
  }
  // No project claim and no burn home — the whole-company axis's untagged bucket.
  await ar(UNTAGGED_USD, 'conv-untagged', null, 'confirmed', null)
}, 300_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('the same project shows the SAME total on both surfaces of the scope', () => {
  it('the owner table and the drill’s project axis agree, to the cent', async () => {
    const me = (await meHandler(ev(patSession('developer')))) as unknown as MeResp
    const drill = (await drillHandler(
      ev(patSession(), `month=${currentMonth}&axis=project`, { ccId: ccP }),
    )) as unknown as DrillResp
    const fromTable = me.cost_centres[0]!.projects.find((p) => p.code === topProject)!
    const fromDrill = drill.rows.find((r) => r.label === topProject)!
    expect(fromTable, 'the top project must be on the owner table').toBeDefined()
    expect(fromDrill, 'the top project must be on the drill axis').toBeDefined()
    expect(fromDrill.usd).toBeCloseTo(Number(fromTable.mtd_cost_usd), 6)
    // …and the agreed figure is the CONFIRMED one: $52, not $152.
    expect(Number(fromTable.mtd_cost_usd)).toBe(PROJECTS)
    expect(fromDrill.usd).toBe(PROJECTS)
  })

  it('the excluded dollar IS on the lane — the agreement is a rule, not an empty fixture', async () => {
    const drill = (await drillHandler(
      ev(patSession(), `month=${currentMonth}&axis=project`, { ccId: ccP }),
    )) as unknown as DrillResp
    // The BURN is the raw lane and keeps the provisional row; the project axis is
    // a budget figure and drops it. Both numbers below come from the same request.
    expect(drill.burnUsd).toBe(TOTAL_CONFIRMED + PROVISIONAL_USD)
    expect(drill.headlineUsd).toBe(TOTAL_CONFIRMED)
    // The axis gained a second, disjoint arm (F5 D30 — burn homed here with no
    // project on it), and its denominator names it. This fixture has no such
    // row, so the headline above is unmoved; the LABEL had to move with the axis.
    expect(drill.denominatorLabel).toBe(`this ${BU_LABEL_LOWER}'s projects, and burn on none`)
  })

  it('a SCOPE-TOTAL axis still counts it — that difference is the axis, not a drift', async () => {
    /*
     * The whole-company project axis must SUM BACK to the company's usage total,
     * which includes provisional identity spend; the cost-centre axis is a budget
     * figure against a budget denominator, and every budget figure in the product
     * drops an unconfirmed binding. Two questions, two answers, both stated.
     */
    const across = (await regionDrivers(
      evAll(patSession(), `month=${currentMonth}&axis=project`),
    )) as unknown as AcrossResp
    expect(across.rows.find((r) => r.label === topProject)!.usd).toBe(PROJECTS + PROVISIONAL_USD)
    expect(across.headlineUsd).toBeCloseTo(TOTAL_CONFIRMED + PROVISIONAL_USD + UNTAGGED_USD, 6)
  })
})

describe('the project axis is ranked and capped, and names the tail it folded', () => {
  it('whole-company: top N + ONE remainder row, and the rows still foot to the headline', async () => {
    const across = (await regionDrivers(
      evAll(patSession(), `month=${currentMonth}&axis=project`),
    )) as unknown as AcrossResp
    const remainder = across.rows.filter((r) => r.key === '__all_other_projects__')
    expect(remainder).toHaveLength(1)
    // 52 projects, cap 50 ⇒ two folded. Ranked by $: the provisional-carrying
    // top project leads at $152, then $52…$3; $2 and $1 are the tail.
    expect(remainder[0]!.label).toBe('(all other — 2 projects)')
    expect(remainder[0]!.usd).toBeCloseTo(3, 6)
    // Rows = 50 projects + the remainder + the untagged bucket.
    expect(across.rows).toHaveLength(PROJECT_AXIS_ROW_CAP + 2)
    // THE invariant a cap must not break.
    expect(across.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(across.headlineUsd, 6)
  })

  it('the UNTAGGED bucket is never folded into "other projects" — it is not a project', async () => {
    const across = (await regionDrivers(
      evAll(patSession(), `month=${currentMonth}&axis=project`),
    )) as unknown as AcrossResp
    // It ranks BELOW the cap ($0.50, the smallest row in the fixture), so a cap
    // that simply truncated the ranking would have swallowed it — and labelled
    // money nobody tagged as "(all other — N projects)".
    const untagged = across.rows.find((r) => r.label === 'Untagged')
    expect(untagged).toBeDefined()
    expect(untagged!.usd).toBeCloseTo(UNTAGGED_USD, 6)
  })

  it('the cost-centre drill does NOT cap — at one cost centre the list IS the population', async () => {
    /*
     * The contrast is the point, and it is drawn over the SAME 52 projects the
     * whole-company assertion above just capped at 50. Two scopes, two answers,
     * one fixture — so "uncapped" cannot be an artefact of a smaller estate, and
     * a change that raised the shared cap instead of adding a population variant
     * would make BOTH tests agree and one of them wrong
     * (04-prototype-delta.md §5b).
     *
     * A cost-centre owner is not exploring: they own each of these budgets
     * individually, so "(all other — 2 projects)" is not a row they can act on,
     * and the two it hides are exactly the ones they came to find.
     */
    const drill = (await drillHandler(
      ev(patSession(), `month=${currentMonth}&axis=project`, { ccId: ccP }),
    )) as unknown as DrillResp
    expect(drill.rows).toHaveLength(PROJECTS)
    expect(drill.rows).not.toHaveLength(PROJECT_AXIS_ROW_CAP + 1)
    // No tail, under either name: the hero's mapper has no remainder branch, so
    // a folded row arriving here would render as "Untagged" — money nobody
    // failed to tag. Both faces of that defect are checked.
    expect(drill.rows.map((r) => r.key)).not.toContain('__all_other_projects__')
    expect(drill.rows.some((r) => /all other/.test(r.label))).toBe(false)
    expect(drill.rows.map((r) => r.label)).not.toContain('Untagged')
    // The rows the old cap folded — ranked $2 and $1 — are present as themselves.
    const smallest = drill.rows.map((r) => r.usd).sort((a, b) => a - b).slice(0, 2)
    expect(smallest).toEqual([1, 2])
    // THE invariant an uncapped list must still hold.
    expect(drill.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(drill.headlineUsd, 6)
    // Shares still add to 1 — no remainder needed to close the gap.
    expect(drill.rows.reduce((a, r) => a + (r as DriverRow & { sharePct: number }).sharePct, 0)).toBeCloseTo(1, 6)
  })

  it('the owner table caps SEPARATELY, on its own smaller page, and both still close', async () => {
    const me = (await meHandler(ev(patSession('developer')))) as unknown as MeResp
    const card = me.cost_centres[0]!
    const shown = card.projects.reduce((s, p) => s + Number(p.mtd_cost_usd), 0)
    expect(Number(card.mtd_cost_usd)).toBe(TOTAL_CONFIRMED)
    expect(shown + Number(card.omitted_projects.cost_usd)).toBeCloseTo(TOTAL_CONFIRMED, 6)
    expect(card.omitted_projects.count).toBe(PROJECTS - card.projects.length)
  })
})
