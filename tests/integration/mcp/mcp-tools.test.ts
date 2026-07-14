// @vitest-environment node
/*
 * TokenScope MCP server — integration coverage.
 *
 * Two layers (mirroring how the MCP surface is actually reached):
 *
 *   1. Tool data correctness + per-tool scope, exercised through the real MCP
 *      protocol: an in-memory Client/Server pair (the SDK's InMemoryTransport)
 *      drives list_my_projects / list_activity_types / my_usage. We inject the
 *      authenticated `BearerTeammate` the same way the HTTP endpoint does —
 *      packed into req.auth.extra.teammate, here via a per-message authInfo on
 *      the client transport. This proves the tools return the RIGHT teammate's
 *      data and scope-gate correctly.
 *
 *   2. HTTP auth gating at the endpoint, exercised through the OAuth flow + the
 *      h3 event harness from oauth-flow.test.ts: no/invalid bearer → 401 with a
 *      WWW-Authenticate resource_metadata pointer (RFC 9728); a token missing
 *      `tokenscope.read` → 403 insufficient_scope.
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). The DB harness is
 * modelled on tests/integration/oauth/oauth-flow.test.ts.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import type { Session } from '../../../server/utils/auth'
import type { BearerTeammate } from '../../../server/auth/oauth-bearer'
import { createMcpServer } from '../../../server/utils/mcp'

import registerHandler from '../../../server/api/v1/oauth/register.post'
import authorizePostHandler from '../../../server/api/v1/oauth/authorize.post'
import tokenHandler from '../../../server/api/v1/oauth/token.post'
import mcpHandler from '../../../server/api/v1/mcp/[...]'
import { issueEmitCredential } from '../../../server/auth/emit-credential'
import { refreshAccessToken } from '../../../server/auth/oauth'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string
let otherTeammateId: string
let projectId: string

const REDIRECT_URI = 'http://localhost:43117/callback'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'mcp-test-padded-to-thirty-two-chars!!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'mcp-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'mc', displayName: 'MCP Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'mc.svc',
      code: 'mc-svc',
      displayName: 'MC Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'mc-oid-1',
      email: 'mcp-user@example.com',
      displayName: 'MCP User',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  teammateId = tm!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'mc-oid-2',
      email: 'mcp-other@example.com',
      displayName: 'MCP Other',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  otherTeammateId = other!.id

  // A project the MCP user is assigned to (attributable). codeHash/type are NOT
  // NULL-able; values are arbitrary for the read-path test.
  const [p] = await t.db
    .insert(schema.project)
    .values({
      code: 'MCP-ALPHA',
      codeHash: createHash('sha256').update('MCP-ALPHA').digest('hex'),
      displayName: 'MCP Alpha',
      type: 'client',
      regionId,
      costOwningUnitId: ouId,
      allocationMode: 'shared_pool',
    })
    .returning()
  projectId = p!.id

  // Active assignment (effective covers now) — this is the membership the tools read.
  await t.db.execute(sql`
    INSERT INTO project_assignment (project_id, teammate_id, effective)
    VALUES (${projectId}::uuid, ${teammateId}::uuid, tstzrange(now() - interval '1 day', NULL, '[)'))
  `)
  // A baseline allocation for the project pool (shared_pool: teammate_id NULL).
  // allocation.audit_event_id is a NOT NULL FK → seed an audit_event first.
  const [auditEv] = await t.db
    .insert(schema.auditEvent)
    .values({ eventType: 'allocation_seed', payload: {} })
    .returning()
  await t.db.execute(sql`
    INSERT INTO allocation (scope_type, scope_id, budget_usd, effective, allocation_kind, audit_event_id)
    VALUES ('project', ${projectId}::uuid, 250.00,
            tstzrange(date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', '[)'),
            'baseline', ${auditEv!.id}::uuid)
  `)
  // A region-scoped activity type + a global one.
  await t.db
    .insert(schema.activityType)
    .values([
      { regionId: null, label: 'coding', isStandard: true, sortOrder: 1 },
      { regionId, label: 'mcp-region-task', isStandard: false, sortOrder: 2 },
    ])
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── helpers ─────────────────────────────────────────────────────────────────

type AnyHandler = (e: unknown) => Promise<unknown>

function bearerTeammate(opts: {
  teammateId: string
  scope?: string
}): BearerTeammate {
  return {
    teammateId: opts.teammateId,
    email: 'mcp-user@example.com',
    displayName: 'MCP User',
    role: 'developer',
    regionId,
    scope: opts.scope ?? 'tokenscope.read tokenscope.emit',
  }
}

/**
 * Spin up an in-memory MCP Client wired to the TokenScope server, with the given
 * teammate packed into authInfo on every outbound message — the same authInfo
 * the HTTP endpoint sets on req.auth. Returns the connected client.
 */
async function connectClient(teammate: BearerTeammate): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  // Inject authInfo on every client→server message (the in-memory transport
  // forwards options.authInfo to the server's onmessage extra, which the SDK
  // surfaces to tools as extra.authInfo). Mirrors req.auth.extra.teammate.
  const authInfo: AuthInfo = {
    token: '',
    clientId: 'tokenscope',
    scopes: teammate.scope.split(' ').filter(Boolean),
    extra: { teammate },
  }
  const originalSend = clientTransport.send.bind(clientTransport)
  clientTransport.send = (message: JSONRPCMessage, options?: Record<string, unknown>) =>
    originalSend(message, { ...(options ?? {}), authInfo })

  const server = createMcpServer(t.db as never)
  await server.connect(serverTransport)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(clientTransport)
  return client
}

function parseToolJson(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text: string }> }).content
  const text = content.find((c) => c.type === 'text')!.text
  return JSON.parse(text)
}

// ── Layer 1: tools (in-memory protocol) ──────────────────────────────────────

describe('MCP tools (authed, in-memory protocol)', () => {
  it('exposes the read tools + the tag_session write tool + provision_emit', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { tools } = await client.listTools()
    expect(tools.map((x) => x.name).sort()).toEqual([
      'list_activity_types',
      'list_my_projects',
      'my_usage',
      'provision_emit',
      'resolve_repo_project',
      'tag_session',
    ])
    await client.close()
  })

  it('list_my_projects returns the caller’s memberships', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({ name: 'list_my_projects', arguments: {} })
    const body = parseToolJson(res) as { projects: Array<{ code: string; display_name: string }> }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]!.code).toBe('MCP-ALPHA')
    expect(body.projects[0]!.display_name).toBe('MCP Alpha')
    await client.close()
  })

  it('list_my_projects is empty for a teammate with no assignments', async () => {
    const client = await connectClient(bearerTeammate({ teammateId: otherTeammateId }))
    const res = await client.callTool({ name: 'list_my_projects', arguments: {} })
    const body = parseToolJson(res) as { projects: unknown[] }
    expect(body.projects).toHaveLength(0)
    await client.close()
  })

  it('list_activity_types returns global + region-scoped tags', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({ name: 'list_activity_types', arguments: {} })
    const body = parseToolJson(res) as { activity_types: Array<{ label: string }> }
    const labels = body.activity_types.map((a) => a.label)
    // All-lowercase vocabulary entries are title-cased for display.
    expect(labels).toContain('Coding')
    expect(labels).toContain('Mcp-Region-Task')
    await client.close()
  })

  it('list_activity_types surfaces the caller OWN used tags first (their casing), deduping standards', async () => {
    // The teammate has used 'Research' (collides with the seeded standard 'research')
    // twice and 'WorkIQ' once — across distinct sessions.
    await t.db.insert(schema.sessionAssignment).values([
      { claudeSessionId: 'at-sess-1', teammateId, projectId: null, activity: 'Research' },
      { claudeSessionId: 'at-sess-2', teammateId, projectId: null, activity: 'Research' },
      { claudeSessionId: 'at-sess-3', teammateId, projectId: null, activity: 'WorkIQ' },
    ])
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({ name: 'list_activity_types', arguments: {} })
    const body = parseToolJson(res) as {
      activity_types: Array<{ label: string; is_mine: boolean; is_standard: boolean }>
    }
    const labels = body.activity_types.map((a) => a.label)
    // Mine come first, most-used first, in MY casing.
    expect(labels.slice(0, 2)).toEqual(['Research', 'WorkIQ'])
    expect(body.activity_types[0]).toMatchObject({ label: 'Research', is_mine: true })
    // 'WorkIQ' keeps its intentional casing (not title-cased to 'Workiq').
    expect(labels).toContain('WorkIQ')
    // The seeded standard 'research' is deduped against my 'Research' — appears once.
    expect(labels.filter((l) => l.toLowerCase() === 'research')).toEqual(['Research'])
    // A standard I have NOT used is title-cased + flagged not-mine.
    const doc = body.activity_types.find((a) => a.label === 'Documentation')
    expect(doc).toMatchObject({ is_mine: false, is_standard: true })
    await client.close()
  })

  it('my_usage returns the current-month bucket for the assigned project', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({ name: 'my_usage', arguments: {} })
    const body = parseToolJson(res) as {
      month_to_date: string
      total_allocation_usd: string
      buckets: Array<{ project_code: string; allocation_total_usd: string; source: string }>
    }
    expect(body.month_to_date).toMatch(/^\d{4}-\d{2}$/)
    expect(body.buckets).toHaveLength(1)
    expect(body.buckets[0]!.project_code).toBe('MCP-ALPHA')
    expect(body.buckets[0]!.source).toBe('assigned')
    expect(Number(body.buckets[0]!.allocation_total_usd)).toBe(250)
    expect(Number(body.total_allocation_usd)).toBe(250)
    await client.close()
  })

  it('a token missing tokenscope.read is rejected by the tool (insufficient_scope)', async () => {
    const client = await connectClient(
      bearerTeammate({ teammateId, scope: 'tokenscope.emit' }),
    )
    const res = await client.callTool({ name: 'list_my_projects', arguments: {} })
    expect((res as { isError?: boolean }).isError).toBe(true)
    const text = (res as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('tokenscope.read')
    await client.close()
  })

  it('resolve_repo_project resolves a member budget by code', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({
      name: 'resolve_repo_project',
      arguments: { code: 'MCP-ALPHA' },
    })
    const body = parseToolJson(res) as {
      resolved: boolean
      project?: { id: string; code: string; display_name: string; type: string }
    }
    expect(body.resolved).toBe(true)
    expect(body.project).toMatchObject({
      id: projectId,
      code: 'MCP-ALPHA',
      display_name: 'MCP Alpha',
      type: 'client',
    })
    await client.close()
  })

  it('resolve_repo_project resolves a member budget by code_hash', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const codeHash = createHash('sha256').update('MCP-ALPHA').digest('hex')
    const res = await client.callTool({
      name: 'resolve_repo_project',
      arguments: { code_hash: codeHash },
    })
    const body = parseToolJson(res) as { resolved: boolean; project?: { code: string } }
    expect(body.resolved).toBe(true)
    expect(body.project?.code).toBe('MCP-ALPHA')
    await client.close()
  })

  it('resolve_repo_project returns resolved:false for a non-member code (no existence oracle)', async () => {
    // The caller is NOT assigned to this project → must look identical to an
    // unknown code: resolved:false, no project leaked.
    await t.db.insert(schema.project).values({
      code: 'MCP-OUTSIDER',
      codeHash: createHash('sha256').update('MCP-OUTSIDER').digest('hex'),
      displayName: 'Outsider',
      type: 'billable',
      regionId,
      costOwningUnitId: ouId,
      allocationMode: 'shared_pool',
    })
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({
      name: 'resolve_repo_project',
      arguments: { code: 'MCP-OUTSIDER' },
    })
    const body = parseToolJson(res) as { resolved: boolean; project?: unknown }
    expect(body.resolved).toBe(false)
    expect(body.project).toBeUndefined()
    await client.close()
  })

  it('resolve_repo_project returns resolved:false for an unknown code', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({
      name: 'resolve_repo_project',
      arguments: { code: 'NO-SUCH-CODE' },
    })
    const body = parseToolJson(res) as { resolved: boolean }
    expect(body.resolved).toBe(false)
    await client.close()
  })

  it('resolve_repo_project errors when given neither code nor code_hash', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const res = await client.callTool({ name: 'resolve_repo_project', arguments: {} })
    expect((res as { isError?: boolean }).isError).toBe(true)
    await client.close()
  })

  it('resolve_repo_project is read-scope gated (a non-read credential is rejected)', async () => {
    const client = await connectClient(bearerTeammate({ teammateId, scope: 'tokenscope.emit' }))
    const res = await client.callTool({
      name: 'resolve_repo_project',
      arguments: { code: 'MCP-ALPHA' },
    })
    expect((res as { isError?: boolean }).isError).toBe(true)
    const text = (res as { content: Array<{ text: string }> }).content[0]!.text
    expect(text).toContain('tokenscope.read')
    await client.close()
  })
})

describe('MCP prompts (skills)', () => {
  const PROMPT_NAMES = ['tokenscope-setup', 'tag', 'project', 'usage']

  it('lists the four TokenScope skill prompts', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual([...PROMPT_NAMES].sort())
    // Every prompt carries a human-readable description.
    for (const p of prompts) expect(p.description && p.description.length).toBeGreaterThan(0)
    await client.close()
  })

  it('each prompt returns non-empty instruction text', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    for (const name of PROMPT_NAMES) {
      // Pass an empty arguments object — prompts that declare an argsSchema
      // require `arguments` to be present even when every field is optional.
      const res = await client.getPrompt({ name, arguments: {} })
      const msg = res.messages[0]!
      expect(msg.role).toBe('user')
      const content = msg.content as { type: string; text: string }
      expect(content.type).toBe('text')
      expect(content.text.length).toBeGreaterThan(200)
      // The instruction text names the TokenScope tools the skill drives.
      expect(content.text).toMatch(/tokenscope|my_usage|list_my_projects|tag_session/i)
    }
    await client.close()
  })

  it('appends an optional arg AFTER the instructions (prompt-injection-safe)', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const baseline = await client.getPrompt({ name: 'tag', arguments: {} })
    const baseText = (baseline.messages[0]!.content as { text: string }).text
    const withArg = await client.getPrompt({
      name: 'tag',
      arguments: { session_id: 'sess-xyz-123' },
    })
    const argText = (withArg.messages[0]!.content as { text: string }).text
    // The base instructions are unchanged; the arg is appended at the end.
    expect(argText.startsWith(baseText)).toBe(true)
    expect(argText.endsWith('Session id provided: sess-xyz-123')).toBe(true)
    await client.close()
  })
})

describe('MCP tag_session (write tool)', () => {
  const TAG_SCOPE = 'tokenscope.read tokenscope.tag'
  const errText = (res: unknown) => (res as { content: Array<{ text: string }> }).content[0]!.text
  const isErr = (res: unknown) => (res as { isError?: boolean }).isError === true

  // Seed an UNALLOCATED conversation owned by `teammateId` (as the joiner would).
  async function seedOwnedSession(conv: string) {
    const inst = randomUUID()
    await t.client.unsafe(`
      INSERT INTO instance_attestation (instance_id, principal_oid, principal_email, teammate_id, tool, session_token_hash, ts_start, region_id, org_unit_id, attestation_state)
      VALUES ('${inst}','oid-mcp-tag','mcp-tag@x.test','${teammateId}','claude-code','tok-${inst}', now(), '${regionId}','${ouId}','unassigned')`)
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.attributionRecord).values({
      instanceId: inst, claudeSessionId: conv, teammateId, projectId: null, regionId, orgUnitId: ouId,
      costOwningUnitId: null, tool: 'claude-code', model: 'claude-sonnet-4-6', tokenType: 'output', tokens: 1000n,
      costUsd: '5.00', rateCardId: rc!.id, rateCardVersion: rc!.version, fidelityTier: 'tier-2', costBasis: 'telemetry-only', tsEvent: new Date(),
    })
  }

  it('tags an owned session with a budget + activity (with tokenscope.tag)', async () => {
    // Claude session ids are UUIDs (audit_event.subject_id is a uuid column).
    const CONV = '1a111111-1111-4111-8111-111111111111'
    await seedOwnedSession(CONV)
    const client = await connectClient(bearerTeammate({ teammateId, scope: TAG_SCOPE }))
    const res = await client.callTool({
      name: 'tag_session',
      arguments: { session_id: CONV, project_id: projectId, activity: 'Research' },
    })
    expect(parseToolJson(res)).toMatchObject({ assigned: true, project_id: projectId, activity: 'Research' })
    const rows = await t.client.unsafe(
      `SELECT project_id::text, activity FROM session_assignment WHERE claude_session_id='${CONV}' AND teammate_id='${teammateId}'`,
    )
    expect(rows[0]).toMatchObject({ project_id: projectId, activity: 'Research' })
    await client.close()
  })

  it('tags a session whose id is NOT a uuid without aborting (audit subject_id guard)', async () => {
    // audit_event.subject_id is uuid; a non-uuid conversation id must NOT abort
    // the whole tag transaction (it's preserved in the audit payload instead).
    const CONV = 'claude-sess-not-a-uuid-xyz'
    await seedOwnedSession(CONV)
    const client = await connectClient(bearerTeammate({ teammateId, scope: TAG_SCOPE }))
    const res = await client.callTool({ name: 'tag_session', arguments: { session_id: CONV, activity: 'Research' } })
    expect(parseToolJson(res)).toMatchObject({ assigned: true, activity: 'Research' })
    await client.close()
  })

  it('requires the tokenscope.tag scope — a read-only credential is rejected', async () => {
    const client = await connectClient(bearerTeammate({ teammateId, scope: 'tokenscope.read' }))
    const res = await client.callTool({ name: 'tag_session', arguments: { session_id: 'x', activity: 'Y' } })
    expect(isErr(res)).toBe(true)
    expect(errText(res)).toContain('tokenscope.tag')
    await client.close()
  })

  it('rejects a session the caller does not own (403 from the shared logic)', async () => {
    const client = await connectClient(bearerTeammate({ teammateId, scope: TAG_SCOPE }))
    const res = await client.callTool({ name: 'tag_session', arguments: { session_id: 'not-my-session', activity: 'Y' } })
    expect(isErr(res)).toBe(true)
    await client.close()
  })

  it('rejects assigning to a budget the caller is not a member of', async () => {
    const CONV = '2a222222-2222-4222-8222-222222222222'
    await seedOwnedSession(CONV)
    const [other] = await t.db
      .insert(schema.project)
      .values({
        code: 'MCP-NOPE', codeHash: createHash('sha256').update('MCP-NOPE').digest('hex'),
        displayName: 'Not Mine', type: 'billable', regionId, costOwningUnitId: ouId, allocationMode: 'shared_pool',
      })
      .returning()
    const client = await connectClient(bearerTeammate({ teammateId, scope: TAG_SCOPE }))
    const res = await client.callTool({ name: 'tag_session', arguments: { session_id: CONV, project_id: other!.id } })
    expect(isErr(res)).toBe(true)
    expect(errText(res)).toMatch(/member/i)
    await client.close()
  })
})

// ── Layer 2: HTTP endpoint auth gating (OAuth flow + h3 harness) ──────────────

type AnyHeaders = Record<string, string>

function ev(opts: {
  method?: string
  query?: Record<string, string>
  body?: unknown
  headers?: AnyHeaders
  session?: Session
}) {
  const headers: AnyHeaders = {
    host: 'localhost:3450',
    origin: 'http://localhost:3450',
    ...(opts.headers ?? {}),
  }
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : ''
  const url = '/x' + qs
  const method = opts.method ?? 'POST'
  const e = {
    method,
    path: url,
    context: { params: {} },
    node: {
      req: {
        method,
        url,
        body: opts.body,
        socket: { remoteAddress: '127.0.0.1' },
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        _body: '' as string,
        _ended: false,
        statusCode: 200,
        getHeader(n: string) {
          return this._headers[n.toLowerCase()]
        },
        setHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        removeHeader(n: string) {
          this._headers[n.toLowerCase()] = ''
        },
        appendHeader(n: string, v: string | string[]) {
          this._headers[n.toLowerCase()] = v
        },
        // The MCP Streamable HTTP transport writes through @hono/node-server,
        // which needs writeHead + a writable-stream-ish surface on the response.
        writeHead(status: number, headers?: Record<string, string | string[]>) {
          this.statusCode = status
          if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v)
          return this
        },
        flushHeaders() {
          return this
        },
        on() {
          return this
        },
        once() {
          return this
        },
        emit() {
          return false
        },
        write(chunk?: unknown) {
          if (chunk != null) this._body += String(chunk)
          return true
        },
        end(chunk?: unknown) {
          if (chunk != null) this._body += String(chunk)
          this._ended = true
          return this
        },
        get headersSent() {
          return this._ended
        },
      },
    },
  }
  if (opts.session)
    (e as { context: Record<string, unknown> }).context['__tokenscope_session'] = opts.session
  return e as unknown
}

async function call<R = unknown>(h: unknown, e: unknown): Promise<R> {
  return (h as AnyHandler)(e) as Promise<R>
}
function headerOf(e: unknown, name: string): string | string[] | undefined {
  return (e as { node: { res: { _headers: Record<string, string | string[]> } } }).node.res._headers[
    name.toLowerCase()
  ]
}

function makePkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

const userSession = (): Session =>
  ({
    teammateId,
    email: 'mcp-user@example.com',
    displayName: 'MCP User',
    role: 'developer',
    regionId,
    orgPath: 'mc.svc',
  }) as Session

async function mintAccessToken(scope: string): Promise<string> {
  const client = await call<{ client_id: string; client_secret: string }>(
    registerHandler,
    ev({ body: { client_name: 'MCP test', redirect_uris: [REDIRECT_URI] } }),
  )
  const { verifier, challenge } = makePkce()
  const state = randomBytes(8).toString('hex')
  const authEv = ev({
    method: 'POST',
    body: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      state,
      action: 'approve',
    },
    session: userSession(),
  })
  await call(authorizePostHandler, authEv)
  const loc = headerOf(authEv, 'location') as string
  const code = new URL(loc).searchParams.get('code')!
  const tok = await call<{ access_token: string }>(
    tokenHandler,
    ev({
      body: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
        client_id: client.client_id,
        client_secret: client.client_secret,
      },
    }),
  )
  return tok.access_token
}

describe('MCP endpoint auth gating', () => {
  it('no bearer → 401 with a resource_metadata WWW-Authenticate pointer', async () => {
    const e = ev({ method: 'POST', body: {} })
    await expect(call(mcpHandler, e)).rejects.toMatchObject({ statusCode: 401 })
    const wa = headerOf(e, 'www-authenticate') as string
    expect(wa).toContain('resource_metadata=')
    expect(wa).toContain('/.well-known/oauth-protected-resource')
  })

  it('invalid bearer → 401 with a resource_metadata WWW-Authenticate pointer', async () => {
    const e = ev({ method: 'POST', body: {}, headers: { authorization: 'Bearer not-a-real-token' } })
    await expect(call(mcpHandler, e)).rejects.toMatchObject({ statusCode: 401 })
    const wa = headerOf(e, 'www-authenticate') as string
    expect(wa).toContain('resource_metadata=')
  })

  it('valid token missing tokenscope.read → 403 insufficient_scope', async () => {
    // An emit-ONLY credential (emit isn't grantable via the interactive flow — R1
    // F1 — so mint it the legit way) must be rejected by the read-scoped MCP.
    const cred = await issueEmitCredential(t.db as never, teammateId)
    const refreshed = await refreshAccessToken(t.db as never, cred.tokens.refresh_token, cred.clientId)
    const token = refreshed.access_token
    const e = ev({ method: 'POST', body: {}, headers: { authorization: `Bearer ${token}` } })
    await expect(call(mcpHandler, e)).rejects.toMatchObject({ statusCode: 403 })
    const wa = headerOf(e, 'www-authenticate') as string
    expect(wa).toContain('insufficient_scope')
  })

  it('valid tokenscope.read token reaches the transport (no auth error)', async () => {
    const token = await mintAccessToken('tokenscope.read')
    // A well-formed JSON-RPC initialize request — the transport should handle it
    // and respond (status stays 200; no 401/403 thrown).
    const e = ev({
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
      },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'c', version: '1.0.0' },
        },
      },
    })
    await call(mcpHandler, e)
    const status = (e as { node: { res: { statusCode: number } } }).node.res.statusCode
    expect(status).not.toBe(401)
    expect(status).not.toBe(403)
  })
})
