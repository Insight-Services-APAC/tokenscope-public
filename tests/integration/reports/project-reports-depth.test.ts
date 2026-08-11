// @vitest-environment node
/*
 * GET /api/v1/reports/project/{code} — the PROJECT at reports depth
 * (developer pages build W4 D37/D38, prototype `:726-767`).
 *
 * The brief sketched a third admission arm on `requireProjectMembership`; the
 * build design refused it, and this suite is the proof that the refusal costs
 * nothing: a non-member with a grant gets depth, `me/*` keeps its 404 posture
 * unchanged, and neither endpoint is an existence oracle for the other.
 *
 * T34 C3 footing (named rows + ONE remainder = the project total over ALL
 * members) · T35 no probing oracle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import { seedKnownOutcomeCompany, type KnownOutcomeIds } from '../helpers/known-outcome-fixture'
import { resetReportCache, reportCacheStats } from '../../../server/reporting/report-cache'
import type { Session } from '../../../server/utils/auth'

import projectReport from '../../../server/api/v1/reports/project/[code].get'
import meProject from '../../../server/api/v1/me/projects/[code]/index.get'
import teammateReport from '../../../server/api/v1/reports/teammate/[id]/index.get'

/*
 * ── THE ONE SEAM THIS SUITE MOCKS, AND WHY (r4-M3) ──────────────────────────
 * A DATABASE failure inside `resolveDrillScope` is not reachable from a fixture:
 * every predicate it runs is over tables this suite needs intact. So the seam
 * itself is faulted, for the ONE assertion that needs it and no others — with
 * `drillFault.err` unset the REAL resolver runs, so every other test in this
 * file (including the frame-resolution ones below) is untouched.
 *
 * `vi.mock` is hoisted above the imports either way; `vi.hoisted` is what lets
 * the fault flag exist by the time the factory runs.
 */
const drillFault = vi.hoisted(() => ({ err: null as unknown }))
vi.mock('../../../server/reporting/teammate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/reporting/teammate')>()
  return {
    ...actual,
    resolveDrillScope: async (...args: Parameters<typeof actual.resolveDrillScope>) => {
      if (drillFault.err) throw drillFault.err
      return actual.resolveDrillScope(...args)
    },
  }
})

let t: TestDb
let ids: KnownOutcomeIds
let ccOwner = ''
let plainDev = ''
/** The unauthenticated-enrol SHADOW: active, named, and unconfirmed (r3-H2). */
let shadow = ''

interface NamedRow {
  teammate_id: string
  display_name: string
  cost_usd: string
  is_active: boolean
  can_drill: boolean
}
interface ProjectBody {
  budget: { window_cost_usd: string; allocation_usd: string; burn_per_day_usd: string }
  mix: { by_model: { cost_usd: string }[] }
  contribution: {
    named: NamedRow[]
    remainder: { members: number; label: string; cost_usd: string }
    rows_total_usd: string
  }
  admitted_by: string
  /** The carried frame, echoed verbatim — a decoration, never a gate (r5-M1). */
  scope: { src: string | null }
}

const read = (session: Session, query: string, code = 'PROJ-DELIVERYX') =>
  projectReport(ev(session, query, { code })) as unknown as Promise<ProjectBody>
const namesOf = (b: ProjectBody) => b.contribution.named.map((r) => r.display_name).sort()
const rowFor = (b: ProjectBody, name: string) =>
  b.contribution.named.find((r) => r.display_name === name)

const MONTH = 'month=2026-05'

function ev(session: Session, query: string, params: Record<string, string>) {
  const url = '/x' + (query ? `?${query}` : '')
  const headers: Record<string, unknown> = {}
  const e = {
    method: 'GET',
    path: url,
    context: { params },
    node: {
      req: {
        method: 'GET',
        url,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { host: 'localhost:3450', origin: 'http://localhost:3450' }
        },
      },
      res: {
        statusCode: 200,
        getHeader(k: string) {
          return headers[k.toLowerCase()]
        },
        setHeader(k: string, v: unknown) {
          headers[k.toLowerCase()] = v
        },
        removeHeader(k: string) {
          headers[k.toLowerCase()] = undefined
        },
        appendHeader() {},
        get headersSent() {
          return false
        },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], session)
  return e as unknown as Parameters<typeof projectReport>[0]
}

const sess = (teammateId: string, role: string, orgPath: string): Session =>
  ({
    teammateId,
    email: 'v@ko.test',
    displayName: 'V',
    role,
    regionId: ids.regionApac,
    orgPath,
    issuedAt: new Date().toISOString(),
  }) as unknown as Session

/** Owns apac.delivery — `project: 'member-in-scope'`, `teammate: 'people-scope'`. */
const ownerSess = () => sess(ccOwner, 'developer', 'apac.delivery')
/** No ownership — `project: 'membership'`: reports depth is not theirs. */
const plainSess = () => sess(plainDev, 'developer', 'apac.cto')
/** A platform-admin — holds `across`, so the whole-company FRAME resolves. */
const adminSess = () => sess(ccOwner, 'platform-admin', 'apac.delivery')

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  ids = await seedKnownOutcomeCompany(t)
  resetReportCache()

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-pdowner', 'pdowner@ko.test', 'PD Owner', ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid, true)`
  const [o] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE email='pdowner@ko.test'`
  ccOwner = o!.id
  // Ownership of apac.delivery: PROJ-DELIVERYX's lead cost centre, whose members
  // are alice and bob. The owner is NOT a member of the project — that is the
  // whole point of this depth.
  await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
    VALUES (${ids.uApacDelivery}::uuid, ${ccOwner}::uuid)`
  // Membership rows so the project HAS members in the owner's people-scope.
  const assign = async (tm: string, project: string) => {
    await t.client`INSERT INTO project_assignment (project_id, teammate_id, role, effective)
      VALUES (${project}::uuid, ${tm}::uuid, 'member', tstzrange('2020-01-01', NULL, '[)'))`
  }
  await assign(ids.alice, ids.projDeliveryx)
  await assign(ids.bob, ids.projDeliveryx)

  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES ('oid-pd2', 'pd2@ko.test', 'Plain', ${ids.regionApac}::uuid, ${ids.uApacCto}::uuid, true)`
  const [p] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE email='pd2@ko.test'`
  plainDev = p!.id

  /*
   * ── THE PROVISIONAL SHADOW (r3-H2) ────────────────────────────────────────
   * An unauthenticated enrol claiming `victim@ko.test` mints an ACTIVE teammate
   * whose email nobody has authenticated (mig 0057), and its emissions are
   * stamped `identity_state='provisional'`. It is placed INSIDE the owner's
   * people scope and made a member of the very project this suite foots, which
   * is the worst case for both defects at once: the headline already dropped
   * its $20 (`excludeProvisional`) while the contribution rows counted AND named
   * it, so C3 read $550 headline over $570 of rows under a victim's name.
   *
   * It lives in the shared fixture on purpose — T34's sum-back is the test that
   * SHOULD have caught this, and it only can if the fixture contains the state.
   */
  await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, is_active, provisional)
    VALUES ('provisional:shadow-1', 'victim@ko.test', 'Victim Claimed',
            ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid, true, true)`
  const [s] = await t.client<
    { id: string }[]
  >`SELECT id::text AS id FROM teammate WHERE entra_oid='provisional:shadow-1'`
  shadow = s!.id
  await t.client`INSERT INTO instance_attestation
      (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id,
       project_code_hash, raw_project_code, identity_state, claimed_email)
    VALUES (gen_random_uuid(), 'p-shadow', ${shadow}::uuid, 'claude-code',
            ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid, 'h', 'P',
            'provisional', 'victim@ko.test')`
  const [si] = await t.client<{ id: string }[]>`
    SELECT instance_id::text AS id FROM instance_attestation WHERE teammate_id=${shadow}::uuid LIMIT 1`
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id,
       tool, model, token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event,
       claude_session_id, identity_state)
    VALUES (${si!.id}::uuid, ${shadow}::uuid, ${ids.regionApac}::uuid, ${ids.uApacDelivery}::uuid,
            ${ids.uApacDelivery}::uuid, ${ids.projDeliveryx}::uuid, 'claude-code',
            'claude-sonnet-4-6', 'input', 40000, 20, 'tier-1', 'estimated',
            '2026-05-08T00:00:00Z'::timestamptz, 'conv-shadow', 'provisional')`
  await assign(shadow, ids.projDeliveryx)
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 60_000)

// ─────────────────────────────────────────────────────────────────────────────
// T34 — C3: the rows foot to the project total over ALL members
// ─────────────────────────────────────────────────────────────────────────────

describe('T34 — named rows + ONE remainder = the whole project (C3)', () => {
  it('the headline is over ALL members, not over the ones the viewer may name', async () => {
    const body = (await projectReport(
      ev(ownerSess(), MONTH, { code: 'PROJ-DELIVERYX' }),
    )) as unknown as {
      budget: { window_cost_usd: string; allocation_usd: string; burn_per_day_usd: string }
      contribution: {
        named: { teammate_id: string; display_name: string; cost_usd: string; is_active: boolean }[]
        remainder: { members: number; label: string; cost_usd: string }
        rows_total_usd: string
      }
      admitted_by: string
    }
    // alice 250 + bob 300 = 550 over ALL members.
    expect(Number(body.budget.window_cost_usd)).toBeCloseTo(550, 6)
    expect(Number(body.budget.allocation_usd)).toBeCloseTo(1000, 6)
    expect(body.admitted_by).toBe('member-in-scope')

    // Σ(named) + remainder === the headline, EXACTLY. The headline is computed
    // independently of these rows (completeOneProjectSpend), so this identity is
    // a real reconciliation and not a restatement.
    const namedSum = body.contribution.named.reduce((a, r) => a + Number(r.cost_usd), 0)
    const total = namedSum + Number(body.contribution.remainder.cost_usd)
    expect(total).toBeCloseTo(550, 6)
    expect(Number(body.contribution.rows_total_usd)).toBeCloseTo(550, 6)
  })

  it('a subject OUTSIDE the viewer’s people-scope folds into the remainder, with its count', async () => {
    /*
     * The viewer owns apac.delivery. Bob is placed there, so he is NAMED; alice
     * is placed at apac.cto, so her $250 folds into the ONE aggregate remainder
     * — even though it is the same project, the same window and the same lane.
     * That is the named-row rule doing its job (annex :521-526).
     */
    const body = (await projectReport(
      ev(ownerSess(), MONTH, { code: 'PROJ-DELIVERYX' }),
    )) as unknown as {
      contribution: {
        named: { display_name: string; cost_usd: string }[]
        remainder: { members: number; label: string; cost_usd: string }
      }
    }
    expect(body.contribution.named.map((r) => r.display_name)).toEqual(['bob@ko.test'])
    expect(Number(body.contribution.named[0]!.cost_usd)).toBeCloseTo(300, 6)
    expect(body.contribution.remainder.members).toBe(1)
    expect(Number(body.contribution.remainder.cost_usd)).toBeCloseTo(250, 6)
    // The remainder renders UNSUPPRESSED with its member count — the RECORDED
    // current behaviour while owner decision 1 (single-person suppression,
    // brief :94-97) stays open. If suppression is later chosen, this assertion
    // changes WITH the recorded decision, not before it.
    expect(body.contribution.remainder.label).toBe('1 member outside your scope')
  })

  it('named rows carry is_active — the drill conjunct a client cannot infer', async () => {
    const body = (await projectReport(
      ev(ownerSess(), MONTH, { code: 'PROJ-DELIVERYX' }),
    )) as unknown as { contribution: { named: { is_active: boolean }[] } }
    expect(body.contribution.named.length).toBeGreaterThan(0)
    for (const r of body.contribution.named) expect(typeof r.is_active).toBe('boolean')
  })

  it('the reports depth carries NO team table, activity mix or untagged pressure', async () => {
    const body = (await projectReport(
      ev(ownerSess(), MONTH, { code: 'PROJ-DELIVERYX' }),
    )) as unknown as Record<string, unknown>
    const keys = Object.keys(body)
    expect(keys).not.toContain('team')
    expect(keys).not.toContain('untagged_pressure')
    expect(JSON.stringify(body)).not.toContain('by_activity')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-H2 — a provisional shadow is neither named nor counted
// ─────────────────────────────────────────────────────────────────────────────

describe('r3-H2 — unconfirmed identities are never manager-facing figures', () => {
  it('the shadow’s $20 is in NEITHER the headline nor the rows — C3 still foots', async () => {
    const body = await read(ownerSess(), MONTH)
    // 250 (alice) + 300 (bob) = 550. The shadow's $20 is excluded on BOTH sides
    // of the reconciliation, which is the only way the identity can hold.
    expect(Number(body.budget.window_cost_usd)).toBeCloseTo(550, 6)
    const namedSum = body.contribution.named.reduce((a, r) => a + Number(r.cost_usd), 0)
    expect(namedSum + Number(body.contribution.remainder.cost_usd)).toBeCloseTo(550, 6)
    expect(Number(body.contribution.rows_total_usd)).toBeCloseTo(550, 6)
  })

  it('the claimed email never appears — not as a row, not in the remainder count', async () => {
    const body = await read(ownerSess(), MONTH)
    expect(JSON.stringify(body)).not.toContain('victim@ko.test')
    expect(namesOf(body)).toEqual(['bob@ko.test'])
    // The shadow is inside the owner's people scope and a member of the
    // project, so nothing but the identity state keeps it out of the table.
    expect(body.contribution.remainder.members).toBe(1)
  })

  it('the model mix divides by the SAME money the headline states', async () => {
    const body = await read(ownerSess(), MONTH)
    const mixSum = body.mix.by_model.reduce((a, m) => a + Number(m.cost_usd), 0)
    expect(mixSum).toBeCloseTo(Number(body.budget.window_cost_usd), 6)
  })

  it('the teammate page REFUSES a provisional subject in the page’s own 403 vocabulary', async () => {
    const denied = await teammateReport(
      ev(adminSess(), `src=across&${MONTH}`, { id: shadow }) as unknown as Parameters<
        typeof teammateReport
      >[0],
    ).catch((e: { statusCode: number; data: unknown }) => e)
    expect((denied as { statusCode: number }).statusCode).toBe(403)
    // Byte-identical to every other inadmissible subject: WHICH conjunct failed
    // must not be readable from outside, or the endpoint answers "is this
    // identity confirmed" for any id a caller cares to try.
    const other = await teammateReport(
      ev(adminSess(), `src=across&${MONTH}`, {
        id: '00000000-0000-4000-8000-000000000000',
      }) as unknown as Parameters<typeof teammateReport>[0],
    ).catch((e: { statusCode: number; data: unknown }) => e)
    expect(JSON.stringify((denied as { data: unknown }).data)).toBe(
      JSON.stringify((other as { data: unknown }).data),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-H1 — the cache key names WHICH roots admitted the read
// ─────────────────────────────────────────────────────────────────────────────

describe('r3-H1 — partial scope revocation re-keys the cached response', () => {
  it('revoking ONE owned cost centre stops the warm body naming its people', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    // The owner now holds TWO roots: apac.delivery (bob) and apac.cto (alice).
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      VALUES (${ids.uApacCto}::uuid, ${ccOwner}::uuid)`
    try {
      const warm = await read(ownerSess(), MONTH)
      expect(namesOf(warm)).toEqual(['alice@ko.test', 'bob@ko.test'])
      const missesAfterWarm = reportCacheStats().responseMisses

      /*
       * Revoke apac.cto ONLY. apac.delivery still admits the project, so the
       * live authz check still passes and the request still 200s — which is
       * exactly why the KEY has to move. Under the old `people:scoped` key the
       * warm body was returned verbatim for the rest of the 60 s TTL, naming
       * alice and her dollars through a scope the caller had just lost.
       */
      await t.client`UPDATE cou_owner SET revoked_at = now()
        WHERE org_unit_id = ${ids.uApacCto}::uuid AND teammate_id = ${ccOwner}::uuid`

      const next = await read(ownerSess(), MONTH)
      // A MISS, not a hit: the resolved roots are part of the key.
      expect(reportCacheStats().responseMisses).toBe(missesAfterWarm + 1)
      expect(namesOf(next)).toEqual(['bob@ko.test'])
      expect(JSON.stringify(next)).not.toContain('alice@ko.test')
      // …and alice's $250 is back inside the remainder, where the revoked scope
      // means it belongs — the rows still foot.
      expect(Number(next.contribution.remainder.cost_usd)).toBeCloseTo(250, 6)
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
      await t.client`DELETE FROM cou_owner
        WHERE org_unit_id = ${ids.uApacCto}::uuid AND teammate_id = ${ccOwner}::uuid`
    }
  })

  it('the same caller with the same query still shares ONE entry across requests', async () => {
    // The key must move on a ROOT change and on nothing else — a key that never
    // hits is not a fix, it is a disabled cache.
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    try {
      await read(ownerSess(), MONTH)
      const before = reportCacheStats()
      await read(ownerSess(), MONTH)
      const after = reportCacheStats()
      expect(after.responseHits).toBe(before.responseHits + 1)
      expect(after.responseMisses).toBe(before.responseMisses)
    } finally {
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r3-M4 — a named row is a LINK only for the frame the link carries
// ─────────────────────────────────────────────────────────────────────────────

describe('r3-M4 — per-row drill admission is server-resolved for the carried frame', () => {
  it('a contributor named through a DIFFERENT owned scope than ?src= is not drillable', async () => {
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      VALUES (${ids.uApacCto}::uuid, ${ccOwner}::uuid)`
    try {
      /*
       * Enter through cc:apac.cto. BOTH contributors are NAMED — naming reads
       * the viewer's whole people scope — but only alice has an in-window row
       * homed to apac.cto ($100, PROJ-SCHOLARSHIP). Bob's spend homes entirely
       * to apac.delivery, so his drill destination has nothing to compute over.
       */
      const body = await read(ownerSess(), `${MONTH}&src=cc:${ids.uApacCto}`)
      expect(namesOf(body)).toEqual(['alice@ko.test', 'bob@ko.test'])
      expect(rowFor(body, 'alice@ko.test')!.can_drill).toBe(true)
      expect(rowFor(body, 'bob@ko.test')!.can_drill).toBe(false)

      // The destination the client WOULD have linked to, proving `can_drill:
      // false` is not conservatism but the truth: this link is dead.
      const denied = await teammateReport(
        ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, { id: ids.bob }) as unknown as Parameters<
          typeof teammateReport
        >[0],
      ).catch((e: { statusCode: number }) => e)
      expect((denied as { statusCode: number }).statusCode).toBe(403)

      // …and the one marked drillable really does open.
      const ok = (await teammateReport(
        ev(ownerSess(), `src=cc:${ids.uApacCto}&${MONTH}`, {
          id: ids.alice,
        }) as unknown as Parameters<typeof teammateReport>[0],
      )) as unknown as { headlineUsd: number }
      expect(ok.headlineUsd).toBeCloseTo(100, 6)
    } finally {
      await t.client`DELETE FROM cou_owner
        WHERE org_unit_id = ${ids.uApacCto}::uuid AND teammate_id = ${ccOwner}::uuid`
    }
  })

  it('NO carried frame ⇒ no row is a door — a link with no `src` is a bare teammate id', async () => {
    const body = await read(ownerSess(), MONTH)
    expect(body.contribution.named.length).toBeGreaterThan(0)
    for (const r of body.contribution.named) expect(r.can_drill).toBe(false)
  })

  it('a frame the caller does NOT hold is not a 403 here — it is simply no drill', async () => {
    // `src` is optional on this endpoint and computes no figure, so an unheld
    // token can only mean "no link"; refusing would turn a decoration into a gate.
    const body = await read(ownerSess(), `${MONTH}&src=cc:${ids.uEmeaDelivery}`)
    expect(Number(body.budget.window_cost_usd)).toBeCloseTo(550, 6)
    for (const r of body.contribution.named) expect(r.can_drill).toBe(false)
  })

  /*
   * ── r5-M1: EVERY unusable frame degrades, not just 400/403 ────────────────
   *
   * The catch was narrowed by STATUS to {400, 403}. `resolveRegionalScope` also
   * raises a 404 — `region not found`, for a cross-region caller naming a region
   * uuid that is not in the region list (server/reporting/regional.ts). So a
   * WELL-FORMED `src=region:{uuid}` off a stale link, a deleted region, or a
   * bookmark from another estate took the WHOLE PROJECT PAGE down with a 500 —
   * the one outcome `src` being optional here is supposed to make impossible.
   *
   * MUTATION: put `status === 400 || status === 403` back in
   * `isUnusableFrame` (server/api/v1/reports/project/[code].get.ts) and the
   * first test below fails with a 404 escaping the handler.
   */
  it('a WELL-FORMED but UNKNOWN region frame is no drill, not a dead page (404)', async () => {
    // A platform-admin holds `regional: 'all-regions'`, so this token reaches the
    // region lookup rather than being refused at the grant gate — which is what
    // makes the 404 branch reachable at all.
    const ghostRegion = '00000000-0000-0000-0000-0000000000fe'
    const body = await read(adminSess(), `${MONTH}&src=region:${ghostRegion}`)
    // The PAGE is intact: every figure it computes is a fact about the project.
    expect(Number(body.budget.window_cost_usd)).toBeCloseTo(550, 6)
    expect(body.contribution.named.length).toBeGreaterThan(0)
    // Only the decoration is gone.
    expect(body.scope.src).toBe(`region:${ghostRegion}`)
    for (const r of body.contribution.named) expect(r.can_drill).toBe(false)
  })

  it('a MALFORMED frame id degrades too — and never reaches the ::uuid cast', async () => {
    /*
     * `cc:------------------------------------` is 36 chars of hex-and-dash. It
     * passed the legacy lax `/^[0-9a-f-]{36}$/i` shape check in
     * `resolveDrillScope` (the known-bad API-5 pattern retired elsewhere by
     * server/utils/require-uuid-param.ts), reached `resolveCostCentreDrill`, and
     * Postgres raised 22P02 on `ou.id = $1::uuid` — an error with NO statusCode,
     * i.e. outside the closed degradation set, i.e. a 500 on the whole page from
     * an optional decoration. `isUuid` turns it into the 400 the endpoint already
     * degrades on, which is what makes the enumerated {400,403,404} list COMPLETE
     * rather than merely approximate.
     *
     * The `region:` twin never reached a cast (the region-not-found 404 fires
     * first), so the cost-centre form is the one that has to be exercised — a
     * suite that only tried `region:` would have passed against the defect.
     *
     * MUTATION: restore the lax regex in server/reporting/teammate.ts — the
     * cost-centre case throws `invalid input syntax for type uuid` instead of
     * returning a body.
     */
    const malformed = [
      'cc:------------------------------------', // 36 chars, hex-and-dash, NOT a uuid
      'region:------------------------------------',
      'cc:notauuid',
      'nonsense',
    ]
    for (const bad of malformed) {
      const body = await read(adminSess(), `${MONTH}&src=${encodeURIComponent(bad)}`)
      expect(Number(body.budget.window_cost_usd), `src=${bad}`).toBeCloseTo(550, 6)
      for (const r of body.contribution.named) expect(r.can_drill).toBe(false)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// r4-M3 — a FAILED frame resolution is a failure, not a silently cached
//         degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('r4-M3 — only an unheld/malformed frame degrades to "no drill"', () => {
  /*
   * `?src=` resolution used to be wrapped in `.catch(() => null)`, which is the
   * right answer for exactly two conditions — a malformed token (400) and a
   * frame the caller does not hold (403), both pinned by the r3-M4 block above.
   * It also swallowed connection drops and statement timeouts, and then
   * `withReportCache` KEPT the resulting non-drillable body for the whole TTL:
   * one transient database blip silently disabled every drill link on the page
   * for a minute, with a 200 and nothing in the logs.
   *
   * MUTATION: restore `.catch(() => null)` in
   * server/api/v1/reports/project/[code].get.ts and BOTH assertions below go
   * red — the request 200s with `can_drill: false`, and a cache entry is written
   * from a resolution that failed.
   */
  it('a resolver failure surfaces, and no response is cached from it', async () => {
    process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS = '60000'
    resetReportCache()
    await t.client`INSERT INTO cou_owner (org_unit_id, teammate_id)
      VALUES (${ids.uApacCto}::uuid, ${ccOwner}::uuid)`
    const query = `${MONTH}&src=cc:${ids.uApacCto}`
    try {
      // A genuine failure carries no HTTP status — the shape a driver error has.
      drillFault.err = new Error('connection terminated unexpectedly')
      const before = reportCacheStats()
      await expect(read(ownerSess(), query)).rejects.toThrow(
        'connection terminated unexpectedly',
      )
      // NOT a degraded 200, and NOT a cache write: the compute closure is never
      // entered, so the response cache records neither a miss nor an entry.
      expect(reportCacheStats().responseMisses).toBe(before.responseMisses)

      // The database recovers. The very next request computes fresh and the
      // drill is live again — which is exactly what the TTL used to prevent.
      drillFault.err = null
      const recovered = await read(ownerSess(), query)
      expect(reportCacheStats().responseMisses).toBe(before.responseMisses + 1)
      expect(rowFor(recovered, 'alice@ko.test')!.can_drill).toBe(true)
    } finally {
      drillFault.err = null
      delete process.env.TOKENSCOPE_REPORT_CACHE_TTL_MS
      resetReportCache()
      await t.client`DELETE FROM cou_owner
        WHERE org_unit_id = ${ids.uApacCto}::uuid AND teammate_id = ${ccOwner}::uuid`
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T35 — no probing oracle in either direction
// ─────────────────────────────────────────────────────────────────────────────

describe('T35 — the two depths tell an outsider nothing', () => {
  it('me/* keeps its 404 posture: a non-member 404 is byte-identical to a missing code', async () => {
    /*
     * The plain developer, deliberately: `requireProjectMembership` already has
     * a cou-owner arm (R1 F1), so the CC owner reaches member depth on their own
     * centre's project. The posture this pins is the OTHER caller's — someone
     * with neither membership nor ownership.
     */
    const nonMember = await meProject(ev(plainSess(), MONTH, { code: 'PROJ-DELIVERYX' })).catch(
      (e: { statusCode: number; data: unknown }) => e,
    )
    const missing = await meProject(ev(plainSess(), MONTH, { code: 'NO-SUCH-PROJECT' })).catch(
      (e: { statusCode: number; data: unknown }) => e,
    )
    expect((nonMember as { statusCode: number }).statusCode).toBe(404)
    expect((missing as { statusCode: number }).statusCode).toBe(404)
    expect(JSON.stringify((nonMember as { data: unknown }).data)).toBe(
      JSON.stringify((missing as { data: unknown }).data),
    )
  })

  it('the reports endpoint 403s an out-of-scope project identically to a nonexistent one', async () => {
    const outOfScope = await projectReport(ev(ownerSess(), MONTH, { code: 'PROJ-EMEA' })).catch(
      (e: { statusCode: number; data: unknown }) => e,
    )
    const missing = await projectReport(ev(ownerSess(), MONTH, { code: 'NO-SUCH-PROJECT' })).catch(
      (e: { statusCode: number; data: unknown }) => e,
    )
    expect((outOfScope as { statusCode: number }).statusCode).toBe(403)
    expect((missing as { statusCode: number }).statusCode).toBe(403)
    // Identical bodies: "does a project with this code exist somewhere I cannot
    // see" must not be answerable by comparing two error shapes.
    expect(JSON.stringify((outOfScope as { data: unknown }).data)).toBe(
      JSON.stringify((missing as { data: unknown }).data),
    )
  })

  it('a viewer with NO project grant is 403 even on a project their region contains', async () => {
    const denied = await projectReport(ev(plainSess(), MONTH, { code: 'PROJ-DELIVERYX' })).catch(
      (e: { statusCode: number }) => e,
    )
    expect((denied as { statusCode: number }).statusCode).toBe(403)
  })

  it('a MEMBER still reaches the member depth — the two arms do not fight', async () => {
    const aliceSess = sess(ids.alice, 'developer', 'apac.cto')
    const body = (await meProject(ev(aliceSess, MONTH, { code: 'PROJ-DELIVERYX' }))) as unknown as {
      project: { code: string }
      team: { members: unknown[] }
    }
    expect(body.project.code).toBe('PROJ-DELIVERYX')
    // Member depth keeps its NAMED team table — no grants model involved.
    expect(body.team.members.length).toBeGreaterThan(0)
  })
})
