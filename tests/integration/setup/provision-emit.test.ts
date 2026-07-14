// @vitest-environment node
/*
 * provision_emit (MCP tool) + the /api/v1/setup/redeem endpoint — integration.
 *
 * The two-leg, secret-isolating device-provisioning flow (mcp-client-backbone
 * §"One auth → also provisions the device"):
 *
 *   1. provision_emit (read-scoped MCP tool, driven over the SDK's in-memory
 *      transport exactly like mcp-tools.test.ts) — locates-or-creates the
 *      instance_attestation from the BEARER teammate and returns ONLY a short-TTL
 *      handoff code + redeem URL. NEVER the durable emit refresh token.
 *   2. /setup/redeem (direct h3 handler, the local helper's process→server call)
 *      — redeems the handoff for the durable emit credential + the OTel bundle.
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). Harness mirrors
 * tests/integration/mcp/mcp-tools.test.ts (tools) + setup/enrolment.test.ts
 * (h3 endpoint + OAuth-bearer assertions).
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import type { BearerTeammate } from '../../../server/auth/oauth-bearer'
import { requireOAuthBearer } from '../../../server/auth/oauth-bearer'
import { refreshAccessToken } from '../../../server/auth/oauth'
import { createMcpServer } from '../../../server/utils/mcp'
import redeemHandler from '../../../server/api/v1/setup/redeem.post'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string
let otherTeammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'provision-test-padded-to-thirty-two-chars!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'provision-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db.insert(schema.region).values({ code: 'pe', displayName: 'PE Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'pe.svc', code: 'pe-svc', displayName: 'PE Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'pe-oid-1', email: 'pe-user@example.com', displayName: 'PE User', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  teammateId = tm!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'pe-oid-2', email: 'pe-other@example.com', displayName: 'PE Other', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  otherTeammateId = other!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── helpers (mirrors mcp-tools.test.ts) ───────────────────────────────────────

function bearerTeammate(opts: { teammateId: string; scope?: string }): BearerTeammate {
  return {
    teammateId: opts.teammateId,
    email: 'pe-user@example.com',
    displayName: 'PE User',
    role: 'developer',
    regionId,
    scope: opts.scope ?? 'tokenscope.read tokenscope.tag',
  }
}

async function connectClient(teammate: BearerTeammate): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
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

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content
  return JSON.parse(content.find((c) => c.type === 'text')!.text)
}
const isErr = (res: unknown) => (res as { isError?: boolean }).isError === true
const errText = (res: unknown) => (res as { content: Array<{ text: string }> }).content[0]!.text

async function callProvision(client: Client, instanceId?: string) {
  return client.callTool({
    name: 'provision_emit',
    arguments: instanceId ? { instance_id: instanceId } : {},
  })
}
async function provision(client: Client, instanceId?: string) {
  const res = await callProvision(client, instanceId)
  return { res, body: parseToolJson(res) }
}

/** A bodied POST h3 event for the redeem endpoint (mirrors enrolment.test.ts). */
function ev(body: unknown) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  return {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body,
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
}
async function redeem(body: unknown) {
  return redeemHandler(ev(body) as unknown as Parameters<typeof redeemHandler>[0])
}
function bearerEvFor(token: string) {
  return {
    node: {
      req: { method: 'GET', url: '/x', headers: { authorization: `Bearer ${token}`, host: 'localhost:3450' } },
      res: {
        _headers: {} as Record<string, string>,
        statusCode: 200,
        getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {},
        get headersSent() { return false },
      },
    },
  }
}

// ── provision_emit (the read-scoped MCP tool) ─────────────────────────────────

describe('provision_emit MCP tool', () => {
  it('is listed alongside the other tools', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { tools } = await client.listTools()
    expect(tools.map((x) => x.name)).toContain('provision_emit')
    await client.close()
  })

  it('creates the instance_attestation and returns a handoff — NOT the durable refresh token', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { body } = await provision(client)

    // Handoff shape.
    expect(body.handoff_code).toMatch(/.{20,}/)
    expect(body.redeem_url).toBe('/api/v1/setup/redeem')
    expect(body.expires_in).toBe(300)
    expect(typeof body.instance_id).toBe('string')

    // HARD INVARIANT: the durable emit secret is NEVER in the tool response.
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(/refresh_token/i)
    expect(serialized).not.toMatch(/oauth_refresh/i)
    expect(serialized).not.toMatch(/OTEL_/)

    // The attestation exists, is owned by the teammate, unassigned + live, with
    // the bearer-derived principal/region/org (NOT a setup token).
    const att = await t.client<{
      teammate_id: string; state: string; oid: string; region_id: string; org_unit_id: string; project_code_hash: string | null; ts_actual_end: Date | null
    }[]>`
      SELECT teammate_id::text AS teammate_id, attestation_state AS state, principal_oid AS oid,
             region_id::text AS region_id, org_unit_id::text AS org_unit_id,
             project_code_hash, ts_actual_end
        FROM instance_attestation WHERE instance_id = ${body.instance_id as string}::uuid`
    expect(att[0]).toMatchObject({
      teammate_id: teammateId, state: 'unassigned', oid: 'pe-oid-1',
      region_id: regionId, org_unit_id: ouId, project_code_hash: null, ts_actual_end: null,
    })

    // The handoff row stores only a HASH (never the raw code) and is unconsumed.
    const ho = await t.client<{ code_hash: string; consumed_at: Date | null }[]>`
      SELECT code_hash, consumed_at FROM emit_handoff WHERE instance_id = ${body.instance_id as string}::uuid`
    expect(ho).toHaveLength(1)
    expect(ho[0]!.code_hash).not.toBe(body.handoff_code)
    expect(ho[0]!.consumed_at).toBeNull()
    await client.close()
  })

  it('is idempotent for a repeated instance_id — reuses the instance, no unbounded creds/handoffs', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const first = await provision(client)
    const id = first.body.instance_id as string

    // Re-provision the SAME id three more times.
    await provision(client, id)
    await provision(client, id)
    const last = await provision(client, id)
    expect(last.body.instance_id).toBe(id) // same device reused

    // Exactly ONE attestation for that id.
    const atts = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE instance_id = ${id}::uuid`
    expect(Number(atts[0]!.n)).toBe(1)

    // At most ONE still-redeemable (unconsumed, unexpired) handoff for that id —
    // prior handoffs were rotated out (revoked) on each re-provision.
    const live = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM emit_handoff
       WHERE instance_id = ${id}::uuid AND consumed_at IS NULL AND expires_at > now()`
    expect(Number(live[0]!.n)).toBe(1)
    await client.close()
  })

  it('a supplied instance_id owned by ANOTHER teammate is NOT adopted — a fresh instance is minted', async () => {
    // other teammate provisions → gets an instance id.
    const otherClient = await connectClient(bearerTeammate({ teammateId: otherTeammateId, scope: 'tokenscope.read' }))
    const otherProv = await provision(otherClient)
    const otherId = otherProv.body.instance_id as string
    await otherClient.close()

    // teammateId tries to reuse other's id → must mint a DIFFERENT instance.
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { body } = await provision(client, otherId)
    expect(body.instance_id).not.toBe(otherId)
    // other's attestation is untouched (still owned by other).
    const own = await t.client<{ teammate_id: string }[]>`
      SELECT teammate_id::text AS teammate_id FROM instance_attestation WHERE instance_id = ${otherId}::uuid`
    expect(own[0]!.teammate_id).toBe(otherTeammateId)
    await client.close()
  })

  it('is REJECTED for an emit-only bearer (the isolation invariant — read→emit is one-way)', async () => {
    const client = await connectClient(bearerTeammate({ teammateId, scope: 'tokenscope.emit' }))
    // The scope gate fires in withTeammate BEFORE any provisioning code runs, so
    // no attestation/handoff is created — count handoffs across the reject call.
    const before = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM emit_handoff`
    const res = await callProvision(client) // do NOT parse — the error body is not JSON
    expect(isErr(res)).toBe(true)
    expect(errText(res)).toContain('tokenscope.read')
    const after = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM emit_handoff`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n)) // rejected path writes nothing
    await client.close()
  })
})

// ── /api/v1/setup/redeem (the local helper's process→server call) ─────────────

describe('setup/redeem endpoint', () => {
  async function freshHandoff() {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { body } = await provision(client)
    await client.close()
    return body as { instance_id: string; handoff_code: string }
  }

  it('redeems a valid handoff → durable emit credential + a well-formed OTel bundle', async () => {
    const { instance_id, handoff_code } = await freshHandoff()
    const out = (await redeem({ handoff_code, instance_id })) as {
      instance_id: string
      oauth_refresh_token: string
      oauth_token_endpoint: string
      oauth_client_id: string
      unassigned: boolean
      telemetry: { claude: Record<string, string> }
    }

    expect(out.instance_id).toBe(instance_id)
    expect(out.oauth_refresh_token).toMatch(/.{20,}/)
    expect(out.oauth_token_endpoint).toContain('/api/v1/oauth/token')
    expect(out.oauth_client_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.unassigned).toBe(true)

    // OTel bundle mirrors setup/exchange exactly.
    const c = out.telemetry.claude
    expect(c.OTEL_LOGS_EXPORTER).toBe('otlp')
    expect(c.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL).toBe('http/protobuf')
    expect(c.otel_headers_helper_url).toContain(`/api/v1/instances/${instance_id}/bearer`)
    expect(c.OTEL_RESOURCE_ATTRIBUTES).toContain(`tokenscope.instance_id=${instance_id}`)
    expect(c.OTEL_RESOURCE_ATTRIBUTES).toContain('tool=claude-code')
    // unassigned device → no project.code_hash in the attrs.
    expect(c.OTEL_RESOURCE_ATTRIBUTES).not.toContain('project.code_hash')
  })

  it('the minted emit credential is EMIT-scoped ONLY (no read/tag/widening) and bound to the instance', async () => {
    const { instance_id, handoff_code } = await freshHandoff()
    const out = (await redeem({ handoff_code })) as { oauth_refresh_token: string; oauth_client_id: string }

    // The refresh_token grant yields a tokenscope.emit-only access token.
    const refreshed = await refreshAccessToken(t.db as never, out.oauth_refresh_token, out.oauth_client_id)
    expect(refreshed.scope).toBe('tokenscope.emit')

    // It validates as an emit bearer, and is REJECTED where read is required.
    const tm = await requireOAuthBearer(bearerEvFor(refreshed.access_token) as never, 'tokenscope.emit', t.db as never)
    expect(tm.teammateId).toBe(teammateId)
    await expect(
      requireOAuthBearer(bearerEvFor(refreshed.access_token) as never, 'tokenscope.read', t.db as never),
    ).rejects.toMatchObject({ statusCode: 401 })

    // The oauth_token row carries the instance binding (mig 0031).
    const rows = await t.client<{ instance_id: string | null; scope: string }[]>`
      SELECT instance_id::text AS instance_id, scope FROM oauth_token
       WHERE instance_id = ${instance_id}::uuid AND revoked_at IS NULL`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ instance_id, scope: 'tokenscope.emit' })
  })

  it('re-provision + redeem rotates the prior emit credential — only ONE live per instance', async () => {
    const client = await connectClient(bearerTeammate({ teammateId }))
    const first = await provision(client)
    const id = first.body.instance_id as string
    await redeem({ handoff_code: first.body.handoff_code as string })

    // Re-provision the same device and redeem again.
    const second = await provision(client, id)
    await redeem({ handoff_code: second.body.handoff_code as string })
    await client.close()

    // Exactly ONE live emit credential for the instance; the prior is revoked.
    const live = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM oauth_token
       WHERE instance_id = ${id}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(Number(live[0]!.n)).toBe(1)
    const revoked = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM oauth_token
       WHERE instance_id = ${id}::uuid AND revoked_at IS NOT NULL`
    expect(Number(revoked[0]!.n)).toBeGreaterThanOrEqual(1)
  })

  it('rejects an unknown handoff (401)', async () => {
    await expect(redeem({ handoff_code: 'no-such-handoff-code-value-1234567890' })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an already-used handoff — single-use (401 on the second redeem)', async () => {
    const { handoff_code } = await freshHandoff()
    await redeem({ handoff_code }) // first succeeds
    await expect(redeem({ handoff_code })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an expired handoff (401)', async () => {
    const { handoff_code } = await freshHandoff()
    // Force-expire it.
    await t.client.unsafe(
      `UPDATE emit_handoff SET expires_at = now() - interval '1 minute' WHERE consumed_at IS NULL`,
    )
    await expect(redeem({ handoff_code })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an instance_id that does not match the handoff binding (401)', async () => {
    const { handoff_code } = await freshHandoff()
    await expect(redeem({ handoff_code, instance_id: randomUUID() })).rejects.toMatchObject({ statusCode: 401 })
  })

  it('sets Cache-Control: no-store on the response', async () => {
    const { handoff_code } = await freshHandoff()
    const e = ev({ handoff_code })
    await redeemHandler(e as unknown as Parameters<typeof redeemHandler>[0])
    const cc = (e as { node: { res: { _headers: Record<string, string | string[]> } } }).node.res._headers['cache-control']
    expect(cc).toBe('no-store')
  })
})
