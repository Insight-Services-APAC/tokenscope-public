// @vitest-environment node
/*
 * Synthetic-data emitter — happy path.
 *
 * Spins up the test DB, mocks the fake-azure-monitor stub with a tiny
 * in-process http server, calls emitTick, asserts:
 *   - the POST envelopes match the project_assignment fan-out,
 *   - instance_attestation rows landed for each assignment,
 *   - the joiner wrote one attribution_record per span,
 *   - reusing the session map skips re-INSERT.
 *
 * This guards the integration boundary that the dev sweep relies on:
 * project_assignment → instance_attestation → /admin/ingest → joiner →
 * attribution_record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { emitTick } from '../../../scripts/emit-data'
import { LocalCollectorReader } from '../../../server/azure/reader'

interface IngestEnvelope {
  session_id: string
  spans: Array<{
    tokens: number
    tokenType: string
    model: string
    tsEvent: string
    sourceRunId?: string
  }>
}

let t: TestDb
let stub: Server
let endpoint: string
const spansBySession = new Map<string, IngestEnvelope['spans']>()
const captured: IngestEnvelope[] = []

beforeAll(async () => {
  t = await startTestDb()

  // Minimal world: region + bu + practice + two teammates + two
  // projects + two assignments. The rate_card is provided by migration
  // 0004_default_rate_card.sql.
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES
      ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'apac', 'APAC');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit) VALUES
      ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'apac.services'::ltree, 'svcs', 'APAC Services', 'bu', TRUE),
      ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
       'apac.services.delta'::ltree, 'delta', 'Practice Delta', 'practice', TRUE);
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'oid-priya', 'priya@x.com',
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
    INSERT INTO project (id, code, code_hash, display_name, type, region_id, cost_owning_unit_id) VALUES
      ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'TEST-AAA', 'h-test-aaa', 'Test AAA',
       'billable', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
      ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'TEST-BBB', 'h-test-bbb', 'Test BBB',
       'billable', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
    INSERT INTO project_assignment (project_id, teammate_id, effective) VALUES
      ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
       '[2026-01-01, 2099-01-01)'::tstzrange),
      ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'dddddddd-dddd-dddd-dddd-dddddddddddd',
       '[2026-01-01, 2099-01-01)'::tstzrange);
  `)

  // Tiny in-process stub mirroring tools/fake-azure-monitor's POST
  // /admin/ingest + GET /v1/sessions/:id/spans surface — enough for
  // emitTick + the joiner's reader.
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'POST' && url.pathname === '/admin/ingest') {
      let buf = ''
      req.on('data', (c) => (buf += c))
      req.on('end', () => {
        const body = JSON.parse(buf) as IngestEnvelope
        captured.push(body)
        const list = spansBySession.get(body.session_id) ?? []
        list.push(...body.spans)
        spansBySession.set(body.session_id, list)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/sessions/')) {
      const m = /^\/v1\/sessions\/([^/]+)\/usage$/.exec(url.pathname)
      if (m) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ session_id: m[1], usage: spansBySession.get(m[1]!) ?? [] }))
        return
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const addr = stub.address() as AddressInfo
  endpoint = `http://127.0.0.1:${addr.port}`
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()))
  await stopTestDb(t)
}, 30_000)

describe('emitTick', () => {
  it('fan-out: 1 POST + 1 instance_attestation row per (teammate, project) assignment', async () => {
    const reader = new LocalCollectorReader(endpoint)
    const result = await emitTick(t.db, reader, endpoint)

    // Two assignments → two sessions, two POSTs.
    expect(result.sessionsCreated).toBe(2)
    expect(captured.length).toBe(2)
    expect(result.spansEmitted).toBe(result.sessionsCreated * 12)

    // instance_attestation has matching rows tagged with 'claude-code'.
    const sessions = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation WHERE tool = 'claude-code'
    `
    expect(Number(sessions[0]!.count)).toBe(2)

    // The joiner wrote one attribution_record per span (the seeded
    // rate_card covers input/output/cache_read/cache_write wildcards).
    expect(result.joinerResult.attributionRowsWritten).toBe(result.spansEmitted)
    expect(result.joinerResult.spansSkippedNoRateCard).toBe(0)

    const rows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM attribution_record
    `
    expect(Number(rows[0]!.count)).toBe(result.spansEmitted)
  })

  it('reuseSessions: second tick keeps the same session_id, does not re-INSERT', async () => {
    const reader = new LocalCollectorReader(endpoint)
    const sessions = new Map<string, string>()

    const r1 = await emitTick(t.db, reader, endpoint, { reuseSessions: sessions })
    expect(sessions.size).toBe(2)
    const firstIds = new Set(sessions.values())

    const r2 = await emitTick(t.db, reader, endpoint, { reuseSessions: sessions })
    expect(sessions.size).toBe(2)
    expect(new Set(sessions.values())).toEqual(firstIds)

    // First tick added two new instance_attestation rows; the second
    // reused them and added zero. (The fan-out test above already
    // created two; r1 + r2 inside this test add the two reused ones.)
    const sessionRows = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation WHERE tool = 'claude-code'
    `
    expect(Number(sessionRows[0]!.count)).toBe(4) // 2 from prior test + 2 reused

    // Both ticks succeeded.
    expect(r1.spansEmitted).toBe(r2.spansEmitted)
  })

  it('POST-before-INSERT: a failing stub leaves no orphan instance_attestation row', async () => {
    const reader = new LocalCollectorReader(endpoint)
    const before = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation
    `
    // Must reject with a postSpans error specifically — not e.g. a
    // loadAssignments error that would also satisfy `.rejects.toBeTruthy()`.
    await expect(emitTick(t.db, reader, 'http://127.0.0.1:1')).rejects.toThrow(
      /fake-azure-monitor|ECONNREFUSED|fetch failed/i,
    )
    const after = await t.client<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM instance_attestation
    `
    expect(after[0]!.count).toBe(before[0]!.count)
  })
})
