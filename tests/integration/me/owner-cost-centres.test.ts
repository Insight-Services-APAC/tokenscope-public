// @vitest-environment node
/*
 * GET /api/v1/me/cost-centres — the P&L-owner card, WINDOWED.
 *
 * This payload is the Cost-Centre reporting scope's primary table (its own page
 * was deleted at the reporting cutover and nothing consumed it but a nav count
 * probe). That scope carries a period control, so the card has to answer for the
 * period it is asked for: a June column that quietly reported July-to-date under
 * a header saying June is a wrong number, not a stale one.
 *
 * What is pinned here:
 *   - no params  → month to date, byte-identical to the pre-window behaviour;
 *   - month=past → that month's OWN spend, and no exhaustion projection (a month
 *     that has finished cannot run out of budget in the future);
 *   - the window NEVER reaches past `now` — the current month excludes a
 *     future-dated row that a whole-calendar-month window would have counted;
 *   - the EFFECTIVE window is published, so a label cannot promise a period the
 *     figures do not cover;
 *   - allocation stays current-effective (a budget is a live fact, not a
 *     re-windowed one) while the burn moves with the window;
 *   - the RECONCILIATION closes over all three arms of the §A lane, with a
 *     cross-centre row — every term at a distinct amount, so no two can swap;
 *   - the project list is RANKED and BOUNDED, and what it holds back is named.
 *
 * ── THE THREE CENTRES, AND WHY THERE ARE THREE ───────────────────────────────
 * Each fixture answers one question and cannot disturb the others:
 *   W — the WINDOW tests. One project, one arm, every dollar tagged and homed
 *       alike, so a window assertion can never pass for an arm-shaped reason.
 *   X — the RECONCILIATION. All three arms plus a cross-centre emit, at seven
 *       distinct amounts.
 *   Z — the RANKING. 27 projects, one of them ended and silent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler, { OWNER_PROJECT_ROW_CAP } from '../../../server/api/v1/me/cost-centres.get'

let t: TestDb
let regionId = ''
let ccId = ''
let ccX = ''
let ccF = '' // a cost centre the owner does NOT own — hosts the foreign project
let ccZ = ''
let ownerId = ''
let philId = ''
let projId = ''
let projX = ''
let projF = ''

/*
 * Every date below is DERIVED from the run clock, never written literally — this
 * suite must behave identically on the 1st and on the 31st. (It was written with
 * a hard-coded "+36h is still this month" assumption and first ran at 14:16Z on a
 * month-end, which put the probe row in the NEXT month and made two assertions
 * pass for the wrong reason.)
 */
const now = new Date()
const currentMonth = now.toISOString().slice(0, 7)
const monthStartIso = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
).toISOString()
const nextMonthStartIso = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
).toISOString()
/**
 * Strictly AFTER `now` and strictly INSIDE this calendar month — the row that a
 * whole-calendar-month window would wrongly count as already spent. An hour of
 * slack clears the handler's own (later) `new Date()`; on a month-end run it is
 * pinned just short of the boundary so it stays inside the month.
 */
const futureThisMonthIso = new Date(
  Math.min(now.getTime() + 3_600_000, Date.parse(nextMonthStartIso) - 1_000),
).toISOString()
const prevMonth = (() => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  return d.toISOString().slice(0, 7)
})()
const prevMonthDayIso = `${prevMonth}-05T00:00:00.000Z`
/** A `to` bound in the future but inside the endpoint's max range span. */
const futureToDate = new Date(now.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
const monthStartDate = monthStartIso.slice(0, 10)
const todayDate = now.toISOString().slice(0, 10)

const ev = (session: Session, query = '') => {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, string> = { host: 'localhost:3450' }
  const e = {
    method: 'GET',
    path: url,
    context: { params: {} },
    node: {
      req: { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof handler>[0]
}

const ownerSession = (): Session =>
  ({
    teammateId: ownerId,
    email: 'owner@a.test',
    displayName: 'Owner',
    role: 'developer',
    regionId,
    orgPath: 'a',
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

interface ProjectRow {
  code: string
  mtd_cost_usd: string
  allocation_usd: string
  utilisation: number | null
  projected_exhaustion_date: string | null
  velocity: { current_week_usd: string; is_flagged: boolean } | null
}
interface CardRow {
  code: string
  project_count: number
  mtd_cost_usd: string
  allocation_usd: string
  reconciliation: {
    burn_usd: string
    ingest_only_usd: string
    untagged_usd: string
    foreign_project_usd: string
    off_centre_usd: string
    member_untagged_usd: string
  }
  omitted_projects: { count: number; cost_usd: string; dormant_count: number }
  projects: ProjectRow[]
}
interface Resp {
  cost_centres: CardRow[]
  total: number
  window: { from: string; to: string; month: string | null; runs_to_now: boolean }
}

const call = async (query = ''): Promise<Resp> =>
  (await handler(ev(ownerSession(), query))) as unknown as Resp
const cc = (r: Resp, code: string) => r.cost_centres.find((c) => c.code === code)!
const proj = (r: Resp) => cc(r, 'w').projects.find((p) => p.code === 'PROJ-W')!

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  await t.client`INSERT INTO region (code, display_name) VALUES ('rw', 'Region W')`
  ;[{ id: regionId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code='rw'`

  const mkUnit = async (path: string, code: string, name: string) => {
    await t.client`INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${regionId}::uuid, ${path}::ltree, ${code}, ${name}, 'bu', true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code=${code}`
    return r!.id
  }
  ccId = await mkUnit('w', 'w', 'Practice W')
  ccX = await mkUnit('x', 'x', 'Practice X')
  ccF = await mkUnit('f', 'f', 'Practice F')
  ccZ = await mkUnit('z', 'z', 'Practice Z')

  const mkTeammate = async (email: string, name: string, homeCou: string) => {
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
      VALUES ('oid-'||${email}, ${email}, ${name}, ${regionId}::uuid, ${homeCou}::uuid, true)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE email=${email}`
    return r!.id
  }
  ownerId = await mkTeammate('owner@a.test', 'Owner', ccId)
  // Phil's HOME cost centre is X — the axis `member_untagged_usd` is measured on.
  philId = await mkTeammate('phil@a.test', 'Phil', ccX)

  // The owner owns W, X and Z. F is deliberately NOT owned: it only exists to
  // lead a project that X's people spend on.
  for (const id of [ccId, ccX, ccZ]) {
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id) VALUES (${id}::uuid, ${ownerId}::uuid)`
  }

  const mkProject = async (code: string, name: string, cou: string, endDate: string | null = null) => {
    await t.client`INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id, end_date)
      VALUES (${code}, 'hash-'||${code}, ${name}, 'billable', ${regionId}::uuid, ${cou}::uuid, ${endDate}::timestamptz)`
    const [r] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM project WHERE code=${code}`
    return r!.id
  }
  projId = await mkProject('PROJ-W', 'Project W', ccId)
  projX = await mkProject('PROJ-X', 'Project X', ccX)
  projF = await mkProject('PROJ-F', 'Project F', ccF)

  await t.client`INSERT INTO audit_event (event_type, actor_system, payload) VALUES ('seed', 'test', '{}'::jsonb)`
  const [{ id: auditId }] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM audit_event ORDER BY ts_recorded DESC LIMIT 1`
  /*
   * Current-effective allocation: 20. Deliberately NOT re-windowed by the period
   * — a budget is a live fact about the project, not a per-month slice.
   *
   * Deliberately BELOW both windows' burn, so `exhaustionDate` takes its
   * already-exhausted branch and returns a date on ANY run day. A round number
   * that only exhausts early in the month would make the "a past month projects
   * nothing" assertion pass by arithmetic on the 28th and by the rule being
   * tested on the 3rd — i.e. sometimes for the wrong reason.
   */
  await t.client`INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projId}::uuid, 20.00, tstzrange('2020-01-01', NULL, '[)'), 'baseline', ${auditId}::uuid)`

  const mkInstance = async (teammateId: string, cou: string) => {
    await t.client`INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
      VALUES (gen_random_uuid(), 'p', ${teammateId}::uuid, 'claude-code', ${regionId}::uuid, ${cou}::uuid, 'h', 'P')`
    const [r] = await t.client<{ id: string }[]>`SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${teammateId}::uuid LIMIT 1`
    return r!.id
  }
  const instId = await mkInstance(ownerId, ccId)
  const philInst = await mkInstance(philId, ccX)

  /** Arm 1 (otel-emitted): a real cost-owning unit AND (optionally) a project. */
  const ar = async (
    cost: number,
    tsIso: string,
    key: string,
    opts: { inst?: string; tm?: string; cou?: string | null; project?: string | null } = {},
  ) => {
    const inst = opts.inst ?? instId
    const tm = opts.tm ?? ownerId
    const cou = opts.cou === undefined ? ccId : opts.cou
    const project = opts.project === undefined ? projId : opts.project
    await t.client`INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
      VALUES (${inst}::uuid, ${tm}::uuid, ${regionId}::uuid, ${ccId}::uuid, ${cou}::uuid, ${project}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${cost}, 'tier-1', 'estimated', ${tsIso}::timestamptz, ${key})`
  }
  // ── W: the window fixture ────────────────────────────────────────────────
  // 30 in the current month so far; 70 in the previous month; 5 dated LATER THIS
  // MONTH but after `now` (the open-upper-bound probe).
  await ar(30, monthStartIso, 'conv-mtd')
  await ar(70, prevMonthDayIso, 'conv-prev')
  await ar(5, futureThisMonthIso, 'conv-future')

  /*
   * ── X: EVERY reconciliation term, at a DISTINCT amount ────────────────────
   * The identity the card publishes is
   *   Σ projects + ingest_only + untagged + foreign_project − off_centre = burn
   * and it can only be checked if every term is (a) present and (b) unique — a
   * fixture where two terms share an amount lets them swap unnoticed, and a
   * fixture with only arm-1 money (the shape this suite shipped with) makes every
   * term zero, so a query that dropped one of them still passed.
   *
   *   11  arm 1  emitted, homed X, tagged X's own project   → burn + project row
   *   13  arm 3  ingest-only, homed X, untaggable           → burn + ingest_only
   *   17  arm 1  homed X, NO project claim                  → burn + untagged
   *   19  arm 1  homed X, tagged a project F leads          → burn + foreign_project
   *   23  arm 2  reconciled: project X, NO cost-owning unit → project row − off_centre
   *   29  arm 1  homed F, tagged X's project (cross-centre) → project row − off_centre
   *   31  arm 1  no project AND no home, by Phil (home X)   → member_untagged only
   */
  await ar(11, monthStartIso, 'x-arm1', { inst: philInst, tm: philId, cou: ccX, project: projX })
  await ar(17, monthStartIso, 'x-untagged', { inst: philInst, tm: philId, cou: ccX, project: null })
  await ar(19, monthStartIso, 'x-foreign', { inst: philInst, tm: philId, cou: ccX, project: projF })
  await ar(29, monthStartIso, 'x-cross', { inst: philInst, tm: philId, cou: ccF, project: projX })
  await ar(31, monthStartIso, 'x-member', { inst: philInst, tm: philId, cou: null, project: null })
  // Arm 2 — the API−OTel gap. `cost_owning_unit_id` is NULL by construction on
  // this arm (the view hard-codes it), so a real project claim lands with no burn
  // home at all. At today's adoption most consumption arrives this way.
  await t.client`INSERT INTO unaccounted_usage (teammate_id, region_id, org_unit_id, day, tool, cost_usd, tokens, source, project_id)
    VALUES (${philId}::uuid, ${regionId}::uuid, ${ccX}::uuid, ${monthStartIso}::date, 'claude-code', 23, 0, 'api-reconciled', ${projX}::uuid)`
  // Arm 3 — the ingest-only lane: a real emit home, and untaggable by construction.
  await t.client`INSERT INTO actual_spend
      (teammate_id, date, tool, input_tokens, output_tokens, cost_usd, source, chargeback_exempt,
       region_id, org_unit_id, cost_owning_unit_id, dimension_source)
    VALUES (${philId}::uuid, ${monthStartIso}::date, 'claude-ai', 100, 100, 13, 'anthropic-analytics-api', false,
       ${regionId}::uuid, ${ccX}::uuid, ${ccX}::uuid, 'ingest-snapshot')`

  /*
   * ── Z: 27 projects — 26 spending (1..26) and one ENDED with nothing ────────
   * Ranking + the cap + the dormant hold-back, in one fixture. The burns are
   * distinct so "which 25 survived" is checkable, and the smallest ($1) is the
   * one the cap must drop.
   */
  for (let i = 1; i <= 26; i++) {
    const code = `PROJ-Z${String(i).padStart(2, '0')}`
    const id = await mkProject(code, `Z Project ${i}`, ccZ)
    await ar(i, monthStartIso, `z-${i}`, { cou: ccZ, project: id })
  }
  await mkProject('PROJ-ZDEAD', 'Z Finished', ccZ, '2020-06-01T00:00:00.000Z')
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('/me/cost-centres — the owner payload a browser can now ask for', () => {
  it('serves the owner their centres, their projects, and the burn reconciliation', async () => {
    const r = await call()
    expect(r.total).toBe(3)
    expect(r.cost_centres.map((c) => c.code)).toEqual(['w', 'x', 'z'])
    expect(cc(r, 'w').projects.map((p) => p.code)).toEqual(['PROJ-W'])
    // W's card adds up trivially: every dollar in it is tagged and homed alike.
    expect(cc(r, 'w').mtd_cost_usd).toBe('30.00')
    expect(Number(cc(r, 'w').reconciliation.burn_usd)).toBe(30)
  })

  it('a non-owner gets an empty list, not a 403 — ownership is a relationship', async () => {
    const stranger = { ...ownerSession(), teammateId: '11111111-1111-4111-8111-111111111111' } as Session
    const r = (await handler(ev(stranger))) as unknown as Resp
    expect(r.cost_centres).toEqual([])
    expect(r.total).toBe(0)
  })
})

describe('/me/cost-centres — the reconciliation closes over all three arms', () => {
  /*
   * X carries 11 (arm 1) + 13 (arm 3) + 17 (untagged) + 19 (foreign project)
   * homed to it, and its project carries 11 + 23 (arm 2) + 29 (cross-centre emit).
   */
  it('publishes every term, each at its own amount', async () => {
    const x = cc(await call(), 'x')
    const r = x.reconciliation
    expect(Number(r.burn_usd)).toBe(11 + 13 + 17 + 19) // 60 — the usage-row clamp
    expect(Number(r.ingest_only_usd)).toBe(13)
    expect(Number(r.untagged_usd)).toBe(17)
    expect(Number(r.foreign_project_usd)).toBe(19)
    // BOTH halves of off-centre: the reconciled row with no home (23) AND the row
    // emitted under ANOTHER cost centre (29). A term that only carried the first
    // would read 23 here — which is why the label says "homed elsewhere", not
    // "reconciled usage with no emit home".
    expect(Number(r.off_centre_usd)).toBe(23 + 29) // 52
    // Measured on the TEAMMATE axis and OUTSIDE the identity: Phil's home is X.
    expect(Number(r.member_untagged_usd)).toBe(31)
  })

  it('Σ projects is the PROJECT clamp — arm 2 and a cross-centre emit are in it', async () => {
    const x = cc(await call(), 'x')
    // 11 emitted + 23 reconciled + 29 cross-centre = 63, against a 60 burn.
    expect(x.mtd_cost_usd).toBe('63.00')
    expect(x.projects.find((p) => p.code === 'PROJ-X')!.mtd_cost_usd).toBe('63.00')
    // F's project is NOT in X's list even though X's people spent 19 on it.
    expect(x.projects.map((p) => p.code)).toEqual(['PROJ-X'])
  })

  it('the identity actually CLOSES — Σ projects + terms = the centre’s own burn', async () => {
    const x = cc(await call(), 'x')
    const r = x.reconciliation
    const lhs =
      Number(x.mtd_cost_usd) +
      Number(r.ingest_only_usd) +
      Number(r.untagged_usd) +
      Number(r.foreign_project_usd) -
      Number(r.off_centre_usd)
    expect(lhs).toBeCloseTo(Number(r.burn_usd), 6)
    // …and it is not closing on zeroes: every term moves the number.
    expect(63 + 13 + 17 + 19 - 52).toBe(60)
    // The teammate-axis term is NOT in the identity — folding it in would break it.
    expect(lhs + Number(r.member_untagged_usd)).not.toBeCloseTo(Number(r.burn_usd), 6)
  })
})

describe('/me/cost-centres — the window is a param, and never open-ended', () => {
  it('with NO params: month to date — a row dated LATER THIS MONTH is excluded', async () => {
    const p = proj(await call())
    // 30 so far. The 5 is inside the CALENDAR month and outside month-to-date;
    // counting it would make "burn" mean "burn plus whatever the month holds".
    expect(p.mtd_cost_usd).toBe('30.00')
    // …and the excluded row IS on the lane, tagged to this project — so its
    // absence is the window doing its job, not the fixture failing to produce it.
    // (A whole-calendar-month window would return 35 here and call it "burn".)
    const [{ total }] = await t.client<{ total: string }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM v_complete_usage
      WHERE project_id = ${projId}::uuid
        AND ts_event >= ${monthStartIso}::timestamptz
        AND ts_event <  ${nextMonthStartIso}::timestamptz`
    expect(Number(total)).toBe(35)
  })

  it('the current month asked for BY NAME is the same month-to-date figure', async () => {
    expect(proj(await call(`month=${currentMonth}`)).mtd_cost_usd).toBe('30.00')
  })

  it('a PAST month reports that month’s own spend, not month-to-date', async () => {
    const p = proj(await call(`month=${prevMonth}`))
    expect(p.mtd_cost_usd).toBe('70.00')
    expect(p.utilisation).toBe(3.5) // 70 against the live 20 allocation
  })

  it('a custom range windows the burn while the ALLOCATION stays current-effective', async () => {
    const p = proj(await call(`from=${prevMonth}-01&to=${prevMonth}-28`))
    expect(p.mtd_cost_usd).toBe('70.00')
    expect(p.allocation_usd).toBe('20.00') // never re-windowed
  })

  it('a range reaching into the future is CLAMPED at now, not left open', async () => {
    const p = proj(await call(`from=${monthStartDate}&to=${futureToDate}`))
    expect(p.mtd_cost_usd).toBe('30.00') // the later-today row is still excluded
  })

  it('the nav count probe still answers without the P&L aggregation', async () => {
    const r = await call('count=1')
    expect(r.cost_centres).toEqual([])
    expect(r.total).toBe(3)
  })

  it('a malformed period is THIS project’s problem document, naming the field', async () => {
    // h3's own getValidatedQuery throws the raw ZodError, which the app surfaces
    // as a bare "Validation Error" with no `type` and no field — the repository
    // has a helper precisely so a 400 tells the caller which param and which rule.
    await expect(call('month=nope')).rejects.toMatchObject({
      statusCode: 400,
      data: {
        type: 'https://tokenscope.example.com/errors/validation',
        status: 400,
        detail: expect.stringContaining('month'),
      },
    })
  })
})

describe('/me/cost-centres — the EFFECTIVE window is published, not the requested one', () => {
  it('a clamped range reports the day it actually stops at', async () => {
    // The caller asked to `futureToDate`; the answer stops at today. A label built
    // from the request would promise ten days the figures do not cover.
    const r = await call(`from=${monthStartDate}&to=${futureToDate}`)
    expect(r.window.from).toBe(monthStartDate)
    expect(r.window.to).toBe(todayDate)
    expect(r.window.to).not.toBe(futureToDate)
    expect(r.window.runs_to_now).toBe(true)
  })

  it('a completed month names itself, and its `to` is the month’s LAST day', async () => {
    const r = await call(`month=${prevMonth}`)
    expect(r.window.month).toBe(prevMonth)
    expect(r.window.from).toBe(`${prevMonth}-01`)
    // Inclusive, so it is the last day of the month — never the 1st of the next.
    expect(r.window.to.slice(0, 7)).toBe(prevMonth)
    expect(r.window.to).toBe(new Date(Date.parse(monthStartIso) - 1).toISOString().slice(0, 10))
    expect(r.window.runs_to_now).toBe(false)
  })

  it('month-to-date is NOT a whole calendar month, and does not claim to be', async () => {
    const r = await call()
    expect(r.window.month).toBeNull() // ⇒ the client labels it "… to date"
    expect(r.window.from).toBe(monthStartDate)
    expect(r.window.runs_to_now).toBe(true)
  })
})

describe('/me/cost-centres — a forward-looking figure needs the window that licenses it', () => {
  it('a past month carries NO exhaustion projection — it cannot run out in the future', async () => {
    // Both windows are OVER their allocation, so the projection is a date on any
    // run day and the null below can only come from the window rule — not from a
    // burn that happens to be too slow to exhaust in the days remaining.
    expect(proj(await call()).projected_exhaustion_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(proj(await call(`month=${prevMonth}`)).mtd_cost_usd).toBe('70.00')
    expect(proj(await call(`month=${prevMonth}`)).projected_exhaustion_date).toBeNull()
  })

  it('a range that IS this month-to-date still projects — the arithmetic fits it', async () => {
    const live = proj(await call(`from=${monthStartDate}&to=${futureToDate}`))
    expect(live.projected_exhaustion_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a LONGER range running to now does NOT project — the divisor would be wrong', async () => {
    /*
     * The projection divides spend by the DAY OF THE MONTH (usage/projections.ts).
     * Over a window that starts before this month, that treats two months of burn
     * as one month's daily rate and prints a confidently wrong date. The gate is
     * "is this a current-month month-to-date window", not "does it reach now".
     */
    const p = proj(await call(`from=${prevMonth}-01&to=${futureToDate}`))
    // The window is real and running — it just is not month-to-date.
    expect(Number(p.mtd_cost_usd)).toBe(100) // 70 last month + 30 this month
    expect(p.projected_exhaustion_date).toBeNull()
  })

  it('velocity is a LIVE rate: present while the window runs to now, absent when it does not', async () => {
    // consumption.ts keys the weeks off the CLOCK, never off the requested period,
    // so on a June table "this week" describes a different period from every other
    // figure on the row. Absent, not a $0.00 that reads as a quiet week.
    expect(proj(await call()).velocity).not.toBeNull()
    expect(proj(await call(`from=${monthStartDate}&to=${futureToDate}`)).velocity).not.toBeNull()
    expect(proj(await call(`month=${prevMonth}`)).velocity).toBeNull()
    expect(proj(await call(`from=${prevMonth}-01&to=${prevMonth}-28`)).velocity).toBeNull()
  })
})

describe('/me/cost-centres — the project list is ranked, bounded, and honest about it', () => {
  it('returns the top page by BURN, capped, with the rest named', async () => {
    const z = cc(await call(), 'z')
    expect(z.projects.length).toBe(OWNER_PROJECT_ROW_CAP) // 25 of 27
    // Ranked by burn desc: the 26 spenders are $1..$26, so the page is 26 down to 2.
    expect(z.projects[0]!.mtd_cost_usd).toBe('26.00')
    expect(z.projects.at(-1)!.mtd_cost_usd).toBe('2.00')
    // project_count is still the TRUTH about the centre, not the page size.
    expect(z.project_count).toBe(27)
    // Held back: the $1 project (ranked out) and the ended-with-nothing one.
    expect(z.omitted_projects.count).toBe(2)
    expect(z.omitted_projects.cost_usd).toBe('1.00')
    expect(z.omitted_projects.dormant_count).toBe(1)
    expect(z.projects.some((p) => p.code === 'PROJ-ZDEAD')).toBe(false)
  })

  it('the roll-up still counts what the page does not show', async () => {
    const z = cc(await call(), 'z')
    const shown = z.projects.reduce((s, p) => s + Number(p.mtd_cost_usd), 0)
    // Σ 1..26 = 351. The header is the whole centre; the rows are 350 of it.
    expect(Number(z.mtd_cost_usd)).toBe(351)
    expect(shown + Number(z.omitted_projects.cost_usd)).toBeCloseTo(Number(z.mtd_cost_usd), 6)
    // …and the burn reconciliation is computed on the WHOLE set, so it still closes.
    expect(Number(z.reconciliation.burn_usd)).toBe(351)
  })

  it('a centre with nothing held back says so with zeroes, not with silence', async () => {
    const w = cc(await call(), 'w')
    expect(w.omitted_projects).toEqual({ count: 0, cost_usd: '0.00', dormant_count: 0 })
  })
})
