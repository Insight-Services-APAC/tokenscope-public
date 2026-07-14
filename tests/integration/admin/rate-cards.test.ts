// @vitest-environment node
/*
 * Rate-card CRUD (PRD COST-5, safe half): create-with-lines transactionality,
 * per-tier version increments, the 0050 EXCLUDE surfacing as a clean 409
 * (overlap WITHIN a tier only — different tiers may share a period), retire
 * one-shot semantics, scope authority, and the list's in_use EXISTS contract
 * (attribution_record pinning — COST-7).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listGet from '../../../server/api/v1/admin/rate-cards/index.get'
import createPost from '../../../server/api/v1/admin/rate-cards/index.post'
import retirePost from '../../../server/api/v1/admin/rate-cards/[id]/retire.post'

let t: TestDb
let regionId: string
let otherRegionId: string
let ouId: string
let finopsId: string
let adminId: string

const INST = '77777777-7777-7777-7777-777777777777'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'rc-r', displayName: 'RC R' }).returning()
  regionId = r!.id
  const [r2] = await t.db.insert(schema.region).values({ code: 'rc-o', displayName: 'RC Other' }).returning()
  otherRegionId = r2!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'rc.svc', code: 'rc-svc', displayName: 'Svc', unitType: 'bu' })
    .returning()
  ouId = o!.id
  const [f] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rc-fin', email: 'rc-fin@x.test', role: 'global-finops', regionId, orgUnitId: ouId })
    .returning()
  finopsId = f!.id
  const [a] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'oid-rc-admin', email: 'rc-admin@x.test', role: 'admin', regionId, orgUnitId: ouId })
    .returning()
  adminId = a!.id
}, 120_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

function ev(opts: { method: string; body?: unknown; session: Session; params?: Record<string, string> }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const e = {
    method: opts.method,
    path: '/x',
    context: { params: opts.params ?? {} },
    node: {
      req: {
        method: opts.method,
        url: '/x',
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof createPost>[0]
}

const finops = (): Session => ({ teammateId: finopsId, email: 'rc-fin@x.test', displayName: 'Fin', role: 'global-finops', regionId, orgPath: 'rc.svc' })
const admin = (): Session => ({ teammateId: adminId, email: 'rc-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'rc.svc' })

const LINES = [
  { unit: 'input', unit_qty: 1_000_000, unit_cost_usd: '3.00', model: null },
  { unit: 'output', unit_qty: 1_000_000, unit_cost_usd: '15.00', model: null },
]

type CreateResult = { id: string; scope_key: string; region_id: string | null; version: number; line_count: number }
type ListResult = {
  rate_cards: {
    id: string
    scope_key: string
    region_id: string | null
    region_code: string | null
    effective_from: string | null
    effective_to: string | null
    basis: string
    version: number
    retired_at: string | null
    line_count: number
    in_use: boolean
  }[]
}

async function cardCount(scopeKey: string): Promise<number> {
  const rows = await t.db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM rate_card WHERE scope_key = ${scopeKey}
  `)
  return Number([...rows][0]!.n)
}
async function lineCount(scopeKey: string): Promise<number> {
  const rows = await t.db.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM rate_line rl JOIN rate_card rc ON rc.id = rl.rate_card_id
    WHERE rc.scope_key = ${scopeKey}
  `)
  return Number([...rows][0]!.n)
}

let globalCardV1 = '' // acme:tool-a global [jan,feb) v1 — pinned by attribution later
let regionCard = '' // acme:tool-a region [jan15,mar) v1

describe('create — transactionality + versioning + overlap tiers', () => {
  it('creates a card with its lines in one shot; first card in a tier is v1; audited with the full payload', async () => {
    const res = (await createPost(ev({
      method: 'POST',
      body: { scope_key: 'acme:tool-a', region_id: null, effective: '[2026-01-01,2026-02-01)', basis: 'list', provenance: { source: 'test' }, lines: LINES },
      session: finops(),
    }))) as CreateResult
    expect(res.version).toBe(1)
    expect(res.line_count).toBe(2)
    globalCardV1 = res.id

    expect(await cardCount('acme:tool-a')).toBe(1)
    expect(await lineCount('acme:tool-a')).toBe(2)

    const audits = await t.client<{ payload: { scope_key: string; lines: unknown[]; version: number } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'rate-card-created' AND subject_id = ${res.id}::uuid
    `
    expect(audits.length).toBe(1)
    expect(audits[0]!.payload.scope_key).toBe('acme:tool-a')
    expect(audits[0]!.payload.version).toBe(1)
    expect(audits[0]!.payload.lines).toHaveLength(2)
  })

  it('version increments WITHIN a tier; a different tier starts back at v1 and may overlap the other tier\'s period', async () => {
    const second = (await createPost(ev({
      method: 'POST',
      body: { scope_key: 'acme:tool-a', region_id: null, effective: '[2026-02-01,2026-03-01)', basis: 'negotiated', provenance: { source: 'test' }, lines: LINES },
      session: finops(),
    }))) as CreateResult
    expect(second.version).toBe(2) // same global tier → 1 + max(version)

    // Region card OVERLAPPING both global periods — legal (0050: the
    // no-overlap invariant holds within a (scope_key, region, cou) tier only)
    // and versioned independently (v1, not v3).
    const regional = (await createPost(ev({
      method: 'POST',
      body: { scope_key: 'acme:tool-a', region_id: regionId, effective: '[2026-01-15,2026-03-01)', basis: 'list', provenance: { source: 'test' }, lines: LINES },
      session: admin(),
    }))) as CreateResult
    expect(regional.version).toBe(1)
    expect(regional.region_id).toBe(regionId)
    regionCard = regional.id
  })

  it('overlap WITHIN a tier → 409 (the 0050 EXCLUDE\'s 23P01, translated), and nothing persists (all-or-nothing)', async () => {
    const cardsBefore = await cardCount('acme:tool-a')
    const linesBefore = await lineCount('acme:tool-a')
    await expect(
      createPost(ev({
        method: 'POST',
        body: { scope_key: 'acme:tool-a', region_id: null, effective: '[2026-01-15,2026-02-15)', basis: 'list', provenance: { source: 'test' }, lines: LINES },
        session: finops(),
      })),
    ).rejects.toMatchObject({
      statusCode: 409,
      data: { status: 409, detail: 'A card already covers this period for this scope.' },
    })
    // The card INSERT failed inside the transaction — no card, no orphan lines.
    expect(await cardCount('acme:tool-a')).toBe(cardsBefore)
    expect(await lineCount('acme:tool-a')).toBe(linesBefore)
  })

  it('duplicate (unit, model) lines → 400, no card persisted (NULL models would slip past the DB UNIQUE)', async () => {
    await expect(
      createPost(ev({
        method: 'POST',
        body: {
          scope_key: 'acme:tool-dup',
          region_id: null,
          effective: '[2026-01-01,2026-02-01)',
          basis: 'list',
          provenance: { source: 'test' },
          lines: [
            { unit: 'input', unit_qty: 1_000_000, unit_cost_usd: '3.00', model: null },
            { unit: 'input', unit_qty: 1_000_000, unit_cost_usd: '4.00', model: null },
          ],
        },
        session: finops(),
      })),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(await cardCount('acme:tool-dup')).toBe(0)
  })

  it('a region admin cannot create a GLOBAL card (403) nor another region\'s card (403)', async () => {
    await expect(
      createPost(ev({
        method: 'POST',
        body: { scope_key: 'acme:tool-b', region_id: null, effective: '[2026-01-01,2026-02-01)', basis: 'list', provenance: {}, lines: LINES },
        session: admin(),
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      createPost(ev({
        method: 'POST',
        body: { scope_key: 'acme:tool-b', region_id: otherRegionId, effective: '[2026-01-01,2026-02-01)', basis: 'list', provenance: {}, lines: LINES },
        session: admin(),
      })),
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(await cardCount('acme:tool-b')).toBe(0)
  })

  it('validation: malformed scope_key / inverted effective / empty lines → 400', async () => {
    const base = { region_id: null, basis: 'list', provenance: {}, lines: LINES }
    await expect(
      createPost(ev({ method: 'POST', body: { ...base, scope_key: 'NotAScope', effective: '[2026-01-01,2026-02-01)' }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      createPost(ev({ method: 'POST', body: { ...base, scope_key: 'acme:tool-b', effective: '[2026-02-01,2026-01-01)' }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      createPost(ev({ method: 'POST', body: { ...base, scope_key: 'acme:tool-b', effective: '[2026-01-01,2026-02-01)', lines: [] }, session: finops() })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('non-existent region UUID → 404 (not a raw FK 500)', async () => {
    await expect(
      createPost(ev({
        method: 'POST',
        body: { scope_key: 'acme:tool-b', region_id: '00000000-0000-0000-0000-000000000001', effective: '[2026-01-01,2026-02-01)', basis: 'list', provenance: {}, lines: LINES },
        session: finops(),
      })),
    ).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('list — in_use EXISTS contract + region scoping', () => {
  beforeAll(async () => {
    // A card in the OTHER region (a region admin must not see it) …
    await createPost(ev({
      method: 'POST',
      body: { scope_key: 'acme:tool-a', region_id: otherRegionId, effective: '[2026-01-01,2026-02-01)', basis: 'list', provenance: { source: 'test' }, lines: LINES },
      session: finops(),
    }))
    // … and an attribution record PINNING the first global card (COST-7).
    await t.client.unsafe(`
      INSERT INTO instance_attestation
        (instance_id, principal_oid, principal_email, teammate_id, project_code_hash, raw_project_code,
         tool, session_token_hash, ts_start, ts_actual_end, region_id, org_unit_id, cost_owning_unit_id,
         attestation_state)
      VALUES
        ('${INST}','oid-rc-fin','rc-fin@x.test','${finopsId}',NULL,NULL,'claude-code','hRc',
         '2026-01-10T09:00:00Z','2026-01-10T11:00:00Z','${regionId}','${ouId}',NULL,'unassigned');
      INSERT INTO attribution_record
        (instance_id, teammate_id, region_id, org_unit_id, tool, model, token_type, tokens, cost_usd,
         rate_card_id, rate_card_version, fidelity_tier, cost_basis, ts_event)
      VALUES
        ('${INST}','${finopsId}','${regionId}','${ouId}','claude-code','claude-sonnet-4-7','input',
         1000, 0.003, '${globalCardV1}', 1, 'tier-2', 'telemetry-only', '2026-01-10T10:00:00Z');
    `)
  })

  it('in_use is true exactly for the card attribution_record pins; line_count counts its lines', async () => {
    const got = (await listGet(ev({ method: 'GET', session: finops() }))) as ListResult
    const pinned = got.rate_cards.find((c) => c.id === globalCardV1)
    expect(pinned).toBeDefined()
    expect(pinned!.in_use).toBe(true)
    expect(pinned!.line_count).toBe(2)
    for (const c of got.rate_cards.filter((c) => c.id !== globalCardV1)) {
      expect(c.in_use).toBe(false)
    }
  })

  it('global roles see every card; a region admin sees global + own-region only', async () => {
    const all = (await listGet(ev({ method: 'GET', session: finops() }))) as ListResult
    expect(all.rate_cards.some((c) => c.region_id === otherRegionId)).toBe(true)

    const scoped = (await listGet(ev({ method: 'GET', session: admin() }))) as ListResult
    expect(scoped.rate_cards.length).toBeGreaterThan(0)
    expect(scoped.rate_cards.every((c) => c.region_id === null || c.region_id === regionId)).toBe(true)
    // The seeded anthropic:claude-code global card (mig 0004) rides along.
    expect(scoped.rate_cards.some((c) => c.scope_key === 'anthropic:claude-code')).toBe(true)
  })

  it('orders by scope_key then effective desc, with server-parsed bounds (FE-1)', async () => {
    const got = (await listGet(ev({ method: 'GET', session: finops() }))) as ListResult
    const keys = got.rate_cards.map((c) => c.scope_key)
    expect([...keys].sort()).toEqual(keys)
    const globalToolA = got.rate_cards.filter((c) => c.scope_key === 'acme:tool-a' && c.region_id === null)
    expect(globalToolA.map((c) => c.effective_from)).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
  })
})

describe('retire — one-shot, scoped, audited', () => {
  it('retires an own-region card; a second retire → 409', async () => {
    const res = (await retirePost(ev({ method: 'POST', session: admin(), params: { id: regionCard } }))) as {
      id: string
      retired_at: string
    }
    expect(res.retired_at).toBeTruthy()

    const audits = await t.client<{ payload: { scope_key: string } }[]>`
      SELECT payload::jsonb AS payload FROM audit_event
      WHERE event_type = 'rate-card-retired' AND subject_id = ${regionCard}::uuid
    `
    expect(audits.length).toBe(1)
    expect(audits[0]!.payload.scope_key).toBe('acme:tool-a')

    await expect(
      retirePost(ev({ method: 'POST', session: admin(), params: { id: regionCard } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region admin cannot retire a GLOBAL card (403) nor another region\'s card (403); global-finops can retire global', async () => {
    await expect(
      retirePost(ev({ method: 'POST', session: admin(), params: { id: globalCardV1 } })),
    ).rejects.toMatchObject({ statusCode: 403 })

    const otherRows = await t.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM rate_card WHERE scope_key = 'acme:tool-a' AND region_id = ${otherRegionId}::uuid LIMIT 1
    `)
    const otherCard = [...otherRows][0]!.id
    await expect(
      retirePost(ev({ method: 'POST', session: admin(), params: { id: otherCard } })),
    ).rejects.toMatchObject({ statusCode: 403 })

    const res = (await retirePost(ev({ method: 'POST', session: finops(), params: { id: globalCardV1 } }))) as {
      retired_at: string
    }
    expect(res.retired_at).toBeTruthy()
    // The pin (in_use) survives retire — retire never deletes (COST-7).
    const got = (await listGet(ev({ method: 'GET', session: finops() }))) as ListResult
    const pinned = got.rate_cards.find((c) => c.id === globalCardV1)
    expect(pinned!.retired_at).toBeTruthy()
    expect(pinned!.in_use).toBe(true)
  })

  it('unknown id → 404; malformed id → 400', async () => {
    await expect(
      retirePost(ev({ method: 'POST', session: finops(), params: { id: '00000000-0000-0000-0000-000000000002' } })),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      retirePost(ev({ method: 'POST', session: finops(), params: { id: 'not-a-uuid' } })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
