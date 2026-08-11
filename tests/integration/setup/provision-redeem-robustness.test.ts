// @vitest-environment node
/*
 * AUTH-1 / AUTH-2 (robustness-review-2026-06-09) — transactional credential flows.
 *
 *   AUTH-1: /setup/redeem runs consume→check→mint→audit in ONE transaction. An
 *   injected audit failure must roll EVERYTHING back: the handoff stays
 *   redeemable and the prior emit credential stays live (no bricked device);
 *   a retry after the fault clears succeeds with the SAME handoff code.
 *
 *   AUTH-2: provision_emit runs revoke-prior-handoffs→mint→audit in ONE
 *   transaction serialized per instance (pg_advisory_xact_lock), so two
 *   concurrent provisions leave EXACTLY ONE redeemable handoff, and an audit
 *   failure can't orphan a redeemable code.
 *
 * Fault injection: a NOT VALID CHECK constraint on audit_event blocks inserts
 * of one event_type — recordAuditEvent then throws inside the transaction,
 * which is the CORRECT (roll-back-everything) behaviour under the new design.
 *
 * Harness mirrors tests/integration/setup/provision-emit.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import type { BearerTeammate } from '../../../server/auth/oauth-bearer'
import { createMcpServer } from '../../../server/utils/mcp'
import redeemHandler from '../../../server/api/v1/setup/redeem.post'

let t: TestDb
let regionId: string
let ouId: string
let teammateId: string

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'robustness-test-padded-to-thirty-two-chars!'
  process.env.NUXT_HMAC_SESSION_KEY = 'robustness-test-hmac-key-padded-well-beyond-32-chars'

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'rb', displayName: 'RB Region' })
    .returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'rb.svc',
      code: 'rb-svc',
      displayName: 'RB Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  ouId = ou!.id
  const [tm] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'rb-oid-1',
      email: 'rb-user@example.com',
      displayName: 'RB User',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  teammateId = tm!.id
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── harness (mirrors provision-emit.test.ts) ──────────────────────────────────

function bearerTeammate(): BearerTeammate {
  return {
    teammateId,
    email: 'rb-user@example.com',
    displayName: 'RB User',
    role: 'developer',
    regionId,
    scope: 'tokenscope.read tokenscope.tag',
  }
}

async function connectClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const teammate = bearerTeammate()
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

async function provision(client: Client, instanceId?: string) {
  const res = await client.callTool({
    name: 'provision_emit',
    arguments: instanceId ? { instance_id: instanceId } : {},
  })
  return { res, body: parseToolJson(res) }
}

function ev(body: unknown, host = 'localhost:3450') {
  const headers: Record<string, string> = { host }
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
async function redeem(body: unknown, host?: string) {
  return redeemHandler(ev(body, host) as unknown as Parameters<typeof redeemHandler>[0])
}

/** Block inserts of one audit event_type (NOT VALID skips existing rows). */
async function blockAudit(eventType: string) {
  await t.client.unsafe(
    `ALTER TABLE audit_event ADD CONSTRAINT test_block_audit CHECK (event_type <> '${eventType}') NOT VALID`,
  )
}
async function unblockAudit() {
  await t.client.unsafe(`ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS test_block_audit`)
}

async function redeemableHandoffs(instanceId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM emit_handoff
     WHERE instance_id = ${instanceId}::uuid AND consumed_at IS NULL AND expires_at > now()`
  return Number(rows[0]!.n)
}

async function liveEmitCredentials(instanceId: string): Promise<number> {
  const rows = await t.client<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM oauth_token
     WHERE instance_id = ${instanceId}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
  return Number(rows[0]!.n)
}

// ── AUTH-1: /setup/redeem is atomic ───────────────────────────────────────────

describe('AUTH-1 — /setup/redeem rolls back to a redeemable handoff on failure', () => {
  it('an audit failure mid-redeem leaves the handoff redeemable and the OLD credential live; retry succeeds', async () => {
    const client = await connectClient()

    // Establish a LIVE prior credential for the device (provision + redeem).
    const first = await provision(client)
    const instanceId = first.body.instance_id as string
    await redeem({ handoff_code: first.body.handoff_code as string })
    expect(await liveEmitCredentials(instanceId)).toBe(1)

    // Re-provision the same device → a fresh handoff.
    const second = await provision(client, instanceId)
    await client.close()
    const handoffCode = second.body.handoff_code as string
    expect(await redeemableHandoffs(instanceId)).toBe(1)

    // Inject the fault: the redeem's final audit insert throws.
    await blockAudit('emit-provisioned')
    try {
      await expect(redeem({ handoff_code: handoffCode })).rejects.toThrow()

      // EVERYTHING rolled back: the handoff is still redeemable...
      expect(await redeemableHandoffs(instanceId)).toBe(1)
      // ...and the prior emit credential was NOT revoked (device keeps emitting).
      expect(await liveEmitCredentials(instanceId)).toBe(1)
      const revoked = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM oauth_token
         WHERE instance_id = ${instanceId}::uuid AND revoked_at IS NOT NULL`
      expect(Number(revoked[0]!.n)).toBe(0)
    } finally {
      await unblockAudit()
    }

    // The SAME handoff code redeems successfully once the fault clears.
    const out = (await redeem({ handoff_code: handoffCode })) as { oauth_refresh_token: string }
    expect(out.oauth_refresh_token).toMatch(/.{20,}/)
    // Rotation completed atomically: exactly one live credential remains.
    expect(await liveEmitCredentials(instanceId)).toBe(1)
    expect(await redeemableHandoffs(instanceId)).toBe(0)
  })
})

// ── AUTH-2: provision_emit is atomic + serialized per instance ────────────────

describe('AUTH-2 — provision_emit revoke→mint→audit is one serialized transaction', () => {
  it('two CONCURRENT provisions for the same instance leave exactly ONE redeemable handoff', async () => {
    const clientA = await connectClient()
    const clientB = await connectClient()

    // Seed the instance so both concurrent calls target the SAME device.
    const seed = await provision(clientA)
    const instanceId = seed.body.instance_id as string

    const [a, b] = await Promise.all([
      provision(clientA, instanceId),
      provision(clientB, instanceId),
    ])
    await clientA.close()
    await clientB.close()

    expect(isErr(a.res)).toBe(false)
    expect(isErr(b.res)).toBe(false)
    expect(a.body.instance_id).toBe(instanceId)
    expect(b.body.instance_id).toBe(instanceId)

    // The rotation invariant: at most one redeemable code per device.
    expect(await redeemableHandoffs(instanceId)).toBe(1)
  })

  it('an audit failure rolls the fresh handoff back — the PRIOR handoff stays redeemable, no orphan', async () => {
    const client = await connectClient()
    const first = await provision(client)
    const instanceId = first.body.instance_id as string
    const firstCode = first.body.handoff_code as string
    expect(await redeemableHandoffs(instanceId)).toBe(1)

    await blockAudit('emit-handoff-minted')
    try {
      const failed = await client.callTool({
        name: 'provision_emit',
        arguments: { instance_id: instanceId },
      })
      expect(isErr(failed)).toBe(true)

      // Rolled back: the prior handoff was NOT revoked, and no orphaned fresh
      // code exists that the caller never saw.
      expect(await redeemableHandoffs(instanceId)).toBe(1)
    } finally {
      await unblockAudit()
    }
    await client.close()

    // The surviving (first) code still redeems.
    const out = (await redeem({ handoff_code: firstCode })) as { instance_id: string }
    expect(out.instance_id).toBe(instanceId)
  })
})

/*
 * The origin gate must refuse BEFORE the handoff is spent.
 *
 * redeem.post.ts commits its transaction and only then builds the OTel bundle.
 * A trust check that lived solely inside the bundle builder would fire after
 * the one-time code was consumed and the durable credential minted, so a purely
 * server-side misconfiguration would cost the developer their single-use code
 * and leave an orphaned credential behind. The enrol path has the equivalent
 * test; without this one, removing redeem's early guard is a false green.
 */
describe('AUTH-1b — an untrusted origin costs the caller nothing', () => {
  it('refuses before consuming the handoff, leaving it redeemable and the old credential live', async () => {
    const client = await connectClient()
    const first = await provision(client)
    const instanceId = first.body.instance_id as string
    await redeem({ handoff_code: first.body.handoff_code as string })
    const credentialsBefore = await liveEmitCredentials(instanceId)

    const second = await provision(client, instanceId)
    const handoffCode = second.body.handoff_code as string
    expect(await redeemableHandoffs(instanceId)).toBe(1)

    const priorOrigin = process.env.APP_PUBLIC_ORIGIN
    const priorFd = process.env.AZURE_FRONT_DOOR_ID
    delete process.env.APP_PUBLIC_ORIGIN
    delete process.env.AZURE_FRONT_DOOR_ID
    try {
      await expect(
        redeem({ handoff_code: handoffCode }, 'internal.a1b2c3.eastus.azurecontainerapps.io'),
      ).rejects.toMatchObject({ statusCode: 500 })

      // Nothing was spent: the code still redeems and no credential was rotated.
      expect(await redeemableHandoffs(instanceId)).toBe(1)
      expect(await liveEmitCredentials(instanceId)).toBe(credentialsBefore)
    } finally {
      if (priorOrigin === undefined) delete process.env.APP_PUBLIC_ORIGIN
      else process.env.APP_PUBLIC_ORIGIN = priorOrigin
      if (priorFd === undefined) delete process.env.AZURE_FRONT_DOOR_ID
      else process.env.AZURE_FRONT_DOOR_ID = priorFd
    }

    // And the SAME code still works once the deployment is configured.
    process.env.APP_PUBLIC_ORIGIN = 'https://tokenscope.example.com'
    try {
      await redeem({ handoff_code: handoffCode }, 'internal.a1b2c3.eastus.azurecontainerapps.io')
      expect(await redeemableHandoffs(instanceId)).toBe(0)
    } finally {
      delete process.env.APP_PUBLIC_ORIGIN
    }
  })
})

// ── AUTH-1c: a row whose tool we cannot serve is refused, not mis-served ──────

describe('AUTH-1c — an unserveable stored tool is refused, and refusing costs nothing', () => {
  it('redeem 409s on an unknown tool instead of handing back a Claude bundle', async () => {
    const client = await connectClient()
    const first = await provision(client)
    const instanceId = first.body.instance_id as string
    await redeem({ handoff_code: first.body.handoff_code as string })
    expect(await liveEmitCredentials(instanceId)).toBe(1)

    const second = await provision(client, instanceId)
    const code = second.body.handoff_code as string

    // Manufacture the row migration 0100 now prevents but that a device
    // enrolled BEFORE it could still be holding. The trigger is disabled for
    // exactly one statement, which is the only honest way to reach the state
    // the read-side guard exists for.
    await t.client.unsafe(
      `ALTER TABLE instance_attestation DISABLE TRIGGER instance_attestation_tool_nonblank`,
    )
    try {
      await t.client`UPDATE instance_attestation SET tool = 'vim' WHERE instance_id = ${instanceId}::uuid`
    } finally {
      await t.client.unsafe(
        `ALTER TABLE instance_attestation ENABLE TRIGGER instance_attestation_tool_nonblank`,
      )
    }

    await expect(redeem({ handoff_code: code })).rejects.toMatchObject({ statusCode: 409 })

    // Refusing must be safe, not destructive: the guard runs INSIDE the
    // transaction, so the one-time code is not spent and the credential the
    // device is currently emitting with is untouched. (Recovery is a fresh
    // device, but a broken row must not also cost the caller a working one.)
    expect(await redeemableHandoffs(instanceId)).toBe(1)
    expect(await liveEmitCredentials(instanceId)).toBe(1)
  })

  it('the same redeem succeeds when the tool IS serveable (anti-vacuity control)', async () => {
    // Without this, the test above would also pass if redeem 409'd on every
    // second redeem for unrelated reasons.
    const client = await connectClient()
    const first = await provision(client)
    const instanceId = first.body.instance_id as string
    await redeem({ handoff_code: first.body.handoff_code as string })
    const second = await provision(client, instanceId)
    await expect(redeem({ handoff_code: second.body.handoff_code as string })).resolves.toBeTruthy()
    expect(await redeemableHandoffs(instanceId)).toBe(0)
  })
})
