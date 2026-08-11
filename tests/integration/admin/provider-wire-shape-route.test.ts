// @vitest-environment node
/*
 * POST /api/v1/admin/diagnostics/provider-wire-shape.
 *
 * WHAT MUST NOT REGRESS, in order of consequence:
 *   1. It is platform-admin ONLY, and the gate runs BEFORE any provider work.
 *      It returns raw provider error bodies and issues calls that cost money;
 *      the wider admin/global-finops tier the rest of diagnostics uses is not
 *      enough. The RBAC block runs LAST in this file, against a configured
 *      environment, for the reason stated above it.
 *   2. A surface with no matching provider_org reports 'not-configured' — a
 *      NEUTRAL state. An environment wired to one Anthropic variant is not
 *      unhealthy for lacking the other, and a red badge there is a false alarm.
 *   3. The stored scan finds fields our Zod does not declare. That is the whole
 *      point: passthrough preserves them, the poller stores them, and nothing
 *      reads them. Where the schema does NOT preserve them, the report says so
 *      instead of leaving silence to read as absence.
 *   4. A failing surface reports its RAW provider error and the OTHER surfaces
 *      still return.
 *   5. No identifying value from a payload reaches the response.
 *   6. The action is audited BEFORE the provider calls and again after.
 *   7. Every stored scan reads only its own tenant and its own lane, and states
 *      its bound honestly at the boundary as well as past it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { sql } from 'drizzle-orm'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import handler from '../../../server/api/v1/admin/diagnostics/provider-wire-shape.post'

let t: TestDb
let regionId: string
let ouId: string
let platformId: string
let finopsId: string
let adminId: string
let devId: string
let stub: Server
let stubUrl: string
/** Yesterday (UTC) — inside every window these tests ask for, and it stays that way. */
const RECENT_DAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
/** Which paths the stub was asked for — proves the probe issued the calls it claims. */
let stubRequests: string[] = []

function ev(opts: { body?: unknown; session: Session; origin?: string }) {
  const headers: Record<string, string> = {
    host: 'localhost:3450',
    origin: opts.origin ?? 'http://localhost:3450',
  }
  const e = {
    method: 'POST',
    path: '/api/v1/admin/diagnostics/provider-wire-shape',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/api/v1/admin/diagnostics/provider-wire-shape',
        body: opts.body ?? {},
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
  return e as unknown as Parameters<typeof handler>[0]
}

const platform = (): Session => ({ teammateId: platformId, email: 'ws-pa@x.test', displayName: 'PA', role: 'platform-admin', regionId, orgPath: 'ws.svc' })
const finops = (): Session => ({ teammateId: finopsId, email: 'ws-fin@x.test', displayName: 'Fin', role: 'global-finops', regionId, orgPath: 'ws.svc' })
const admin = (): Session => ({ teammateId: adminId, email: 'ws-admin@x.test', displayName: 'Admin', role: 'admin', regionId, orgPath: 'ws.svc' })
const dev = (): Session => ({ teammateId: devId, email: 'ws-dev@x.test', displayName: 'Dev', role: 'developer', regionId, orgPath: 'ws.svc' })

/*
 * The stub answers the two Enterprise Analytics reports. The usage report carries
 * `model` plus four fields our Zod never declared; the cost report 400s, which is
 * how the raw-error path and the fail-soft isolation get exercised in one run.
 */
function startStub(): Promise<void> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      stubRequests.push(req.url ?? '')
      if (path === '/v1/organizations/analytics/user_usage_report') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            organization_id: 'org-stub',
            data: [
              {
                actor: { type: 'user_actor', email: 'someone@example.test', user_id: 'u-1', deleted: false },
                product: 'claude_code',
                model: 'claude-opus-4',
                context_window: '0-200k',
                speed: 'standard',
                uncached_input_tokens: 10,
                output_tokens: 5,
              },
              {
                actor: { type: 'user_actor', email: 'other@example.test', user_id: 'u-2', deleted: false },
                product: 'claude_code',
                model: 'claude-sonnet-4',
                context_window: '0-200k',
                speed: 'standard',
                uncached_input_tokens: 3,
                output_tokens: 2,
              },
            ],
            has_more: false,
            next_page: null,
            data_refreshed_at: '2099-01-01T00:00:00Z',
          }),
        )
        return
      }
      if (path === '/v1/organizations/analytics/user_cost_report') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stub refuses the cost report' } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    stub.listen(0, '127.0.0.1', () => {
      const addr = stub.address() as AddressInfo
      stubUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
}

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  await startStub()

  const [r] = await t.db.insert(schema.region).values({ code: 'ws-r', displayName: 'WS R' }).returning()
  regionId = r!.id
  const [o] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'ws.svc', code: 'ws-svc', displayName: 'Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = o!.id
  const mk = async (email: string, role: string, oid: string) => {
    const [row] = await t.db
      .insert(schema.teammate)
      .values({ entraOid: oid, email, role, regionId, orgUnitId: ouId })
      .returning()
    return row!.id
  }
  platformId = await mk('ws-pa@x.test', 'platform-admin', 'oid-ws-pa')
  finopsId = await mk('ws-fin@x.test', 'global-finops', 'oid-ws-fin')
  adminId = await mk('ws-admin@x.test', 'admin', 'oid-ws-admin')
  devId = await mk('ws-dev@x.test', 'developer', 'oid-ws-dev')
}, 180_000)

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  await stopTestDb(t)
})

async function expectStatus(e: Parameters<typeof handler>[0], status: number) {
  await expect(handler(e)).rejects.toMatchObject({ statusCode: status })
}

/** How many times this endpoint has been audited so far, by phase. */
async function auditCounts(): Promise<{ attempted: number; completed: number }> {
  const rows = await t.db.execute<{ event_type: string; n: string }>(sql`
    SELECT event_type, count(*)::text AS n
      FROM audit_event
     WHERE event_type IN ('provider-wire-shape-probe-attempted', 'provider-wire-shape-probed')
     GROUP BY event_type
  `)
  const by = new Map([...rows].map((r) => [r.event_type, Number(r.n)]))
  return {
    attempted: by.get('provider-wire-shape-probe-attempted') ?? 0,
    completed: by.get('provider-wire-shape-probed') ?? 0,
  }
}

describe('nothing configured', () => {
  it('reports every surface as not-configured — a neutral state, not an error', async () => {
    const res = await handler(ev({ session: platform(), body: { mode: 'both' } }))
    expect(res.live).toHaveLength(5)
    expect(res.stored).toHaveLength(5)
    for (const s of [...res.live, ...res.stored]) {
      expect(s.status).toBe('not-configured')
      if (s.status === 'not-configured') expect(s.reason.length).toBeGreaterThan(0)
    }
  })

  it('audits the run with statuses and counts only', async () => {
    await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const rows = await t.db.execute<{ payload: Record<string, unknown>; actor_teammate_id: string }>(sql`
      SELECT payload, actor_teammate_id::text AS actor_teammate_id
        FROM audit_event
       WHERE event_type = 'provider-wire-shape-probed'
       ORDER BY ts_recorded DESC
       LIMIT 1
    `)
    const row = [...rows][0]
    expect(row).toBeDefined()
    expect(row!.actor_teammate_id).toBe(platformId)
    expect(row!.payload.mode).toBe('stored')
    expect(row!.payload.outcome).toBe('completed')
    expect(Array.isArray(row!.payload.surfaces)).toBe(true)
  })

  it('records the ATTEMPT before doing the work, not only the outcome after it', async () => {
    // An outcome-only audit is written by code that may never run: throw between
    // the provider call and the write, or fail the write itself, and a privileged
    // outbound action leaves no trace it was ever made.
    const before = await auditCounts()
    await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const after = await auditCounts()
    expect(after.attempted).toBe(before.attempted + 1)
    expect(after.completed).toBe(before.completed + 1)

    const rows = await t.db.execute<{ payload: Record<string, unknown>; actor_teammate_id: string }>(sql`
      SELECT payload, actor_teammate_id::text AS actor_teammate_id
        FROM audit_event
       WHERE event_type = 'provider-wire-shape-probe-attempted'
       ORDER BY ts_recorded DESC
       LIMIT 1
    `)
    const row = [...rows][0]
    expect(row).toBeDefined()
    expect(row!.actor_teammate_id).toBe(platformId)
    // The attempt names WHAT was about to be done — mode and day — so an
    // attempt with no matching outcome is readable on its own.
    expect(row!.payload.phase).toBe('attempt')
    expect(row!.payload.mode).toBe('stored')
    expect(typeof row!.payload.day).toBe('string')
  })
})

describe('GitHub Copilot stored payloads', () => {
  beforeAll(async () => {
    await t.db.insert(schema.providerEnterprise).values({
      provider: 'github',
      externalId: 'ws-ent',
      displayName: 'WS Enterprise',
    })
    /*
     * The shape github.ts writes into reconciliation_record.raw for the ai_credit
     * lane: { login, licenseOrg, periodDate, category, items }.
     *
     * The category is `copilot_interactive` — normaliseSeatDay emits one line per
     * categoriseSku result, and that function returns only copilot_interactive or
     * copilot_coding_agent. This fixture previously said 'ai_credits', a value no
     * writer in the codebase produces; a fixture that does not match the writer
     * cannot prove anything about a reader.
     */
    await t.db.insert(schema.reconciliationRecord).values({
      provider: 'github',
      enterpriseRef: 'ws-ent',
      periodDate: '2026-07-30',
      category: 'copilot_interactive',
      actualUsd: '1.000000',
      otelAttributedUsd: '0.000000',
      deltaUsd: '1.000000',
      spendClass: 'billed',
      disposition: 'matched',
      raw: {
        login: 'octocat',
        licenseOrg: 'ws-org',
        periodDate: '2026-07-30',
        category: 'copilot_interactive',
        items: [
          { product: 'copilot', sku: 'ai_credits', model: 'gpt-5-mini', unitType: 'ai-credits', grossQuantity: 4, netAmount: 0.04 },
        ],
      },
    })

    /*
     * TWO decoys, each carrying a marker key that exists nowhere else, so a scan
     * that reads them is caught by name rather than by a count.
     *
     * 1. A SECOND enterprise. The probe reports one enterprise by slug; without an
     *    enterprise_ref filter this tenant's shape is summarised and attributed to
     *    the one named in the report. (`zz-` sorts after `ws-`, so the probe still
     *    selects ws-ent.)
     */
    await t.db.insert(schema.providerEnterprise).values({
      provider: 'github',
      externalId: 'zz-other-ent',
      displayName: 'Some other enterprise',
    })
    await t.db.insert(schema.reconciliationRecord).values({
      provider: 'github',
      enterpriseRef: 'zz-other-ent',
      periodDate: '2026-07-30',
      category: 'copilot_interactive',
      actualUsd: '2.000000',
      otelAttributedUsd: '0.000000',
      deltaUsd: '2.000000',
      spendClass: 'billed',
      disposition: 'matched',
      raw: { login: 'someone-else', periodDate: '2026-07-30', items: [{ other_tenant_marker: 'x' }] },
    })
    /*
     * 2. A different LANE on the SAME enterprise that also stores an `items` array.
     *    `jsonb_typeof(raw->'items') = 'array'` does not discriminate between
     *    endpoints, so without a category filter a second endpoint's rows join this
     *    surface's summary and every path in it becomes true of *something*.
     */
    await t.db.insert(schema.reconciliationRecord).values({
      provider: 'github',
      enterpriseRef: 'ws-ent',
      periodDate: '2026-07-30',
      category: 'model_tokens',
      actualUsd: '3.000000',
      otelAttributedUsd: '0.000000',
      deltaUsd: '3.000000',
      spendClass: 'billed',
      disposition: 'matched',
      raw: { periodDate: '2026-07-30', items: [{ other_lane_marker: 'x' }] },
    })

    /*
     * The APP-MODE payload, on the SAME enterprise and the SAME category.
     *
     * normaliseMetricsCreditLine (github.ts:213) writes
     * `{ login, periodDate, credits, record }` where `record` is ONE per-user
     * NDJSON line — not the PAT shape's `items` array — and it writes
     * category 'copilot_interactive', the same lane the PAT writer uses. So the
     * two shapes are separable ONLY by payload, which is what the two readers
     * do; a reader that branched on today's credential kind would miss whichever
     * mode the estate has since switched away from.
     *
     * Dated relative to now rather than pinned, so this fixture cannot quietly
     * age out of the default 30-day window and take its assertions with it.
     */
    await t.db.insert(schema.reconciliationRecord).values({
      provider: 'github',
      enterpriseRef: 'ws-ent',
      periodDate: RECENT_DAY,
      category: 'copilot_interactive',
      actualUsd: '0.125000',
      otelAttributedUsd: '0.000000',
      deltaUsd: '0.125000',
      spendClass: 'indicative',
      disposition: 'unmatched',
      raw: {
        login: 'metricsuser',
        periodDate: RECENT_DAY,
        credits: 12.5,
        record: {
          user_login: 'metricsuser',
          user_id: 4242,
          day: RECENT_DAY,
          ai_credits_used: 12.5,
          // Undeclared by UserMetricsRecordSchema and kept by its .passthrough().
          ai_adoption_phase: 'power_user',
        },
      },
    })
    // The tenant decoy again, in the App shape this time: without enterprise_ref
    // this record would be summarised and attributed to ws-ent.
    await t.db.insert(schema.reconciliationRecord).values({
      provider: 'github',
      enterpriseRef: 'zz-other-ent',
      periodDate: RECENT_DAY,
      category: 'copilot_interactive',
      actualUsd: '0.500000',
      otelAttributedUsd: '0.000000',
      deltaUsd: '0.500000',
      spendClass: 'indicative',
      disposition: 'unmatched',
      raw: {
        login: 'someone-else',
        periodDate: RECENT_DAY,
        credits: 50,
        record: { user_login: 'someone-else', other_tenant_metrics_marker: 'x' },
      },
    })
  })

  it('scans only the probed enterprise and only the AI-credit lane', async () => {
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const gh = res.stored.find((s) => s.id === 'github-ai-credit-usage')!
    if (gh.status !== 'ok') throw new Error('expected ok')
    const paths = gh.summary.paths.map((p) => p.path)
    expect(paths).not.toContain('usageItems[].other_tenant_marker')
    expect(paths).not.toContain('usageItems[].other_lane_marker')
    // Exactly the one item from the probed enterprise's AI-credit lane.
    expect(gh.summary.itemCount).toBe(1)
    // ...and the scan states which rows it read, so the scoping is checkable.
    expect(gh.scan.filter).toContain('enterprise_ref')
    expect(gh.scan.filter).toContain('copilot_interactive')
  })

  it('summarises Copilot usage items under usageItems[], matching the live baseline vocabulary', async () => {
    // The stored payload has no HTTP envelope, so the rows are wrapped to line up
    // with the LIVE baseline's paths — one baseline serves both modes, which is
    // what makes the live/stored delta readable.
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const gh = res.stored.find((s) => s.id === 'github-ai-credit-usage')!
    expect(gh.status).toBe('ok')
    if (gh.status !== 'ok') return
    expect(gh.summary.itemsPath).toBe('usageItems[]')
    expect(gh.summary.itemCount).toBe(1)
    const model = gh.summary.paths.find((p) => p.path === 'usageItems[].model')!
    expect(model.present).toBe(1)
    expect(model.total).toBe(1)
    expect(model.distinctValues).toEqual(['gpt-5-mini'])
    expect(gh.scan.source).toBe('reconciliation_record.raw')
    // The login rides on the stored payload and must not survive into the report.
    expect(JSON.stringify(gh)).not.toContain('octocat')
  })

  it('reads the App-mode payload on its own surface, and neither surface claims the other', async () => {
    /*
     * The gap this closes: the stored scan read `raw->'items'` only, so an
     * App-mode estate — which is what our own Dev environment runs — saw zero
     * rows for Copilot even with a full ledger, because its writer stores one
     * `record` object per row and never an `items` array.
     */
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const app = res.stored.find((s) => s.id === 'github-user-daily-credits')!
    if (app.status !== 'ok') throw new Error('expected ok')
    expect(app.summary.itemsPath).toBe('ndjson_records[]')
    expect(app.summary.itemCount).toBe(1)
    const credits = app.summary.paths.find((p) => p.path === 'ndjson_records[].ai_credits_used')!
    expect(credits.present).toBe(1)
    // The other tenant's App-shape row is excluded by enterprise_ref, and the
    // PAT-shape rows by payload — this surface summarises one shape, one tenant.
    const appPaths = app.summary.paths.map((p) => p.path)
    expect(appPaths).not.toContain('ndjson_records[].other_tenant_metrics_marker')
    expect(appPaths).not.toContain('ndjson_records[].sku')
    expect(app.scan.filter).toContain("raw->'record'")
    // Identity on the record never survives into the report.
    expect(JSON.stringify(app)).not.toContain('metricsuser')

    // ...and the PAT surface is unmoved by the App rows sitting beside it.
    const pat = res.stored.find((s) => s.id === 'github-ai-credit-usage')!
    if (pat.status !== 'ok') throw new Error('expected ok')
    expect(pat.summary.itemCount).toBe(1)
    expect(pat.summary.paths.map((p) => p.path)).toContain('usageItems[].sku')
  })

  it('reports the App record field our schema never declared', async () => {
    // The question the surface exists to ask. UserMetricsRecordSchema declares
    // four fields and is .passthrough(), so anything else the wire carries lands
    // here — which is how a `model` dimension would announce itself if one exists.
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const app = res.stored.find((s) => s.id === 'github-user-daily-credits')!
    if (app.status !== 'ok') throw new Error('expected ok')
    expect(app.undeclared.kind).toBe('undeclared-by-schema')
    expect(app.undeclared.paths).toContain('ndjson_records[].ai_adoption_phase')
    // And the stored mode is faithful here: nothing on this row path strips.
    expect(app.unobservable.paths).toEqual([])
  })

  it('says whether a zero-row scan means no rows exist or none matched', async () => {
    /*
     * A live run reported rowsScanned: 0 for the GitHub stored scan and there was
     * no way to tell "Copilot wrote nothing" from "the probed enterprise_ref is
     * not the one the rows carry". Those need opposite responses and looked
     * identical. The unfiltered counts are the difference.
     *
     * First, the matched case: rows exist for this enterprise, and this surface's
     * shape matched some of them.
     */
    const matched = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const app = matched.stored.find((s) => s.id === 'github-user-daily-credits')!
    if (app.status !== 'ok') throw new Error('expected ok')
    expect(app.scan.rowsScanned).toBe(1)
    // The provider total exceeds the probed enterprise's — the other tenant's rows
    // are visible as a separate number rather than folded into one figure.
    expect(app.scan.unfiltered!.rowsForProvider).toBeGreaterThan(app.scan.unfiltered!.rowsForEnterprise)
    // ...and the enterprise holds MORE rows than this shape matched, which is the
    // reading "this enterprise reconciles partly through the other mode".
    expect(app.scan.unfiltered!.rowsForEnterprise).toBeGreaterThan(app.scan.rowsScanned)

    /*
     * Now the unmatched case. An enterprise that sorts first and holds nothing
     * becomes the probed one, so both GitHub scans read zero — and the counts say
     * WHY: rows exist for the provider, none of them under this enterprise_ref.
     * Registered and removed inside this test so the surrounding fixtures, which
     * depend on ws-ent being selected, are untouched.
     */
    await t.db.insert(schema.providerEnterprise).values({
      provider: 'github',
      externalId: 'aa-empty-ent',
      displayName: 'Registered, never reconciled',
    })
    try {
      const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
      for (const id of ['github-ai-credit-usage', 'github-user-daily-credits'] as const) {
        const s = res.stored.find((x) => x.id === id)!
        if (s.status !== 'ok') throw new Error(`expected ok for ${id}`)
        expect(s.scan.rowsScanned).toBe(0)
        expect(s.scan.unfiltered!.rowsForEnterprise).toBe(0)
        // The distinguishing fact: the window is NOT empty for this provider.
        expect(s.scan.unfiltered!.rowsForProvider).toBeGreaterThan(0)
        expect(s.scan.unfiltered!.note.length).toBeGreaterThan(0)
      }
    } finally {
      await t.db.execute(sql`DELETE FROM provider_enterprise WHERE provider = 'github' AND external_id = 'aa-empty-ent'`)
    }
  })
})

describe('with an Enterprise Analytics org configured', () => {
  beforeAll(async () => {
    process.env.NUXT_ANTHROPIC_API_ENDPOINT = stubUrl
    process.env.NUXT_ANTHROPIC_KEY_WS_TEST = 'sk-ant-stub-key-value-0123456789'
    await t.db.insert(schema.providerOrg).values({
      provider: 'anthropic',
      externalOrgId: 'org-stub',
      displayName: 'Stub org',
      apiKind: 'enterprise-analytics',
      credentialSecretName: 'ws-test',
    })
    // One stored payload in the poller's own format: usage rows AND cost rows,
    // the cost rows carrying a `model` our CostRow schema never declared.
    await t.db.insert(schema.actualSpend).values({
      teammateId: devId,
      date: '2026-07-30',
      tool: 'claude-code',
      inputTokens: 10n,
      outputTokens: 5n,
      costUsd: '0.010000',
      source: 'anthropic-analytics-api:org-stub',
      rawPayload: {
        day: '2026-07-30',
        usage: [
          { actor: { type: 'user_actor', email: 'someone@example.test' }, product: 'claude_code', model: 'claude-opus-4', total_tokens: 15 },
        ],
        cost: [
          {
            actor: { type: 'user_actor', email: 'someone@example.test' },
            amount: '1.25',
            currency: 'USD',
            cost_type: 'tokens',
            token_type: 'output',
            product: 'claude_code',
            model: 'claude-opus-4',
            context_window: '0-200k',
            speed: 'standard',
            rbac_group_id: 'g-1',
          },
        ],
      },
    })
    // A SECOND in-window payload, so the row cap can be tested on both sides of
    // its boundary: exactly-at-limit (exhaustive) and over-limit (a prefix).
    // Deliberately carries no cost rows, so the cost-surface assertions above
    // still see exactly one row.
    await t.db.insert(schema.actualSpend).values({
      teammateId: devId,
      date: '2026-07-29',
      tool: 'claude-code',
      inputTokens: 4n,
      outputTokens: 2n,
      costUsd: '0.004000',
      source: 'anthropic-analytics-api:org-stub',
      rawPayload: {
        day: '2026-07-29',
        usage: [{ actor: { type: 'user_actor' }, product: 'claude_code', model: 'claude-sonnet-4', total_tokens: 6 }],
        cost: [],
      },
    })
  })

  it('stored scan reports the undeclared cost-row fields — the fields we receive and ignore', async () => {
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const cost = res.stored.find((s) => s.id === 'anthropic-enterprise-user-cost')!
    expect(cost.status).toBe('ok')
    if (cost.status !== 'ok') return
    expect(cost.undeclared.kind).toBe('undeclared-by-schema')
    /*
     * THE PREDICTION THIS FEATURE EXISTED TO SETTLE IS SETTLED, AND FIXED.
     *
     * `group_by[]` asked for the model on BOTH reports and only UsageRow
     * declared it, so the cost report's model arrived undeclared — carried into
     * actual_spend.raw_payload by `.passthrough()` alone while the model axis
     * was built from OTel instead (task #32). CostRow declares it now, so it
     * must NOT be in this list; if anyone removes the declaration it reappears
     * here and this goes red, which is the point of asserting the absence rather
     * than deleting the line.
     *
     * The three below are still genuinely undeclared, so the assertion is not
     * vacuously satisfied by an empty list.
     */
    expect(cost.undeclared.paths).not.toContain('data[].model')
    /*
     * `context_window` moved lists the same way `model` did, one task later:
     * W0a (mig 0127) requests it in group_by on BOTH reports and CostRow /
     * UsageRow declare it, so it must NOT be reported as undeclared any more.
     * If anyone removes the declaration (or its baseline transcription) it
     * reappears here and this goes red.
     */
    expect(cost.undeclared.paths).not.toContain('data[].context_window')
    expect(cost.undeclared.paths).toContain('data[].speed')
    expect(cost.undeclared.paths).toContain('data[].rbac_group_id')
    // ...with the number that makes it actionable. Declaring the field changed
    // which LIST it appears in, not whether the probe still observes it: the
    // shape summary must keep reporting the dimension and its counts.
    const model = cost.summary.paths.find((p) => p.path === 'data[].model')!
    expect(model.present).toBe(1)
    expect(model.total).toBe(1)
    expect(model.distinctValues).toEqual(['claude-opus-4'])
  })

  it('stored scan states its bound rather than silently truncating', async () => {
    // Two in-window rows; a cap of one leaves a row unread.
    const res = await handler(ev({ session: platform(), body: { mode: 'stored', storedRowLimit: 1 } }))
    const usage = res.stored.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    if (usage.status !== 'ok') throw new Error('expected ok')
    expect(usage.scan.rowLimit).toBe(1)
    expect(usage.scan.rowsScanned).toBe(1)
    expect(usage.scan.capped).toBe(true)
    expect(usage.scan.source).toBe('actual_spend.raw_payload')
  })

  it('a scan that read EXACTLY the cap is exhaustive, and does not claim truncation', async () => {
    /*
     * Two in-window rows and a cap of two: the scan saw everything there was.
     * `rows.length === rowLimit` cannot tell that apart from a truncated read, so
     * this case used to be reported as a prefix — sending the operator to look for
     * data that was already all in front of them, on the one report whose only job
     * is to say what was and was not observed. Answered by asking the database for
     * rowLimit + 1 and letting the discarded row be the evidence.
     */
    const res = await handler(ev({ session: platform(), body: { mode: 'stored', storedRowLimit: 2 } }))
    const usage = res.stored.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    if (usage.status !== 'ok') throw new Error('expected ok')
    expect(usage.scan.rowsScanned).toBe(2)
    expect(usage.scan.rowLimit).toBe(2)
    expect(usage.scan.capped).toBe(false)
  })

  it('names the subtrees the stored mode cannot see into, rather than letting silence read as absence', async () => {
    /*
     * The poller stores the PARSED payload. Where the schema is .passthrough()
     * that is faithful; inside a plain z.object it is not, and an empty
     * "undeclared" list under one of those is evidence about our parser only.
     */
    const res = await handler(ev({ session: platform(), body: { mode: 'stored' } }))
    const usage = res.stored.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    const cost = res.stored.find((s) => s.id === 'anthropic-enterprise-user-cost')!
    if (usage.status !== 'ok' || cost.status !== 'ok') throw new Error('expected ok')
    // UsageRow is passthrough; its nested cache_creation object is not.
    expect(usage.unobservable.paths).toEqual(['data[].cache_creation'])
    expect(usage.unobservable.note).toContain('DISCARDS unknown fields')
    // CostRow and Actor are both passthrough — nothing is hidden, and the report
    // says so positively rather than by omission.
    expect(cost.unobservable.paths).toEqual([])
    expect(cost.unobservable.note).toContain('passthrough')
  })

  it('live probe summarises the usage report and surfaces data_refreshed_at', async () => {
    stubRequests = []
    const res = await handler(ev({ session: platform(), body: { mode: 'live', day: '2026-07-30' } }))
    const usage = res.live.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    expect(usage.status).toBe('ok')
    if (usage.status !== 'ok') return
    expect(usage.summary.itemCount).toBe(2)
    const model = usage.summary.paths.find((p) => p.path === 'data[].model')!
    expect(model.present).toBe(2)
    expect(model.total).toBe(2)
    expect(model.distinctValues).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    // data_refreshed_at is parsed on this report and has never been read.
    expect(usage.freshness?.dataRefreshedAt).toBe('2099-01-01T00:00:00Z')
    expect(usage.freshness?.coversWindow).toBe(true)
    // The probe asked for the same window+dimensions the poller asks for.
    const asked = stubRequests.find((u) => u.includes('user_usage_report'))!
    // Bracket notation, unencoded key — the form enterprise-client.ts builds.
    expect(asked).toContain('group_by[]=product')
    expect(asked).toContain('group_by[]=model')
    expect(asked).toContain('starting_at=2026-07-30T00%3A00%3A00Z')
    // ...and reports it back, with nothing identifying in the params.
    expect(usage.request.params.some(([k, v]) => k === 'group_by[]' && v === 'model')).toBe(true)
  })

  it('a failing surface reports the RAW provider error and does not take the others down', async () => {
    const res = await handler(ev({ session: platform(), body: { mode: 'live', day: '2026-07-30' } }))
    const cost = res.live.find((s) => s.id === 'anthropic-enterprise-user-cost')!
    expect(cost.status).toBe('errored')
    if (cost.status !== 'errored') return
    expect(cost.error.status).toBe(400)
    // Verbatim, not classified: the message is the only thing that says why.
    expect(cost.error.bodyText).toContain('stub refuses the cost report')
    // The sibling surface still succeeded in the same run.
    expect(res.live.find((s) => s.id === 'anthropic-enterprise-user-usage')!.status).toBe('ok')
    // A variant this environment does not use stays neutral.
    expect(res.live.find((s) => s.id === 'anthropic-admin-claude-code')!.status).toBe('not-configured')
  })

  it('the stored scan honours its date window — an old payload is not silently pulled in', async () => {
    // A row well outside the window, carrying a key that appears nowhere else.
    // Without the date bound the scan would reach back over the whole table and
    // report this field as though it were current.
    await t.db.insert(schema.actualSpend).values({
      teammateId: devId,
      date: '2026-01-05',
      tool: 'claude-code',
      inputTokens: 1n,
      outputTokens: 1n,
      costUsd: '0.001000',
      source: 'anthropic-analytics-api:org-stub',
      rawPayload: {
        day: '2026-01-05',
        usage: [{ actor: { type: 'user_actor' }, ancient_marker_field: 'x' }],
        cost: [],
      },
    })
    const inside = await handler(ev({ session: platform(), body: { mode: 'stored', storedWindowDays: 30 } }))
    const usage = inside.stored.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    if (usage.status !== 'ok') throw new Error('expected ok')
    expect(usage.summary.paths.map((p) => p.path)).not.toContain('data[].ancient_marker_field')

    // Widen past the row's age and it does appear — proving the exclusion above
    // was the window doing its job, not the row being unreadable.
    const outside = await handler(ev({ session: platform(), body: { mode: 'stored', storedWindowDays: 365 } }))
    const wide = outside.stored.find((s) => s.id === 'anthropic-enterprise-user-usage')!
    if (wide.status !== 'ok') throw new Error('expected ok')
    expect(wide.summary.paths.map((p) => p.path)).toContain('data[].ancient_marker_field')
  })

  it('no identifying value from any payload reaches the response, live or stored', async () => {
    const res = await handler(ev({ session: platform(), body: { mode: 'both', day: '2026-07-30' } }))
    const json = JSON.stringify(res)
    expect(json).not.toContain('someone@example.test')
    expect(json).not.toContain('other@example.test')
    expect(json).not.toContain('u-1')
    expect(json).not.toContain('g-1')
    // The credential is never echoed either.
    expect(json).not.toContain('sk-ant-stub-key-value-0123456789')
  })
})

/*
 * The GitHub credential KIND picks which of the two Copilot surfaces is live,
 * exactly as github.ts's adapter branches on `credential.kind === 'github-app'`.
 * Both modes are legitimate deployments, so the unused one must read as the same
 * NEUTRAL 'not-configured' the unused Anthropic api_kind variant reads as — never
 * as a failure, and never with a reason that describes a call that did not happen.
 *
 * Neither test issues a network call: the PAT case stops on the missing login
 * mapping, and the App case stops at GithubAppAuth's construction-time key
 * assertion. Configuration is applied and removed per test so the fixtures either
 * side, which depend on ws-ent having no credential, are untouched.
 */
describe('GitHub credential mode decides which surface is probed', () => {
  async function withGithubCredential(
    cfg: { secretName: string; appId: string | null; env: Record<string, string> },
    fn: () => Promise<void>,
  ): Promise<void> {
    for (const [k, v] of Object.entries(cfg.env)) process.env[k] = v
    await t.db.execute(sql`
      UPDATE provider_enterprise
         SET credential_secret_name = ${cfg.secretName}, github_app_id = ${cfg.appId}
       WHERE provider = 'github' AND external_id = 'ws-ent'
    `)
    try {
      await fn()
    } finally {
      // Emptied rather than deleted (a dynamic `delete` is banned by lint). The
      // restore that matters is the column below: with credential_secret_name
      // NULL the resolver never reads these env keys at all, and an empty value
      // is falsy on the one path that would.
      for (const k of Object.keys(cfg.env)) process.env[k] = ''
      await t.db.execute(sql`
        UPDATE provider_enterprise SET credential_secret_name = NULL, github_app_id = NULL
         WHERE provider = 'github' AND external_id = 'ws-ent'
      `)
    }
  }

  const surface = (res: Awaited<ReturnType<typeof handler>>, id: string) => res.live.find((s) => s.id === id)!

  it('PAT mode probes ai_credit/usage and reports the metrics report as simply not in use', async () => {
    await withGithubCredential(
      { secretName: 'ws-ent-pat', appId: null, env: { NUXT_GITHUB_PAT_WS_ENT_PAT: 'ghp_stub_value_0123456789' } },
      async () => {
        const res = await handler(ev({ session: platform(), body: { mode: 'live', day: '2026-07-30' } }))

        const app = surface(res, 'github-user-daily-credits')
        expect(app.status).toBe('not-configured')
        if (app.status !== 'not-configured') return
        expect(app.reason).toContain('PAT mode')
        // The reason names a CONFIGURATION, not an outcome. "the call failed" and
        // "this is not the path in use" are different facts and only one is true.
        expect(app.reason).toContain('not the read surface in use')
        expect(app.reason).toContain('Nothing was called and nothing failed')

        // Its sibling IS the surface in use, and gets as far as needing a login —
        // it stops on the missing mapping, not on the credential mode.
        const pat = surface(res, 'github-ai-credit-usage')
        expect(pat.status).toBe('not-configured')
        if (pat.status !== 'not-configured') return
        expect(pat.reason).toContain('teammate_identity_map')
      },
    )
  })

  it('App mode probes the metrics report and reports ai_credit/usage as simply not in use', async () => {
    await withGithubCredential(
      {
        secretName: 'ws-ent-app',
        appId: '424242',
        // Valid base64, not a PEM: GithubAppAuth asserts the key at CONSTRUCTION,
        // so the App surface fails there and no request is ever made.
        env: { NUXT_GITHUB_APP_KEY_WS_ENT_APP: Buffer.from('not-a-pem').toString('base64') },
      },
      async () => {
        const res = await handler(ev({ session: platform(), body: { mode: 'live', day: '2026-07-30' } }))

        const pat = surface(res, 'github-ai-credit-usage')
        expect(pat.status).toBe('not-configured')
        if (pat.status !== 'not-configured') return
        expect(pat.reason).toContain('App mode')
        expect(pat.reason).toContain('not the read surface in use')
        expect(pat.reason).toContain('Nothing was called and nothing failed')
        /*
         * The reason this wording had to change. It used to say per-user
         * ai_credit/usage is unreachable by an App token — a claim about a call
         * we do not make, in a mode where this is simply the wrong surface. The
         * reachability of that endpoint is not what makes this surface inactive;
         * the credential kind is.
         */
        expect(pat.reason).not.toContain('not reachable')

        /*
         * ...and the App surface is the one that was actually attempted. It
         * errors on the key, which also pins SURFACE ISOLATION: GithubAppAuth
         * asserts the PEM at construction, so building the client outside the
         * probe's try/catch let that throw escape and 500 the whole report —
         * every other surface included. Caught here, not in review.
         */
        const app = surface(res, 'github-user-daily-credits')
        expect(app.status).toBe('errored')
        // The other surfaces all still reported — that is the isolation claim.
        expect(res.live).toHaveLength(5)
        expect(surface(res, 'anthropic-enterprise-user-usage').status).toBe('ok')
      },
    )
  })
})

/*
 * RBAC, DELIBERATELY LAST.
 *
 * Running these before anything was configured made them unfalsifiable: with no
 * provider_org and no enterprise there was no work for an unauthorised caller to
 * reach, so moving the gate to AFTER the probing would have left every one of
 * them green. They therefore run here, with a live-capable Anthropic org and a
 * GitHub enterprise already registered, and ask for `mode: 'both'` — the mode
 * that spends provider budget — then assert on the two observable consequences a
 * bypass would have: the stub is asked for nothing, and nothing is audited.
 */
describe('RBAC — platform-admin only, and the gate runs BEFORE any work', () => {
  const spendingBody = { mode: 'both' as const, day: '2026-07-30' }

  async function expectRejectedWithoutWorking(
    e: Parameters<typeof handler>[0],
    status: number,
  ): Promise<void> {
    stubRequests = []
    const before = await auditCounts()
    await expectStatus(e, status)
    // No provider call was issued on a rejected request...
    expect(stubRequests).toEqual([])
    // ...and no audit row was written for it, of either phase.
    expect(await auditCounts()).toEqual(before)
  }

  it('rejects a developer', async () => {
    await expectRejectedWithoutWorking(ev({ session: dev(), body: spendingBody }), 403)
  })

  it('rejects a region admin', async () => {
    await expectRejectedWithoutWorking(ev({ session: admin(), body: spendingBody }), 403)
  })

  it('rejects global-finops — this endpoint is a tier above the rest of diagnostics', async () => {
    // The other diagnostics reads allow global-finops. This one returns raw
    // provider error bodies and spends provider budget, so it sits with
    // network.get.ts / otel-logs.get.ts at platform-admin.
    await expectRejectedWithoutWorking(ev({ session: finops(), body: spendingBody }), 403)
  })

  it('rejects a cross-origin POST even from a platform-admin', async () => {
    await expectRejectedWithoutWorking(
      ev({ session: platform(), body: spendingBody, origin: 'https://evil.test' }),
      403,
    )
  })

  it('rejects an invalid day before spending anything on it', async () => {
    await expectRejectedWithoutWorking(
      ev({ session: platform(), body: { mode: 'both', day: '30-07-2026' } }),
      400,
    )
  })

  it('and the same request from a platform-admin DOES reach the provider', async () => {
    // The control. Without it every assertion above is satisfied by an endpoint
    // that never calls anyone, and none of them would notice.
    stubRequests = []
    const before = await auditCounts()
    await handler(ev({ session: platform(), body: spendingBody }))
    expect(stubRequests.some((u) => u.includes('user_usage_report'))).toBe(true)
    const after = await auditCounts()
    expect(after.attempted).toBe(before.attempted + 1)
    expect(after.completed).toBe(before.completed + 1)
  })
})
