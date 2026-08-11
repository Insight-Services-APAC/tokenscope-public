// @vitest-environment node
/*
 * fetchOverSoftCap — unallocated spend over the soft cap, on the Cost-Centre drill
 * (docs/design/reporting-consolidation/04-prototype-delta.md §5 and §7).
 *
 * WHAT THIS PROVES, in the order the design demands it:
 *
 *   1. THE POPULATION IS THE ROSTER, NOT THE BURN. `rosterCount` equals the cost
 *      centre's PLACEMENT count and does not move with spend. The sharp fixture is
 *      Mo, whose only usage is Copilot reconciliation rows: they carry NULL
 *      `cost_owning_unit_id` BY CONSTRUCTION (mig 0101/0113), so a burn-anchored
 *      scan cannot see him at all — and he is the largest unallocated sum on the
 *      card. That is the whole reason this primitive does not reuse the burn clamp.
 *   2. THE GROUPS PARTITION THE ROSTER. Mutually exclusive and exhaustive:
 *      `over.length + withinAllowance.teammates = rosterCount`, always.
 *   3. THE PARTS FOOT. `allocatedUsd + unallocatedUsd = rosterUsd`, cent-exact, in
 *      the one §A lane.
 *   4. ACTIVE MEMBERSHIP IS THE SAME PREDICATE THE WRITE PATH GATES ON. Someone
 *      whose only project has ENDED is grouped `on-no-project` — a nudge to them is
 *      an instruction `tagUnaccountedTx` would 409.
 *   5. THE RATE IS NOT A GATE. An 88%-tagging heavy user is over the cap and listed.
 *   6. THE POLICY IS THE PRODUCT'S. The cap is `NUXT_BASE_ALLOWANCE_USD`, read
 *      through the same fn the developer's own page uses, compared with the same
 *      `>=` — a teammate at EXACTLY the cap is over it on both surfaces.
 *
 * WHY A CLOSED MONTH (March 2026). The membership gates evaluate at `now()` while
 * the money is windowed, so a fixture sitting on the current month would let a
 * window bug and a membership bug alias each other. Two guard rows either side of
 * the window make a one-day slip a total nothing else here can produce.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import type { OverSoftCap } from '#shared/reports/types'
import drillHandler from '../../../server/api/v1/reports/cost-centres/[ccId].get'
import exportHandler from '../../../server/api/v1/reports/export.get'
import { costCentreRosterScope } from '../../../server/reporting/cost-centres'
import { fetchOverSoftCap } from '../../../server/reporting/engine/over-soft-cap'
import { resolveReportWindow } from '../../../server/reporting/params'

let t: TestDb
let region = ''
let ccMain = '' // the cost centre under test
let ccOther = '' // a sibling, so "the clamp is threaded" is a different NUMBER
let unitChild = '' // a NON-cost-owning team BELOW ccMain — people really sit here

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
  ({ teammateId: '00000000-0000-0000-0000-000000000009', email: 'x@x.test', displayName: 'X', role: 'global-finops', regionId: region, orgPath: 'osc', issuedAt: new Date().toISOString() } as unknown as Session)

const cents = (n: number) => Math.round(n * 100)

interface DrillResp {
  burnUsd: number
  overSoftCap: OverSoftCap
}

const drill = async (ccId: string, query = 'month=2026-03'): Promise<DrillResp> =>
  (await drillHandler(ev(gfo(), query, { ccId }))) as unknown as DrillResp

const osc = async (ccId: string, query = 'month=2026-03'): Promise<OverSoftCap> =>
  (await drill(ccId, query)).overSoftCap

const byName = (d: OverSoftCap, name: string) => d.over.find((r) => r.teammate === name)

/*
 * ── THE FIXTURE, stated as the arithmetic below checks ───────────────────────
 *
 * Cost centre MAIN — 6 ACTIVE placements + 1 deactivated leaver.
 *
 *  person   placed        arm(s) in March 2026          tagged   untagged  projects
 *  ──────────────────────────────────────────────────────────────────────────────
 *  Vee      ccMain        arm 1                         1600.00   200.00   2 active
 *      88.9% tagged and still 2× the cap unallocated — THE row every rate-gated
 *      draft of this card dropped. Group: on-projects.
 *
 *  Mo       ccMain        arm 2 ONLY (copilot-cli)         0.00   450.00   1 active
 *      unaccounted_usage carries cost_owning_unit_id NULL BY CONSTRUCTION, so NONE
 *      of his money is in this cost centre's burn. A burn-anchored card omits the
 *      biggest unallocated sum on the page. Group: on-projects.
 *
 *  Ren     unitChild      arm 1                            0.00   300.00   1 ENDED
 *      Placed on a plain `team` node BELOW the cost centre (the /admin/users move
 *      allows it), so a clamp on `org_unit_id = ccId` loses him. His only project
 *      ENDED before now, so the tag write path would 409 him: on-no-project.
 *
 *  Ida      ccMain        arm 1                            0.00   100.00   0
 *      EXACTLY at the cap. `>=` is the shipped comparison (me-queries.ts), so she
 *      is over it here exactly as her own page badges her. Group: on-no-project.
 *
 *  Cy       ccMain        arm 1                          220.00     0.00   1 active
 *      Every dollar on a budget → within allowance, and FULLY ALLOCATED.
 *
 *  Nia      ccMain        arm 1                            0.00    45.00   1 active
 *      Under the cap → within allowance, but NOT fully allocated.
 *
 *  Gus      ccMain        arm 1, is_active = FALSE      (2000.00) (900.00)
 *      A DEACTIVATED leaver. Not on the roster: there is no one to contact, and
 *      the product counts a unit's occupancy the same way. His money is in NEITHER
 *      rosterUsd nor the groups — figures large enough that including him would be
 *      visible in every total at once.
 *
 *  roster        = 6 (Vee, Mo, Ren, Ida, Cy, Nia)
 *  rosterUsd     = 2915.00   allocated 1820.00   unallocated 1095.00
 *  over the cap  = Vee 200 + Mo 450 + Ren 300 + Ida 100 = 1050.00 across 4
 *  within        = Cy + Nia = 2 people, 45.00 unallocated, 1 fully allocated
 *  BURN (cost_owning_unit_id = ccMain) = 1600 (Vee) + 220 (Cy) + 2000 (Gus) = 3820.00
 *      NEITHER FIGURE CONTAINS THE OTHER, which is exactly why they are named
 *      separately. The burn carries Gus's $2,000 (the burn axis is homed by the
 *      TAGGED PROJECT and knows nothing about who is still employed) and misses
 *      Mo's $450 (NULL cost-owning unit on the reconciled arm). rosterUsd is the
 *      mirror image. A reader handed one under the other's label is wrong in both
 *      directions at once.
 *
 * Cost centre OTHER — 1 active placement (Zed), 700.00 unallocated, no projects.
 *      Every figure differs from MAIN's, so a dropped clamp is a wrong NUMBER.
 */
const MAIN = {
  rosterCount: 6,
  rosterUsd: 2915,
  allocatedUsd: 1820,
  unallocatedUsd: 1095,
  overCount: 4,
  overUsd: 1050,
  withinTeammates: 2,
  withinUnallocatedUsd: 45,
  fullyAllocated: 1,
  burnUsd: 3820,
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  // The card's policy input. Pinned here so the assertions are about the code, not
  // about whatever the ambient environment happens to carry.
  process.env.NUXT_BASE_ALLOWANCE_USD = '100'

  await t.client`INSERT INTO region (code, display_name) VALUES ('osc', 'Soft Cap Region')`
  const [rg] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='osc'`
  region = rg!.id

  const mkUnit = async (path: string, code: string, costOwning: boolean, parentId: string | null = null) => {
    await t.client`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${region}::uuid, ${parentId}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', ${costOwning})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE region_id=${region}::uuid AND code=${code}`
    return r!.id
  }
  const root = await mkUnit('osc', 'default', false)
  ccMain = await mkUnit('osc.main', 'main', true, root)
  ccOther = await mkUnit('osc.other', 'other', true, root)
  // NOT cost-owning, and BELOW ccMain. placeTeammate's 'any-active-unit' policy (the
  // per-row /admin/users move) puts real people on nodes like this one.
  unitChild = await mkUnit('osc.main.team', 'mainteam', false, ccMain)

  /*
   * THE CALLERS, as real teammate rows. The over-soft-cap export now writes a
   * `report-export-teammate-axis` audit row, and `audit_event.actor_teammate_id`
   * REFERENCES teammate(id) — a session whose id has no row is a FK violation at
   * export time, not a silent no-op.
   *
   * Placed on the ROOT, which is above both cost centres and therefore in
   * NEITHER roster: a caller in the roster would move `rosterCount` and every
   * partition assertion below it.
   */
  for (const [id, email] of [
    ['00000000-0000-0000-0000-000000000009', 'gfo@osc.test'],
    ['00000000-0000-0000-0000-00000000000c', 'outsider@osc.test'],
  ] as const) {
    await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES (${id}::uuid, 'oid-'||${email}, ${email}, ${email}, ${region}::uuid, ${root}::uuid, true)`
  }

  const mkTeammate = async (unit: string, name: string, active = true) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${name}, ${name}||'@osc.test', ${name}, ${region}::uuid, ${unit}::uuid, ${active})`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${name + '@osc.test'}`
    return r!.id
  }
  const vee = await mkTeammate(ccMain, 'Vee')
  const mo = await mkTeammate(ccMain, 'Mo')
  const ren = await mkTeammate(unitChild, 'Ren')
  const ida = await mkTeammate(ccMain, 'Ida')
  const cy = await mkTeammate(ccMain, 'Cy')
  const nia = await mkTeammate(ccMain, 'Nia')
  const gus = await mkTeammate(ccMain, 'Gus', false)
  const zed = await mkTeammate(ccOther, 'Zed')

  // ONE instance per teammate, minted up front — `ar()` below looks its id up by
  // teammate, so the emitted rows all hang off a single enrolment per person.
  const instances = new Map<string, string>()
  const mkInstance = async (teammate: string, unit: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p-'||${teammate}, ${teammate}::uuid, 'claude-code', ${region}::uuid, ${unit}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammate}::uuid LIMIT 1`
    instances.set(teammate, r!.id)
  }
  for (const [tm, unit] of [
    [vee, ccMain], [mo, ccMain], [ren, unitChild], [ida, ccMain],
    [cy, ccMain], [nia, ccMain], [gus, ccMain], [zed, ccOther],
  ] as const) {
    await mkInstance(tm, unit)
  }

  const mkProject = async (code: string, cou: string, endDate: string | null = null) => {
    await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id, end_date)
      VALUES (${code}, 'h-'||${code}, ${code}, 'billable', ${region}::uuid, ${cou}::uuid, ${endDate}::timestamptz)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
    return r!.id
  }
  const pLive1 = await mkProject('OSC-LIVE-1', ccMain)
  const pLive2 = await mkProject('OSC-LIVE-2', ccMain)
  // A LIVE project in the sibling centre that Zed is deliberately NOT assigned to:
  // the group is decided by MEMBERSHIP, never by "a budget exists nearby".
  await mkProject('OSC-OTHER', ccOther)
  // ENDED well before now — the tag write path rejects it (409), so a membership of
  // it must not read as "a budget exists to put this on".
  const pEnded = await mkProject('OSC-ENDED', ccMain, '2026-04-15')

  const assign = async (project: string, teammate: string, lo = '2020-01-01', hi: string | null = null) => {
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective)
      VALUES (${project}::uuid, ${teammate}::uuid, tstzrange(${lo}::timestamptz, ${hi}::timestamptz, '[)'))`
  }
  await assign(pLive1, vee)
  await assign(pLive2, vee) // 2 active memberships
  await assign(pLive1, mo)
  await assign(pLive1, cy)
  await assign(pLive1, nia)
  // Ren's ONLY membership is of an ENDED project. A live assignment row on a dead
  // project is exactly the shape that must NOT count.
  await assign(pEnded, ren)
  // …and an EXPIRED assignment of a LIVE project, so the two gates are proven
  // independently: dropping either one alone moves Ren between the groups.
  await assign(pLive2, ren, '2020-01-01', '2021-01-01')

  // ── arm 1 (otel-emitted): carries cost_owning_unit_id from the TAGGED project ──
  const ar = async (
    teammate: string, unit: string, day: string, cost: number,
    projectId: string | null, cou: string | null, tool = 'claude-code',
  ) => {
    const inst = instances.get(teammate)!
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
         token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${teammate}::uuid, ${region}::uuid, ${unit}::uuid, ${cou}::uuid, ${projectId}::uuid,
              ${tool}, 'claude-sonnet-4-6', 'input', 1000, ${cost}, 'tier-1', 'estimated',
              (${day}::date)::timestamp, 'conv-'||${teammate}||'-'||${day}||'-'||${cost}::text)`
  }
  await ar(vee, ccMain, '2026-03-02', 1600, pLive1, ccMain)
  await ar(vee, ccMain, '2026-03-03', 200, null, null)
  await ar(ren, unitChild, '2026-03-04', 300, null, null)
  await ar(ida, ccMain, '2026-03-05', 100, null, null)
  await ar(cy, ccMain, '2026-03-06', 220, pLive1, ccMain)
  await ar(nia, ccMain, '2026-03-07', 45, null, null)
  // The deactivated leaver — deliberately the largest figures in the fixture, so
  // admitting him is visible in EVERY total rather than only in the count.
  await ar(gus, ccMain, '2026-03-08', 2000, pLive1, ccMain)
  await ar(gus, ccMain, '2026-03-09', 900, null, null)
  // The sibling cost centre.
  await ar(zed, ccOther, '2026-03-10', 700, null, null)
  // WINDOW GUARDS — the day before it opens and the day it closes (exclusive). A
  // one-day slip at either end is a total nothing else in this fixture produces.
  await ar(vee, ccMain, '2026-02-28', 5000, null, null)
  await ar(vee, ccMain, '2026-04-01', 6000, null, null)

  // ── arm 2 (api-reconciled): cost_owning_unit_id is NULL BY CONSTRUCTION ────────
  // Mo's ENTIRE spend. Invisible to `v_complete_usage WHERE cost_owning_unit_id`,
  // and the largest unallocated sum on this card.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, project_id, day, tool, cost_usd, tokens, source)
    VALUES (${mo}::uuid, ${region}::uuid, ${ccMain}::uuid, NULL, '2026-03-11'::date, 'copilot-cli', 450, 0, 'api-reconciled')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('the population is the ROSTER, not the burn', () => {
  it('rosterCount is the cost centre PLACEMENT count, read back from the placements themselves', async () => {
    /*
     * Asserted against a COUNT over `teammate`, not against a literal in this file:
     * a hard-coded 6 is a claim about the fixture, while this is a claim about the
     * query. The subtree is what the roster clamp covers, so someone parked on the
     * non-cost-owning child node below the centre is IN it.
     */
    const [placed] = [
      ...(await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM teammate
         WHERE is_active = TRUE
           AND org_unit_id IN (SELECT id FROM org_unit WHERE path <@ 'osc.main'::ltree AND region_id = ${region}::uuid)`),
    ]
    const d = await osc(ccMain)
    expect(d.rosterCount).toBe(Number(placed!.n))
    expect(d.rosterCount).toBe(MAIN.rosterCount)
  })

  it('a teammate whose ONLY usage is NULL-CoU Copilot reconciliation is on the card — and leads it', async () => {
    /*
     * THE case this primitive exists for. Mo's $450 sits in `unaccounted_usage`,
     * which carries `cost_owning_unit_id` NULL by construction (mig 0101/0113), so
     * the burn axis every other figure on this drill uses cannot see one cent of
     * it. A burn-anchored card omits the person with the most unallocated money.
     */
    const d = await osc(ccMain)
    const mo = byName(d, 'Mo')
    expect(mo).toBeDefined()
    expect(cents(mo!.unallocatedUsd)).toBe(cents(450))
    // He is the top row: sorted by unallocated descending.
    expect(d.over[0]!.teammate).toBe('Mo')

    // …and the burn genuinely cannot see him. Read back from the handler, so what
    // makes the burn-anchored version WRONG is a figure the code produced.
    const r = await drill(ccMain)
    expect(cents(r.burnUsd)).toBe(cents(MAIN.burnUsd))
    expect(cents(r.burnUsd)).not.toBe(cents(MAIN.burnUsd + 450))
  })

  it('the roster denominator is NOT the burn, and NEITHER contains the other', async () => {
    /*
     * Both figures come back from the same handler, so this compares two things the
     * code produced rather than a literal in this file. The burn is LARGER (it
     * carries the leaver's tagged $2,000) and simultaneously MISSES $450 the roster
     * has — so "the roster is a subset of the burn" and "the burn is a subset of the
     * roster" are both false, which is why the card names its own denominator
     * instead of rendering this figure under the burn headline.
     */
    const r = await drill(ccMain)
    expect(cents(r.overSoftCap.rosterUsd)).toBe(cents(MAIN.rosterUsd))
    expect(cents(r.burnUsd)).toBe(cents(MAIN.burnUsd))
    expect(cents(r.overSoftCap.rosterUsd)).not.toBe(cents(r.burnUsd))
    expect(r.burnUsd).toBeGreaterThan(r.overSoftCap.rosterUsd)
    // …yet the roster still holds $450 the burn cannot see (Mo's reconciled rows).
    expect(cents(r.overSoftCap.unallocatedUsd)).toBe(cents(MAIN.unallocatedUsd))
  })

  it('someone placed on a NON-cost-owning node BELOW the centre is on its roster', async () => {
    // Both placement doors are live and they differ: the bulk PLACE refuses a
    // non-cost-owning target, the per-row /admin/users move does not. Clamping to
    // `org_unit_id = ccId` would drop Ren — and his $300 with him.
    const d = await osc(ccMain)
    expect(byName(d, 'Ren')).toBeDefined()
    expect(cents(byName(d, 'Ren')!.unallocatedUsd)).toBe(cents(300))
  })

  it('a DEACTIVATED leaver is not on the roster, in the count OR in the money', async () => {
    /*
     * A roster is the people who are HERE — every row is someone to contact. Gus is
     * the largest spender in the fixture precisely so that admitting him would move
     * the count, rosterUsd, allocatedUsd, unallocatedUsd and the over-list at once.
     */
    const d = await osc(ccMain)
    expect(byName(d, 'Gus')).toBeUndefined()
    expect(d.rosterCount).toBe(MAIN.rosterCount)
    expect(d.rosterCount).not.toBe(MAIN.rosterCount + 1)
    expect(cents(d.rosterUsd)).toBe(cents(MAIN.rosterUsd))
    expect(cents(d.rosterUsd)).not.toBe(cents(MAIN.rosterUsd + 2900))
    expect(cents(d.unallocatedUsd)).not.toBe(cents(MAIN.unallocatedUsd + 900))
  })

  it('a cost centre that does not resolve clamps to NO ONE, never to the whole company', async () => {
    /*
     * The defensive branch, made reachable — an assertion that cannot fail
     * certifies nothing. The endpoint refuses an unknown cc before this runs, so
     * the two functions are driven directly. It matters because the wrong fallback
     * is not "empty": `wholeCompanyUsage` here would hand a cost-centre owner every
     * person in the company under their own centre's heading, which is exactly the
     * failure engine/scope.ts's discriminated union exists to make unreachable by
     * accident (so it must not be reachable deliberately either).
     *
     * Read back against the WHOLE company's roster from the same primitive, so what
     * makes the wrong fallback wrong is a figure the code produced: it is not empty.
     */
    const win = resolveReportWindow({ month: '2026-03' }, { now: new Date() })
    const ghost = await costCentreRosterScope(t.db, '00000000-0000-0000-0000-0000000000ff')
    const empty = await fetchOverSoftCap(t.db, ghost, win)
    expect(empty.rosterCount).toBe(0)
    expect(empty.over).toEqual([])
    expect(cents(empty.rosterUsd)).toBe(0)

    const everyone = await fetchOverSoftCap(t.db, { kind: 'whole-company', lane: 'usage' }, win)
    expect(everyone.rosterCount).toBeGreaterThan(0)
    expect(empty.rosterCount).not.toBe(everyone.rosterCount)
  })

  it('the clamp is THREADED — a sibling cost centre answers with its own roster', async () => {
    // One cost centre alone cannot tell "applied the clamp" from "returned
    // everything": every figure here differs from MAIN's.
    const d = await osc(ccOther)
    expect(d.rosterCount).toBe(1)
    expect(cents(d.rosterUsd)).toBe(cents(700))
    expect(d.over.map((r) => r.teammate)).toEqual(['Zed'])
    expect(d.rosterCount).not.toBe(MAIN.rosterCount)
    // His cost centre HAS a live project; he is not a member of it, so there is
    // still nothing for him to tag to. Membership decides the group, not proximity.
    expect(d.over[0]!.group).toBe('on-no-project')
    expect(d.over[0]!.projects).toBe(0)
  })

  it('spend either side of the window is outside the denominator', async () => {
    const d = await osc(ccMain)
    expect(cents(d.rosterUsd)).toBe(cents(MAIN.rosterUsd))
    expect(cents(d.rosterUsd)).not.toBe(cents(MAIN.rosterUsd + 5000))
    expect(cents(d.rosterUsd)).not.toBe(cents(MAIN.rosterUsd + 6000))
  })
})

describe('the two identities', () => {
  it('THE PARTITION: the groups are mutually exclusive AND exhaustive over the roster', async () => {
    for (const cc of [ccMain, ccOther]) {
      const d = await osc(cc)
      expect(d.over.length + d.withinAllowance.teammates).toBe(d.rosterCount)
      // Exclusive: nobody appears twice, and every row carries exactly one group.
      const ids = d.over.map((r) => r.teammateId)
      expect(new Set(ids).size).toBe(ids.length)
      for (const r of d.over) expect(['on-projects', 'on-no-project']).toContain(r.group)
    }
  })

  it('THE FOOTING: allocated + unallocated = rosterUsd, cent-exact, in the same lane', async () => {
    for (const cc of [ccMain, ccOther]) {
      const d = await osc(cc)
      expect(cents(d.allocatedUsd + d.unallocatedUsd)).toBe(cents(d.rosterUsd))
    }
    const d = await osc(ccMain)
    expect(cents(d.allocatedUsd)).toBe(cents(MAIN.allocatedUsd))
    expect(cents(d.unallocatedUsd)).toBe(cents(MAIN.unallocatedUsd))
  })

  it('the over-cap rows and the within-allowance line together account for every unallocated dollar', async () => {
    // The corollary of the partition, in money rather than in people — an over-cap
    // row silently dropped would still leave the counts consistent.
    const d = await osc(ccMain)
    const overUsd = d.over.reduce((a, r) => a + r.unallocatedUsd, 0)
    expect(cents(overUsd + d.withinAllowance.unallocatedUsd)).toBe(cents(d.unallocatedUsd))
    expect(cents(overUsd)).toBe(cents(MAIN.overUsd))
    expect(d.withinAllowance.teammates).toBe(MAIN.withinTeammates)
    expect(cents(d.withinAllowance.unallocatedUsd)).toBe(cents(MAIN.withinUnallocatedUsd))
  })

  it('FULLY ALLOCATED means spent-and-all-on-a-budget, never "spent nothing"', async () => {
    // Cy spent $220, all of it tagged. Nia spent $45, none of it. Counting a
    // zero-spend teammate would let an idle cost centre report a tagging success.
    const d = await osc(ccMain)
    expect(d.withinAllowance.fullyAllocated).toBe(MAIN.fullyAllocated)
  })
})

describe('which conversation the reader is handed', () => {
  it('over the cap WITH an active membership reads as a nudge', async () => {
    const d = await osc(ccMain)
    expect(byName(d, 'Vee')!.group).toBe('on-projects')
    expect(byName(d, 'Vee')!.projects).toBe(2)
    expect(byName(d, 'Mo')!.group).toBe('on-projects')
  })

  it('an ENDED project is NOT a budget to nudge toward — the same gate the write path applies', async () => {
    /*
     * Ren holds a LIVE assignment row of an ENDED project, and an EXPIRED assignment
     * row of a live one. Both gates must fire: dropping the `endedProjectExpr` half
     * OR the `effective @> now()` half moves him to `on-projects` with
     * `projects: 1` — a nudge to tag to a budget `tagUnaccountedTx` would 409.
     */
    const d = await osc(ccMain)
    const ren = byName(d, 'Ren')!
    expect(ren.group).toBe('on-no-project')
    expect(ren.projects).toBe(0)
  })

  it('no active membership at all reads as an allocation, not a nudge', async () => {
    const d = await osc(ccMain)
    expect(byName(d, 'Ida')!.group).toBe('on-no-project')
    expect(byName(d, 'Ida')!.projects).toBe(0)
  })
})

describe('the cap is the gate, and it is the product’s own policy', () => {
  it('THE RATE IS NOT A GATE: 88% tagged and still 2× the cap is on the list', async () => {
    /*
     * The defect two earlier drafts of this card shipped (a $250 materiality floor,
     * then a 60% tagging rate). Vee tags $1,600 of $1,800 — a rate any sane
     * threshold would clear him on — and still leaves twice the cap unallocated.
     */
    const d = await osc(ccMain)
    const vee = byName(d, 'Vee')!
    expect(cents(vee.unallocatedUsd)).toBe(cents(200))
    expect(vee.capMultiple).toBeCloseTo(2, 6)
    expect(vee.taggedRate).toBeCloseTo(1600 / 1800, 6)
    expect(vee.taggedRate).toBeGreaterThan(0.6) // a 60%-rate gate would have dropped him
  })

  it('EXACTLY at the cap is over it — the same `>=` the developer’s own page badges', async () => {
    /*
     * me-queries.ts computes `over_soft_cap: unallocCost >= baseAllowanceUsd`. A `>`
     * here would list Ida as within allowance while her own usage page badges her
     * Over, and neither reader could tell which surface was lying.
     */
    const d = await osc(ccMain)
    expect(d.softCapUsd).toBe(100)
    const ida = byName(d, 'Ida')!
    expect(cents(ida.unallocatedUsd)).toBe(cents(100))
    expect(ida.capMultiple).toBeCloseTo(1, 6)
  })

  it('under the cap is NOT on the list, however untidy the tagging', async () => {
    // Nia tags nothing at all — a 0% rate — and is still not a conversation,
    // because the cap is the only gate.
    const d = await osc(ccMain)
    expect(byName(d, 'Nia')).toBeUndefined()
    expect(byName(d, 'Cy')).toBeUndefined()
  })

  it('the cap follows NUXT_BASE_ALLOWANCE_USD — one global setting, read per request', async () => {
    /*
     * Raising the cap must move the list, or "the product's own policy" is a claim
     * the code does not honour. At $400 only Mo (450) remains; Vee/Ren/Ida fall into
     * within-allowance and the partition still holds.
     */
    const prev = process.env.NUXT_BASE_ALLOWANCE_USD
    try {
      process.env.NUXT_BASE_ALLOWANCE_USD = '400'
      const d = await osc(ccMain)
      expect(d.softCapUsd).toBe(400)
      expect(d.over.map((r) => r.teammate)).toEqual(['Mo'])
      expect(d.over.length + d.withinAllowance.teammates).toBe(d.rosterCount)
      expect(cents(d.rosterUsd)).toBe(cents(MAIN.rosterUsd)) // the money did not move
    } finally {
      process.env.NUXT_BASE_ALLOWANCE_USD = prev
    }
  })

  it('a $0 cap states no multiple, and never lists a $0 row', async () => {
    /*
     * `NUXT_BASE_ALLOWANCE_USD=0` is legal (base-allowance.ts keeps it, guard is
     * `>= 0`). With the shipped `>=` comparison alone EVERY roster member is "over"
     * $0 — a page of people to contact about nothing — so the zero-dollar guard
     * keeps a row on this card always naming money. `capMultiple` is null: there is
     * no multiple of zero, and both Infinity and a fabricated 0 would be false.
     */
    const prev = process.env.NUXT_BASE_ALLOWANCE_USD
    try {
      process.env.NUXT_BASE_ALLOWANCE_USD = '0'
      const d = await osc(ccMain)
      expect(d.softCapUsd).toBe(0)
      // Cy has $0 unallocated and must NOT be listed; everyone with money is.
      expect(byName(d, 'Cy')).toBeUndefined()
      expect(d.over.map((r) => r.teammate).sort()).toEqual(['Ida', 'Mo', 'Nia', 'Ren', 'Vee'])
      for (const r of d.over) {
        expect(r.capMultiple).toBeNull()
        expect(r.unallocatedUsd).toBeGreaterThan(0)
      }
      expect(d.over.length + d.withinAllowance.teammates).toBe(d.rosterCount)
    } finally {
      process.env.NUXT_BASE_ALLOWANCE_USD = prev
    }
  })
})

describe('the empty case, and the export', () => {
  it('a window with no consumption reports an EMPTY over-list over a REAL roster', async () => {
    /*
     * "All within allowance", never `$0`, is a rendering rule — what the primitive
     * owes it is the distinction: the roster is still there and still counted, so
     * the card can say "nobody, of N people" rather than implying a failed fetch.
     */
    const d = await osc(ccMain, 'month=2026-05')
    expect(d.over).toEqual([])
    expect(d.rosterCount).toBe(MAIN.rosterCount)
    expect(d.withinAllowance.teammates).toBe(MAIN.rosterCount)
    expect(cents(d.rosterUsd)).toBe(0)
    expect(d.withinAllowance.fullyAllocated).toBe(0) // spent nothing ≠ fully allocated
  })

  it('the CSV carries the six agreed columns, byte-identical to the card', async () => {
    const csv = (await exportHandler(
      ev(gfo(), `scope=cost-centre&report=over-soft-cap&cc=${ccMain}&month=2026-03`),
    )) as unknown as string
    const lines = csv.trim().split('\n')

    expect(lines[1]).toBe('teammate,unallocated_usd,cap_multiple,tagged_rate_pct,projects,group')
    // ONLY the over-cap rows are rows — the within-allowance line is a header
    // figure, not 2 more rows of people there is no conversation to have with.
    expect(lines.length).toBe(2 + MAIN.overCount)

    const d = await osc(ccMain)
    expect(lines[2]).toBe('Mo,450.00,4.5,0.0,1,on-projects')
    // The header names the card's OWN denominator, so the file cannot be read as a
    // slice of the burn.
    expect(lines[0]).toContain(`soft_cap_usd=${d.softCapUsd.toFixed(2)}`)
    expect(lines[0]).toContain(`roster=${d.rosterCount}`)
    expect(lines[0]).toContain(`roster_usd=${d.rosterUsd.toFixed(2)}`)
    expect(lines[0]).toContain(`within_allowance=${d.withinAllowance.teammates}`)

    // Byte-identical: every row is the JSON figure formatted, in the same order.
    expect(lines.slice(2)).toEqual(
      d.over.map((r) =>
        [
          r.teammate,
          r.unallocatedUsd.toFixed(2),
          r.capMultiple != null ? r.capMultiple.toFixed(1) : 'n/a',
          (r.taggedRate * 100).toFixed(1),
          String(r.projects),
          r.group,
        ].join(','),
      ),
    )
  })

  it('the export is gated by the SAME cost-centre resolution as the drill (anti-IDOR)', async () => {
    /*
     * Not a new grant: a caller who cannot drill the cc cannot export its roster.
     *
     * A MANAGER, deliberately — a developer holds `costCentre: false`
     * (shared/auth/report-visibility.ts) and would 403 at the scope gate before
     * `resolveCostCentreDrill` ran at all, so the assertion would pass without the
     * resource-anchored check ever being reached. This manager DOES hold the scope
     * and is refused because `osc.main` is not under their `osc.other` subtree and
     * they own no cou_owner row on it.
     */
    const outsider: Session = {
      ...gfo(),
      role: 'manager',
      orgPath: 'osc.other',
      teammateId: '00000000-0000-0000-0000-00000000000c',
    } as Session
    await expect(
      exportHandler(ev(outsider, `scope=cost-centre&report=over-soft-cap&cc=${ccMain}&month=2026-03`)),
    ).rejects.toMatchObject({ statusCode: 403 })
    // …and the same caller CAN reach the cost centre they are actually in, so the
    // refusal above is the resource check and not a blanket denial.
    const ok = (await exportHandler(
      ev(outsider, `scope=cost-centre&report=over-soft-cap&cc=${ccOther}&month=2026-03`),
    )) as unknown as string
    expect(ok).toContain('Zed')
  })
})

/* ── THE DRILL FACTS RIDE THE ROW (D34, r5-H1) ──────────────────────────────── */

describe('the drill contract: this card carries its own admission facts', () => {
  /*
   * ── THE DEFECT ────────────────────────────────────────────────────────────
   * This card returned a name and an amount and NOTHING about the identity
   * behind it. `CcOverSoftCap.vue` therefore hard-coded `isActive: true` (citing
   * the roster CTE's `WHERE t.is_active = TRUE`) and never considered
   * `provisional` at all — so a PROVISIONAL SHADOW, which is `is_active = true`
   * by construction (mig 0057: an unauthenticated enrol claiming someone else's
   * email), satisfied every conjunct the client could evaluate and rendered as a
   * live link onto a page that 403s.
   *
   * Both facts now come off the row, from the ONE shared producer
   * (`server/reporting/teammate-drill-facts.ts`).
   *
   * MUTATION: delete `${TEAMMATE_DRILL_FACTS}` from the roster CTE in
   * `server/reporting/engine/over-soft-cap.ts` (or drop the two columns from the
   * outer SELECT) — both tests below go red, the first because `isProvisional`
   * comes back `false` for the shadow.
   */
  const win = () => resolveReportWindow({ month: '2026-03' }, { now: new Date() })

  it('every confirmed roster row states BOTH facts — never absent, never inferred', async () => {
    const d = await fetchOverSoftCap(t.db, await costCentreRosterScope(t.db, ccMain), win())
    expect(d.over.length).toBe(MAIN.overCount)
    for (const r of d.over) {
      // Present as booleans, not `undefined`: an absent fact reaches the client
      // as `undefined`, and `undefined` is what ADMITTED the drill before.
      expect(typeof r.isActive, `isActive on ${r.teammate}`).toBe('boolean')
      expect(typeof r.isProvisional, `isProvisional on ${r.teammate}`).toBe('boolean')
      expect(r.isActive).toBe(true) // the roster is the people who are HERE
      expect(r.isProvisional).toBe(false)
    }
  })

  it('a PROVISIONAL shadow on the roster is listed, and says so', async () => {
    /*
     * Ida is flipped to `provisional` for this test only. She stays on the card —
     * `over.length + withinAllowance.teammates = rosterCount` is an identity this
     * primitive publishes, so dropping a subject to close a door would break the
     * arithmetic instead. What changes is the FACT the row carries, and the card
     * renders her as plain text off it (see the component sibling).
     */
    await t.client`UPDATE teammate SET provisional = true WHERE email = 'Ida@osc.test'`
    try {
      const d = await fetchOverSoftCap(t.db, await costCentreRosterScope(t.db, ccMain), win())
      // The population and the money are UNCHANGED — this is a door, not a filter.
      expect(d.rosterCount).toBe(MAIN.rosterCount)
      expect(cents(d.rosterUsd)).toBe(cents(MAIN.rosterUsd))
      expect(d.over.length).toBe(MAIN.overCount)

      const ida = byName(d, 'Ida')!
      expect(ida).toBeTruthy()
      expect(ida.isProvisional).toBe(true)
      expect(ida.isActive).toBe(true) // a shadow IS active — that is the whole trap
      // …and nobody else is dragged along with her.
      expect(byName(d, 'Vee')!.isProvisional).toBe(false)
      expect(byName(d, 'Mo')!.isProvisional).toBe(false)
    } finally {
      await t.client`UPDATE teammate SET provisional = false WHERE email = 'Ida@osc.test'`
    }
  })
})
