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
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
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

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'pe', displayName: 'PE Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'pe.svc',
      code: 'pe-svc',
      displayName: 'PE Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'pe-oid-1',
      email: 'pe-user@example.com',
      displayName: 'PE User',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  teammateId = tm!.id
  const [other] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'pe-oid-2',
      email: 'pe-other@example.com',
      displayName: 'PE Other',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
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
    // Hand-built for the in-memory tool harness — not a real
    // requireOAuthBearer resolution, so there's no real oauth_token row to
    // report a binding/client from.
    instanceId: null,
    clientId: null,
  }
}

async function connectClient(teammate: BearerTeammate, publicOrigin?: string): Promise<Client> {
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

  const server = createMcpServer(t.db as never, publicOrigin)
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
        get headersSent() {
          return false
        },
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
      req: {
        method: 'GET',
        url: '/x',
        headers: { authorization: `Bearer ${token}`, host: 'localhost:3450' },
      },
      res: {
        _headers: {} as Record<string, string>,
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
    const att = await t.client<
      {
        teammate_id: string
        state: string
        oid: string
        region_id: string
        org_unit_id: string
        project_code_hash: string | null
        ts_actual_end: Date | null
      }[]
    >`
      SELECT teammate_id::text AS teammate_id, attestation_state AS state, principal_oid AS oid,
             region_id::text AS region_id, org_unit_id::text AS org_unit_id,
             project_code_hash, ts_actual_end
        FROM instance_attestation WHERE instance_id = ${body.instance_id as string}::uuid`
    expect(att[0]).toMatchObject({
      teammate_id: teammateId,
      state: 'unassigned',
      oid: 'pe-oid-1',
      region_id: regionId,
      org_unit_id: ouId,
      project_code_hash: null,
      ts_actual_end: null,
    })

    // The handoff row stores only a HASH (never the raw code) and is unconsumed.
    const ho = await t.client<{ code_hash: string; consumed_at: Date | null }[]>`
      SELECT code_hash, consumed_at FROM emit_handoff WHERE instance_id = ${body.instance_id as string}::uuid`
    expect(ho).toHaveLength(1)
    expect(ho[0]!.code_hash).not.toBe(body.handoff_code)
    expect(ho[0]!.consumed_at).toBeNull()
    await client.close()
  })

  it('addresses the handoff at the SERVER that minted it when the origin is known', async () => {
    // A handoff can only be redeemed at its issuer. Every other test in this
    // file constructs the server with no origin and asserts the RELATIVE
    // fallback, so deleting the origin argument from the real handler
    // (server/api/v1/mcp/[...].ts) would leave this suite entirely green while
    // reintroducing the wrong-server redemption the absolute URL exists to
    // prevent. This is the production-shaped case: an operator whose MCP server
    // is registered somewhere other than the plugin's baked default.
    const origin = 'https://tokenscope.example.test'
    const client = await connectClient(bearerTeammate({ teammateId }), origin)
    const { body } = await provision(client)

    expect(body.redeem_url).toBe(`${origin}/api/v1/setup/redeem`)

    // The generated command must carry the SAME origin. Asserting only on
    // redeem_url would miss a helper invocation still pointed at the default,
    // which is the half that actually transmits the code.
    const command = String(body.redeem_command ?? '')
    // The origin is passed as an sh POSITIONAL ("$2"), never interpolated into
    // the script body, so assert both halves: the script consumes a positional
    // as its api-base, and the origin is supplied as that positional.
    expect(command).toContain('--api-base "$2"')
    expect(command.trimEnd()).toMatch(new RegExp(`"${origin}"$`))
    // Vacuity guard: an empty origin would still satisfy a naive substring
    // check against a template that already mentions --api-base.
    expect(command).not.toMatch(/""\s*$/)
  })

  it('falls back to a relative redeem URL when the origin is NOT trustworthy', async () => {
    // Unpinned and not behind Front Door, the public origin is derived from the
    // caller's own Host header, so naming it as the destination for a one-time
    // secret would let a request nominate where that secret is sent. The
    // handler gates on isPublicOriginTrusted and passes undefined; the tool
    // must degrade rather than invent a host.
    const client = await connectClient(bearerTeammate({ teammateId }))
    const { body } = await provision(client)
    expect(body.redeem_url).toBe('/api/v1/setup/redeem')
    expect(String(body.redeem_command ?? '')).not.toContain('--api-base')
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
    const otherClient = await connectClient(
      bearerTeammate({ teammateId: otherTeammateId, scope: 'tokenscope.read' }),
    )
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
    const out = (await redeem({ handoff_code })) as {
      oauth_refresh_token: string
      oauth_client_id: string
    }

    // The refresh_token grant yields a tokenscope.emit-only access token.
    const refreshed = await refreshAccessToken(
      t.db as never,
      out.oauth_refresh_token,
      out.oauth_client_id,
    )
    expect(refreshed.scope).toBe('tokenscope.emit')

    // It validates as an emit bearer, and is REJECTED where read is required.
    const tm = await requireOAuthBearer(
      bearerEvFor(refreshed.access_token) as never,
      'tokenscope.emit',
      t.db as never,
    )
    expect(tm.teammateId).toBe(teammateId)
    await expect(
      requireOAuthBearer(
        bearerEvFor(refreshed.access_token) as never,
        'tokenscope.read',
        t.db as never,
      ),
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
    await expect(
      redeem({ handoff_code: 'no-such-handoff-code-value-1234567890' }),
    ).rejects.toMatchObject({ statusCode: 401 })
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
    await expect(redeem({ handoff_code, instance_id: randomUUID() })).rejects.toMatchObject({
      statusCode: 401,
    })
  })

  it('sets Cache-Control: no-store on the response', async () => {
    const { handoff_code } = await freshHandoff()
    const e = ev({ handoff_code })
    await redeemHandler(e as unknown as Parameters<typeof redeemHandler>[0])
    const cc = (e as { node: { res: { _headers: Record<string, string | string[]> } } }).node.res
      ._headers['cache-control']
    expect(cc).toBe('no-store')
  })
})

// ── provision_emit — per-teammate live-instance cap (fix 4) ───────────────────
//
// locateOrCreateInstance's create branch had no quota of any kind — its
// sibling (enroll-provision.ts's locateOrCreateProvisionalInstance) has had
// two since the emit-on-install slice. A separate teammate + small
// env-overridden cap keeps this deterministic and fast (the real default,
// DEFAULT_MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE, sits in the tens).
describe('provision_emit — per-teammate live-instance cap (fix 4)', () => {
  const ORIG_PER_TEAMMATE = process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
  const ORIG_GLOBAL = process.env.MAX_LIVE_EMIT_INSTANCES

  // A FRESH teammate PER TEST (not a shared beforeAll teammate) — the cap is
  // per-teammate, so reusing one across tests would let an earlier test's
  // instances count against a LATER test's cap, corrupting the boundary math.
  let capSeq = 0
  async function freshCapTeammate(): Promise<string> {
    capSeq += 1
    const [tm] = await t.db
      .insert(schema.teammate)
      .values({
        entraOid: `pe-oid-cap-${capSeq}`,
        email: `pe-cap-${capSeq}@example.com`,
        displayName: 'PE Cap',
        role: 'developer',
        regionId,
        orgUnitId: ouId,
      })
      .returning()
    return tm!.id
  }

  afterEach(() => {
    if (ORIG_PER_TEAMMATE === undefined) delete process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE
    else process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = ORIG_PER_TEAMMATE
    if (ORIG_GLOBAL === undefined) delete process.env.MAX_LIVE_EMIT_INSTANCES
    else process.env.MAX_LIVE_EMIT_INSTANCES = ORIG_GLOBAL
  })

  async function liveInstanceCount(teammate: string): Promise<number> {
    const rows = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation
       WHERE teammate_id = ${teammate}::uuid AND ts_actual_end IS NULL AND ts_purged IS NULL`
    return Number(rows[0]!.n)
  }

  it('looping past the cap returns a quota-exceeded tool error, with NO extra attestation created', async () => {
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '3'
    const capTeammateId = await freshCapTeammate()
    const client = await connectClient(bearerTeammate({ teammateId: capTeammateId }))

    for (let i = 0; i < 3; i++) {
      const res = await callProvision(client)
      expect(isErr(res)).toBe(false)
    }
    expect(await liveInstanceCount(capTeammateId)).toBe(3)

    // 4th FRESH device (no instance_id — the create branch) — over the cap.
    const overflow = await callProvision(client)
    expect(isErr(overflow)).toBe(true)
    expect(errText(overflow)).toMatch(/limit/i)
    // No orphaned attestation from the rejected attempt.
    expect(await liveInstanceCount(capTeammateId)).toBe(3)
    await client.close()
  })

  it('re-provisioning an EXISTING live instance still succeeds AT the cap (idempotent reuse never consumes quota)', async () => {
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '1'
    const capTeammateId = await freshCapTeammate()
    const client = await connectClient(bearerTeammate({ teammateId: capTeammateId }))

    const first = await provision(client)
    expect(isErr(first.res)).toBe(false)
    expect(await liveInstanceCount(capTeammateId)).toBe(1) // AT the cap of 1

    // Re-provision the SAME (already-existing) instance — must still succeed.
    const again = await provision(client, first.body.instance_id as string)
    expect(isErr(again.res)).toBe(false)
    expect(again.body.instance_id).toBe(first.body.instance_id)
    expect(await liveInstanceCount(capTeammateId)).toBe(1) // unchanged — no quota consumed

    // A GENUINELY fresh device, still at the cap, is correctly refused.
    const overflow = await callProvision(client)
    expect(isErr(overflow)).toBe(true)
    await client.close()
  })

  it('ended instances do not consume quota', async () => {
    process.env.MAX_LIVE_EMIT_INSTANCES_PER_TEAMMATE = '1'
    const capTeammateId = await freshCapTeammate()
    const client = await connectClient(bearerTeammate({ teammateId: capTeammateId }))

    const first = await provision(client)
    expect(await liveInstanceCount(capTeammateId)).toBe(1)
    await t.client.unsafe(
      `UPDATE instance_attestation SET ts_actual_end = now() WHERE instance_id = '${first.body.instance_id}'`,
    )
    expect(await liveInstanceCount(capTeammateId)).toBe(0) // freed the slot

    const second = await provision(client) // fresh device — must succeed
    expect(isErr(second.res)).toBe(false)
    expect(second.body.instance_id).not.toBe(first.body.instance_id)
    expect(await liveInstanceCount(capTeammateId)).toBe(1)
    await client.close()
  })
})
