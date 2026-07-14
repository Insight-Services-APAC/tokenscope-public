// @vitest-environment node
/*
 * §A slice 2 — tagging a per-day "unaccounted usage" record + the needs-tagging list
 * union. Mirrors the session-assign contract: ownership + membership gate, then set the
 * project/activity tag. docs/design/provider-billing-attribution-model.md §A.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession, type Session } from '../../helpers/auth'
import * as schema from '../../../drizzle/schema'
import assignHandler from '../../../server/api/v1/me/unaccounted/[id]/assign.post'

let t: TestDb
let regionId = ''
let orgUnitId = ''
let teammateId = ''
let projectId = ''
let foreignProjectId = ''

function ev(opts: { session: Session; id: string; body?: unknown }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450', 'content-type': 'application/json' }
  const e = {
    method: 'POST', path: '/x', context: { params: { id: opts.id } },
    node: {
      req: { method: 'POST', url: '/x', body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return headers } },
      res: {
        _headers: {} as Record<string, string | string[]>, statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as unknown as Parameters<typeof assignHandler>[0]
}
const sess = (): Session => ({ teammateId, email: 'ua@x.test', displayName: 'UA', role: 'developer', regionId, orgPath: 'ua' })

async function mkRecord(): Promise<string> {
  const [r] = await t.db.insert(schema.unaccountedUsage).values({
    teammateId, regionId, orgUnitId, day: '2026-06-10', tool: 'claude-code', costUsd: '15.000000', source: 'api-reconciled',
  }).returning({ id: schema.unaccountedUsage.id })
  return r!.id
}

beforeAll(async () => {
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.db.insert(schema.region).values({ code: 'ua', displayName: 'UA' }).returning(); regionId = r!.id
  const [ou] = await t.db.insert(schema.orgUnit).values({ regionId, path: 'ua', code: 'ua-bu', displayName: 'UA', unitType: 'bu', isCostOwningUnit: true }).returning(); orgUnitId = ou!.id
  const [tm] = await t.db.insert(schema.teammate).values({ entraOid: 'oid-ua', email: 'ua@x.test', regionId, orgUnitId }).returning(); teammateId = tm!.id
  const [p] = await t.db.insert(schema.project).values({ code: 'UA-P', codeHash: 'h-ua-p', displayName: 'UA P', type: 'billable', regionId, costOwningUnitId: orgUnitId }).returning(); projectId = p!.id
  const [fp] = await t.db.insert(schema.project).values({ code: 'UA-F', codeHash: 'h-ua-f', displayName: 'UA F', type: 'billable', regionId, costOwningUnitId: orgUnitId }).returning(); foreignProjectId = fp!.id
  // The dev is a member of projectId only (not foreignProjectId).
  await t.client`INSERT INTO project_assignment (project_id, teammate_id, effective) VALUES (${projectId}::uuid, ${teammateId}::uuid, tstzrange(now() - interval '1 day', NULL))`
}, 180_000)

afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)
beforeEach(async () => { await t.client`DELETE FROM unaccounted_usage WHERE teammate_id = ${teammateId}::uuid` })

describe('unaccounted assign (§A slice 2)', () => {
  it('tags a record to a project the dev is a member of', async () => {
    const id = await mkRecord()
    const res = (await assignHandler(ev({ session: sess(), id, body: { project_id: projectId, activity: 'research' } }))) as { tagged: boolean }
    expect(res.tagged).toBe(true)
    const [row] = await t.client<{ project_id: string; activity: string; tagged_by: string }[]>`
      SELECT project_id::text AS project_id, activity, tagged_by::text AS tagged_by FROM unaccounted_usage WHERE id = ${id}::uuid`
    expect(row!.project_id).toBe(projectId)
    expect(row!.activity).toBe('research')
    expect(row!.tagged_by).toBe(teammateId)
  })

  it('rejects a project the dev is NOT a member of (403)', async () => {
    const id = await mkRecord()
    await expect(assignHandler(ev({ session: sess(), id, body: { project_id: foreignProjectId } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it("rejects a record that isn't the caller's (404)", async () => {
    await expect(assignHandler(ev({ session: sess(), id: randomUUID(), body: { project_id: projectId } }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('project_id:null moves it back to needs-tagging (untag)', async () => {
    const id = await mkRecord()
    await assignHandler(ev({ session: sess(), id, body: { project_id: projectId } }))
    await assignHandler(ev({ session: sess(), id, body: { project_id: null } }))
    const [row] = await t.client<{ project_id: string | null }[]>`SELECT project_id::text AS project_id FROM unaccounted_usage WHERE id = ${id}::uuid`
    expect(row!.project_id).toBeNull()
  })
})
