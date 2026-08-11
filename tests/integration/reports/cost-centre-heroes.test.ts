// @vitest-environment node
/*
 * THE COST-CENTRE HEROES SHOW THE WHOLE POPULATION, AND THE RANKED SEAM STILL
 * RANKS.
 *
 * `docs/design/reporting-consolidation/04-prototype-delta.md` §5b: a cost-centre
 * owner sees BUDGETS and PEOPLE side by side, and **neither list truncates** —
 * at this scope the list IS the population, and a top-N hides the row the owner
 * opened the page to find.
 *
 * The change is a SEAM change, and that is what makes it worth a real database.
 * `completeProjectAxisSpend` ranks and caps at 50 with a named "(all other — N
 * projects)" tail; the heroes read `completeProjectAxisPopulation` instead.
 * Adding an uncapped variant is only correct if the RANKED one keeps its cap —
 * raising the cap would have passed every "the hero shows everything" assertion
 * while silently unbounding the whole-company driver table, whose default axis
 * groups every project in the estate.
 *
 * So both halves are asserted here, against ONE fixture of 63 projects, so the
 * two answers cannot be reconciled by looking at different data:
 *   - the cost-centre hero returns all 63, with NO remainder row;
 *   - `fetchDrivers(axis:'project')` over the same 63 returns 50 + one tail row
 *     that names the 13 it folded.
 *
 * 63 is deliberately > 50 and not a multiple of it: an off-by-one in the rank
 * filter shows up as 50/51/62/64, all of which are distinguishable here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import {
  fetchCostCentreBurnDrill,
  fetchCostCentreHeroes,
} from '../../../server/reporting/cost-centres'
import { fetchDrivers } from '../../../server/reporting/engine/drivers'
import { wholeCompanyUsage } from '../../../server/reporting/engine/scope'
import { PROJECT_AXIS_ROW_CAP, PROJECT_AXIS_REMAINDER_KEY } from '../../../server/usage/complete-spend'
// Asserted through the CONSTANT: these check WHICH DENOMINATOR the payload
// names, not the noun it is currently spelled with.
import { BU_LABEL_LOWER } from '../../../shared/reports/vocabulary'

let t: TestDb
let regionId = ''
let ccId = ''

/** > PROJECT_AXIS_ROW_CAP, and not a multiple of it (see the header). */
const PROJECT_COUNT = 63
/** Only two carry an allocation — "no budget set" is the majority state here. */
const BUDGETED = { index: 0, usd: 200 }
const ALSO_BUDGETED = { index: 7, usd: 50 }

const WINDOW = { startIso: '2026-07-01T00:00:00.000Z', endIso: '2026-08-01T00:00:00.000Z' }

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
  ({
    teammateId: '00000000-0000-0000-0000-000000000009',
    email: 'g@p.test',
    displayName: 'G',
    role: 'global-finops',
    regionId,
    orgPath: 'pop',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

/** Project i spends `PROJECT_COUNT - i` dollars — strictly descending, all distinct. */
const spendOf = (i: number) => PROJECT_COUNT - i
const TOTAL_PROJECT_SPEND = Array.from({ length: PROJECT_COUNT }, (_, i) => spendOf(i)).reduce(
  (a, b) => a + b,
  0,
)

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('rp', 'Region Pop')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rp'`
  await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
    VALUES (${regionId}::uuid, 'pop'::ltree, 'pop', 'Population CC', 'bu', true)`
  ;[{ id: ccId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code='pop'`

  // THREE spenders, at distinct totals, so the people hero's population is a
  // count no single row can fake.
  const teammates: string[] = []
  const instances: string[] = []
  for (const name of ['ada', 'grace', 'lin']) {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${'oid-' + name}, ${name + '@p.test'}, ${name}, ${regionId}::uuid, ${ccId}::uuid, true)`
    const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${name + '@p.test'}`
    teammates.push(tm!.id)
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${tm!.id}::uuid, 'claude-code', ${regionId}::uuid, ${ccId}::uuid, ${'h-' + name}, ${'P-' + name})`
    const [inst] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${tm!.id}::uuid LIMIT 1`
    instances.push(inst!.id)
  }

  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`

  for (let i = 0; i < PROJECT_COUNT; i++) {
    // Zero-padded so the LABEL sorts the same way a human reads it — a tie-break
    // on `label` must not depend on '10' < '9'.
    const code = `POP-${String(i).padStart(3, '0')}`
    await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
      VALUES (${code}, ${'hash-' + code}, ${'Budget ' + String(i).padStart(3, '0')}, 'billable', ${regionId}::uuid, ${ccId}::uuid)`
    const [p] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`

    // Round-robin the spenders so the people hero has three real rows and the
    // budget hero's totals are not one person's.
    const k = i % 3
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${instances[k]!}::uuid, ${teammates[k]!}::uuid, ${regionId}::uuid, ${ccId}::uuid, ${ccId}::uuid, ${p!.id}::uuid,
              'claude-code', 'claude-sonnet-4-6', 'input', 100, ${spendOf(i)}, 'tier-1', 'estimated', '2026-07-02T00:00:00Z'::timestamptz, ${'conv-' + code})`

    if (i === BUDGETED.index || i === ALSO_BUDGETED.index) {
      const usd = i === BUDGETED.index ? BUDGETED.usd : ALSO_BUDGETED.usd
      await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
        VALUES ('project', ${p!.id}::uuid, ${usd}, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`
    }
  }
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('the BUDGETS hero is the population, not a ranked page of it', () => {
  it(`returns every one of the ${PROJECT_COUNT} budgets — the count IS the population`, async () => {
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    expect(budgets.rows).toHaveLength(PROJECT_COUNT)
    // Independently counted against the estate itself, so a hard-coded 63 in the
    // fixture and a hard-coded 63 in the assertion cannot agree with each other
    // while both being wrong about the database.
    const [{ n }] = [
      ...(await t.db.execute<{ n: string }>(
        sql`SELECT COUNT(*)::text AS n FROM project WHERE cost_owning_unit_id = ${ccId}::uuid`,
      )),
    ]
    expect(budgets.rows).toHaveLength(Number(n))
  })

  it('folds NO tail, and cannot smuggle one in under another name', async () => {
    /*
     * Two ways a tail could appear, and both are checked. The obvious one is the
     * remainder key. The subtle one is that the hero's mapper no longer HAS a
     * remainder branch — so a tail row arriving from a re-capped seam would fall
     * through to the NULL-project fallback and render as "Untagged", labelling
     * money nobody failed to tag. The `p` clamp cannot produce a real untagged
     * row, so either of these appearing is the same defect wearing two faces.
     */
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    expect(budgets.rows.map((r) => r.key)).not.toContain(PROJECT_AXIS_REMAINDER_KEY)
    expect(budgets.rows.some((r) => /all other/.test(r.label))).toBe(false)
    expect(budgets.rows.map((r) => r.key)).not.toContain('__null_project')
    expect(budgets.rows.map((r) => r.label)).not.toContain('Untagged')
  })

  it('carries the LOWEST-ranked budget — the row a top-50 would have hidden', async () => {
    // Rank 63 by spend. This is the assertion the whole story exists for: the
    // owner opened the page to find exactly this row.
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    const last = budgets.rows.find((r) => r.label === `Budget ${String(PROJECT_COUNT - 1).padStart(3, '0')}`)
    expect(last, 'the lowest-spending budget must be listed').toBeDefined()
    expect(last!.usd).toBe(spendOf(PROJECT_COUNT - 1))
    // …and so is every rank between the cap and the end.
    for (let i = PROJECT_AXIS_ROW_CAP; i < PROJECT_COUNT; i++) {
      expect(
        budgets.rows.some((r) => r.label === `Budget ${String(i).padStart(3, '0')}`),
        `rank ${i + 1} must be listed`,
      ).toBe(true)
    }
  })

  it('sums back to its OWN headline, and the shares sum to 1', async () => {
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    expect(budgets.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(budgets.headlineUsd, 6)
    expect(budgets.headlineUsd).toBe(TOTAL_PROJECT_SPEND)
    expect(budgets.rows.reduce((a, r) => a + r.sharePct, 0)).toBeCloseTo(1, 6)
    // The axis gained a second arm (F5 D30 — burn homed here with NO project on
    // it), and its denominator says so. This fixture has no such row, so the
    // headline is unchanged; the LABEL is what a reader is misled without.
    expect(budgets.denominatorLabel).toBe(`this ${BU_LABEL_LOWER}'s projects, and burn on none`)
  })

  it('carries each budget’s own allocation — a number, or an explicit null', async () => {
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    const byLabel = new Map(budgets.rows.map((r) => [r.label, r]))
    const budgeted = byLabel.get(`Budget ${String(BUDGETED.index).padStart(3, '0')}`)!
    expect(budgeted.budgetUsd).toBe(BUDGETED.usd)
    // Consumption is `usd / budgetUsd` at render — the operands must both be here.
    expect(budgeted.usd).toBe(spendOf(BUDGETED.index))
    expect(byLabel.get(`Budget ${String(ALSO_BUDGETED.index).padStart(3, '0')}`)!.budgetUsd).toBe(
      ALSO_BUDGETED.usd,
    )
    // Everything else is `null`, NOT 0 and NOT absent: "no budget set" is a state
    // the row has to be able to say, and 0 would read as a spent-out budget.
    const unbudgeted = byLabel.get('Budget 001')!
    expect(unbudgeted.budgetUsd).toBeNull()
    expect(
      budgets.rows.filter((r) => r.budgetUsd === null),
      'every other budget is explicitly unset',
    ).toHaveLength(PROJECT_COUNT - 2)
  })
})

describe('the PEOPLE hero is the population too, on its own denominator', () => {
  it('returns every spender and sums back to the cost-centre BURN', async () => {
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { people } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    // `display_name` wins over email in the driver label.
    expect(people.rows.map((r) => r.label).sort()).toEqual(['ada', 'grace', 'lin'])
    expect(people.rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(burn.burnUsd, 6)
    expect(people.headlineUsd).toBe(burn.burnUsd)
    expect(people.denominatorLabel).toBe(`${BU_LABEL_LOWER} burn`)
  })

  it('does NOT share a denominator with the budgets hero — they differ by construction', async () => {
    /*
     * Here the two totals happen to be equal (every dollar is arm 1: a real
     * project AND a real cost-owning unit). That is worth pinning, because it is
     * the case where a renderer could get away with footing one list against the
     * other's number — and then break the moment arm 2 lands. The LABELS are what
     * keep them apart, so they are asserted rather than the coincidence.
     */
    const burn = await fetchCostCentreBurnDrill(t.db, ccId, WINDOW)
    const { budgets, people } = await fetchCostCentreHeroes(t.db, ccId, WINDOW, burn.burnUsd)
    expect(budgets.denominatorLabel).not.toBe(people.denominatorLabel)
  })
})

describe('the RANKED seam still caps at 50 for every other caller', () => {
  it('the whole-company project axis returns 50 rows plus ONE named tail', async () => {
    const { rows } = await fetchDrivers(t.db, wholeCompanyUsage, WINDOW, 'project')
    const tail = rows.filter((r) => r.key === PROJECT_AXIS_REMAINDER_KEY)
    expect(tail, 'the ranked seam must still fold a tail').toHaveLength(1)
    expect(rows.filter((r) => r.key !== PROJECT_AXIS_REMAINDER_KEY)).toHaveLength(
      PROJECT_AXIS_ROW_CAP,
    )
    expect(PROJECT_AXIS_ROW_CAP).toBe(50)
  })

  it('the tail NAMES what it hides, and the rows still sum to the whole estate', async () => {
    const { rows, headlineUsd } = await fetchDrivers(t.db, wholeCompanyUsage, WINDOW, 'project')
    const folded = PROJECT_COUNT - PROJECT_AXIS_ROW_CAP
    const tail = rows.find((r) => r.key === PROJECT_AXIS_REMAINDER_KEY)!
    expect(tail.label).toBe(`(all other — ${folded} projects)`)
    // A cap that dropped money instead of folding it would still "look ranked".
    expect(rows.reduce((a, r) => a + r.usd, 0)).toBeCloseTo(headlineUsd, 6)
    expect(headlineUsd).toBe(TOTAL_PROJECT_SPEND)
    expect(tail.usd).toBeCloseTo(
      Array.from({ length: folded }, (_, i) => spendOf(PROJECT_AXIS_ROW_CAP + i)).reduce((a, b) => a + b, 0),
      6,
    )
  })

  /*
   * SUPERSEDED, deliberately. This assertion used to read "the ranked seam
   * carries NO budget figure", on the grounds that an exploratory axis spanning
   * cost centres would put a per-project allocation beside rows from every centre
   * in the estate.
   *
   * `prototype.html` lines 821-829 overrules it, and the old reasoning does not
   * survive contact with it: a project's allocation is a fact about THAT project
   * whichever centre owns it, and nothing here adds two centres' figures
   * together. What the old column did instead was answer "% of the company",
   * which "tells a project owner nothing they can act on, and gets smaller as the
   * estate grows".
   *
   * What is NOT superseded is which rows may carry the field. The folded tail is
   * several projects' allocations and cannot be one percentage, so it carries
   * none — and renders as not-applicable rather than as "no budget set".
   */
  it('every real project row carries an allocation figure; the folded tail carries none', async () => {
    const { rows } = await fetchDrivers(t.db, wholeCompanyUsage, WINDOW, 'project')
    const tail = rows.find((r) => r.key === PROJECT_AXIS_REMAINDER_KEY)!
    expect(tail.budgetUsd).toBeUndefined()
    const projects = rows.filter((r) => r.key !== PROJECT_AXIS_REMAINDER_KEY)
    expect(projects.length).toBe(PROJECT_AXIS_ROW_CAP)
    expect(projects.every((r) => r.budgetUsd !== undefined)).toBe(true)
  })
})

describe('the drill endpoint carries both heroes on the wire', () => {
  it('returns budgets + people, uncapped, alongside the single-axis answer', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-07', { ccId }))) as unknown as {
      axis: string
      rows: { key: string; label: string }[]
      budgets: { rows: { key: string; label: string; budgetUsd?: number | null }[]; headlineUsd: number }
      people: { rows: { label: string }[]; headlineUsd: number }
    }
    expect(d.budgets.rows).toHaveLength(PROJECT_COUNT)
    expect(d.people.rows).toHaveLength(3)
    // `?axis=` is UNCHANGED and still defaults to project — the callers nobody is
    // watching (a script, a saved link, the CSV export) keep their contract.
    expect(d.axis).toBe('project')
    // …and it is the SAME computation aliased, never a second query that agrees
    // today: identical keys in identical order.
    expect(d.rows.map((r) => r.key)).toEqual(d.budgets.rows.map((r) => r.key))
  })

  it('the teammate axis is served from the same heroes, not re-queried', async () => {
    const d = (await drillHandler(ev(gfo(), 'month=2026-07&axis=teammate', { ccId }))) as unknown as {
      axis: string
      rows: { key: string }[]
      people: { rows: { key: string }[] }
    }
    expect(d.axis).toBe('teammate')
    expect(d.rows.map((r) => r.key)).toEqual(d.people.rows.map((r) => r.key))
  })
})
