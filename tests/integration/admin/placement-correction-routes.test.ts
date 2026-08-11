// @vitest-environment node
/*
 * The ADMIN PLACEMENT-CORRECTION endpoints, exercised through the HANDLERS.
 *
 * `tests/integration/governance/rehome-placement.test.ts` calls the governance
 * module directly, which is where the six-table SQL is proved. It cannot see
 * what a route owns — RBAC, CSRF, region scope, body validation, the audit row,
 * or whether `rehome` is actually plumbed from the wire to the write. A gate
 * that only forbids the workers from importing the module would still pass if
 * the feature were wired to nothing.
 *
 * So this file asserts the boundary, not the arithmetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import spanHandler from '../../../server/api/v1/admin/users/[id]/placement-span.post'
import orgUnitHandler from '../../../server/api/v1/admin/users/[id]/org-unit.patch'
import bulkPlaceHandler from '../../../server/api/v1/admin/users/bulk-place.post'

let t: TestDb
let regionA = ''
let regionB = ''
let buFrom = ''
let buTo = ''
let buThird = ''
let buOtherRegion = ''
let subjectId = ''
let projectId = ''
let instanceId = ''
/*
 * REAL v4 UUIDs, version nibble and all. The routes validate the path id with
 * `z.string().uuid()`, and zod enforces the version and variant bits — a
 * convenient `00000000-…-0001` fixture id is refused as malformed, so every
 * test 400s on the id before reaching the behaviour it was written for. The two
 * that "passed" were the ones expecting a 400 anyway.
 */
const ADMIN_ID = '9a1e0000-0000-4000-8000-0000000000a1'
const SUBJECT_ID = '9a1e0000-0000-4000-8000-0000000000a2'

function ev(opts: { session: Session; id?: string; body?: unknown; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method ?? 'POST',
    path: '/x',
    context: { params: { id: opts.id ?? '' } },
    node: {
      req: {
        method: opts.method ?? 'POST',
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
  return e as unknown as Parameters<typeof spanHandler>[0]
}

const admin = (rid = regionA): Session =>
  ({ teammateId: ADMIN_ID, email: 'pc-admin@x.test', displayName: 'Admin', role: 'admin', regionId: rid, orgPath: 'from' }) as Session
const dev = (): Session =>
  ({ teammateId: ADMIN_ID, email: 'pc-dev@x.test', displayName: 'Dev', role: 'developer', regionId: regionA, orgPath: 'from' }) as Session

const iso = (d: Date) => d.toISOString()
const RECENT = iso(new Date(Date.now() - 3 * 86_400_000))
const OLDER = iso(new Date(Date.now() - 40 * 86_400_000))

beforeAll(async () => {
  t = await startTestDb()
  // The handlers open their own connection via withRequestRls.
  process.env.DATABASE_URL = t.url
  ;[{ id: regionA }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('pa', 'PA') RETURNING id::text AS id`
  ;[{ id: regionB }] = await t.client<{ id: string }[]>`
    INSERT INTO region (code, display_name) VALUES ('pb', 'PB') RETURNING id::text AS id`
  const unit = async (rid: string, path: string, code: string) => {
    const [r] = await t.client<{ id: string }[]>`
      INSERT INTO org_unit (region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES (${rid}::uuid, ${path}::ltree, ${code}, ${code}, 'bu', true) RETURNING id::text AS id`
    return r!.id
  }
  buFrom = await unit(regionA, 'pfrom', 'pfrom')
  buTo = await unit(regionA, 'pto', 'pto')
  buThird = await unit(regionA, 'pthird', 'pthird')
  buOtherRegion = await unit(regionB, 'pother', 'pother')
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${ADMIN_ID}::uuid, 'oid-pc-admin', 'pc-admin@x.test', 'Admin', ${regionA}::uuid, ${buFrom}::uuid, true)`
  ;[{ id: subjectId }] = await t.client<{ id: string }[]>`
    INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, is_active)
    VALUES (${SUBJECT_ID}::uuid, 'oid-pc-subj', 'pc-subj@x.test', 'Subject', ${regionA}::uuid, ${buFrom}::uuid, true)
    RETURNING id::text AS id`
  ;[{ id: projectId }] = await t.client<{ id: string }[]>`
    INSERT INTO project (code, code_hash, display_name, type, region_id, cost_owning_unit_id)
    VALUES ('PC1', 'hpc1', 'PC1', 'internal', ${regionA}::uuid, ${buFrom}::uuid) RETURNING id::text AS id`
  ;[{ id: instanceId }] = await t.client<{ id: string }[]>`
    INSERT INTO instance_attestation (instance_id, principal_oid, teammate_id, tool, region_id, org_unit_id, project_code_hash, raw_project_code)
    VALUES (gen_random_uuid(), 'p', ${SUBJECT_ID}::uuid, 'claude-code', ${regionA}::uuid, ${buFrom}::uuid, 'h', 'P')
    RETURNING instance_id::text AS id`
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
})

async function seed(unitId: string, ts: string, usd: string, session: string) {
  await t.client`INSERT INTO attribution_record
      (instance_id, teammate_id, region_id, org_unit_id, cost_owning_unit_id, project_id, tool, model,
       token_type, tokens, cost_usd, fidelity_tier, cost_basis, ts_event, claude_session_id)
    VALUES (${instanceId}::uuid, ${SUBJECT_ID}::uuid, ${regionA}::uuid, ${unitId}::uuid, ${unitId}::uuid,
            ${projectId}::uuid, 'claude-code', 'claude-sonnet-4-6', 'input', 100, ${usd},
            'tier-1', 'estimated', ${ts}::timestamptz, ${session})`
}

beforeEach(async () => {
  await t.client`DELETE FROM attribution_record`
  // `audit_event` is append-only (a trigger denies UPDATE/DELETE), which is the
  // point of it — so the assertion below reads the LATEST row rather than
  // assuming an empty table.
  await t.client`UPDATE teammate SET org_unit_id = ${buFrom}::uuid WHERE id = ${SUBJECT_ID}::uuid`
})

describe('placement-span — the boundary', () => {
  it('a developer cannot see what somebody else would move', async () => {
    await expect(
      spanHandler(ev({ session: dev(), id: subjectId, body: { range: { from: 'all' } } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an admin from another region is refused', async () => {
    await expect(
      spanHandler(ev({ session: admin(regionB), id: subjectId, body: { range: { from: 'all' } } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses a date that is not a real calendar day', async () => {
    // `2026-02-31` matches the shape, reaches Postgres's ::date cast and aborts
    // the query — a 500 on what is plainly a caller error.
    await expect(
      spanHandler(ev({ session: admin(), id: subjectId, body: { range: { from: '2026-02-31' } } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('names the Business Units the history spans, and does not write', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')
    await seed(buThird, RECENT, '4.000000', 'pc-b')

    const res = (await spanHandler(
      ev({ session: admin(), id: subjectId, body: { range: { from: 'all' } } }),
    )) as { sources: { orgUnitId: string; displayName: string; usd: number }[]; usd: number; spansMultipleUnits: boolean }

    expect(res.spansMultipleUnits).toBe(true)
    expect(res.usd).toBeCloseTo(14, 2)
    // Largest first, and NAMED — "spans 2" is not something an operator can act on.
    expect(res.sources.map((s) => s.displayName)).toEqual(['pfrom', 'pthird'])
    expect(res.sources[0]!.usd).toBeCloseTo(10, 2)

    const [{ n }] = await t.client<{ n: string }[]>`
      SELECT count(*)::text AS n FROM attribution_record WHERE org_unit_id = ${buTo}::uuid`
    expect(n).toBe('0') // read-only
  })

  it('a date floor changes what the preview describes', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')
    await seed(buThird, OLDER, '4.000000', 'pc-b')

    const floor = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
    const res = (await spanHandler(
      ev({ session: admin(), id: subjectId, body: { range: { from: floor } } }),
    )) as { usd: number; spansMultipleUnits: boolean }

    expect(res.usd).toBeCloseTo(10, 2)
    expect(res.spansMultipleUnits).toBe(false) // the older BU is below the floor
  })
})

describe('bulk-place — the history batch is capped', () => {
  /*
   * A placement-only batch writes one row per teammate. A batch WITH history
   * rewrites six tables for each, in ONE transaction, with no statement_timeout
   * anywhere — so an oversized one outlives the browser while still committing,
   * which is precisely the Migrate confusion this release exists to end.
   */
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `9a1e0000-0000-4000-8000-${String(i).padStart(12, '0')}`)

  it('refuses a history batch above the cap, before touching a single row', async () => {
    await expect(
      bulkPlaceHandler(
        ev({ session: admin(), body: { teammate_ids: ids(51), org_unit_id: buTo, rehome: { from: 'all' } } }) as Parameters<typeof bulkPlaceHandler>[0],
      ),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('still allows a LARGE placement-only batch — the cap is on the history, not the placement', async () => {
    // 51 unknown ids: every one comes back `failed`, which is the point — the
    // request was ACCEPTED and refused per id, not rejected at the boundary.
    const res = (await bulkPlaceHandler(
      ev({ session: admin(), body: { teammate_ids: ids(51), org_unit_id: buTo } }) as Parameters<typeof bulkPlaceHandler>[0],
    )) as { failed: number }
    expect(res.failed).toBe(51)
  })
})

describe('org-unit PATCH — rehome is plumbed end to end', () => {
  const patch = (body: unknown, session = admin()) =>
    orgUnitHandler(ev({ session, id: subjectId, body, method: 'PATCH' }) as Parameters<typeof orgUnitHandler>[0])

  it('WITHOUT rehome, history stays put — the sync path default', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')

    const res = (await patch({ org_unit_id: buTo })) as { outcome: string; rehomed?: unknown }
    expect(res.outcome).toBe('placed')
    expect(res.rehomed).toBeUndefined()

    const [row] = await t.client<{ ou: string }[]>`
      SELECT org_unit_id::text AS ou FROM attribution_record WHERE teammate_id = ${SUBJECT_ID}::uuid`
    expect(row!.ou).toBe(buFrom)
  })

  it('WITH rehome, the recorded usage follows and the response says what moved', async () => {
    await seed(buFrom, RECENT, '10.000000', 'pc-a')

    const res = (await patch({ org_unit_id: buTo, rehome: { from: 'all' } })) as {
      rehomed?: { attributionRows: number; rollupRows: number }
    }
    expect(res.rehomed?.attributionRows).toBe(1)

    const [row] = await t.client<{ ou: string }[]>`
      SELECT org_unit_id::text AS ou FROM attribution_record WHERE teammate_id = ${SUBJECT_ID}::uuid`
    expect(row!.ou).toBe(buTo)
  })

  it('the audit records what the correction ACTUALLY moved, not what was asked for', async () => {
    /*
     * The audit row is written AFTER the re-home for exactly this reason. An
     * entry saying "all history" when the archive floor left half of it behind
     * would be the only record of a correction, and wrong.
     */
    await seed(buFrom, RECENT, '10.000000', 'pc-a')
    await patch({ org_unit_id: buTo, rehome: { from: 'all' } })

    const [row] = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event WHERE subject_id = ${SUBJECT_ID}::uuid ORDER BY ts_recorded DESC LIMIT 1`
    const rehome = row!.payload.rehome as { range: unknown; attributionRows: number }
    expect(rehome.range).toEqual({ from: 'all' })
    expect(rehome.attributionRows).toBe(1)
  })

  it('already there and NO rehome asked for — writes nothing', async () => {
    /*
     * Re-placing somebody into the unit they are already in is a normal
     * mis-click. It must not become a licence to restate their history, and it
     * must not strip the manager-chain provenance that keeps them re-derivable.
     */
    await seed(buThird, RECENT, '10.000000', 'pc-a')

    const res = (await patch({ org_unit_id: buFrom })) as { outcome: string; rehomed?: unknown }
    expect(res.outcome).toBe('noop')
    expect(res.rehomed).toBeUndefined()

    const [row] = await t.client<{ ou: string }[]>`
      SELECT org_unit_id::text AS ou FROM attribution_record WHERE teammate_id = ${SUBJECT_ID}::uuid`
    expect(row!.ou).toBe(buThird) // untouched
  })

  it('already there and rehome ASKED FOR — repairs the stranded history', async () => {
    /*
     * THE REPAIR THE FEATURE EXISTS FOR, and it was impossible until now: the
     * same-unit branch returned before the re-home could run.
     *
     * `bulk-place` moved hundreds of people and touched no spend row, so the
     * estate is full of teammates sitting on the RIGHT unit with their history
     * stranded on the wrong one. The only remedy was to move them somewhere
     * wrong and back — two false audit entries to fix one real problem.
     */
    await seed(buThird, RECENT, '10.000000', 'pc-a')

    const res = (await patch({ org_unit_id: buFrom, rehome: { from: 'all' } })) as {
      outcome: string
      rehomed?: { attributionRows: number }
    }
    expect(res.outcome).toBe('history-repaired')
    expect(res.rehomed?.attributionRows).toBe(1)

    const [row] = await t.client<{ ou: string }[]>`
      SELECT org_unit_id::text AS ou FROM attribution_record WHERE teammate_id = ${SUBJECT_ID}::uuid`
    expect(row!.ou).toBe(buFrom) // the history came home

    // And it is auditable AS A REPAIR, not as a move that never happened.
    const [audit] = await t.client<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM audit_event WHERE subject_id = ${SUBJECT_ID}::uuid
       ORDER BY ts_recorded DESC LIMIT 1`
    expect((audit!.payload.rehome as { historyOnly: boolean }).historyOnly).toBe(true)
  })

  it('refuses a target in another region', async () => {
    await expect(patch({ org_unit_id: buOtherRegion, rehome: { from: 'all' } })).rejects.toMatchObject({
      statusCode: 422,
    })
  })

  it('refuses a rehome date that is not a real calendar day', async () => {
    await expect(patch({ org_unit_id: buTo, rehome: { from: '2026-02-31' } })).rejects.toMatchObject({
      statusCode: 400,
    })
  })
})
