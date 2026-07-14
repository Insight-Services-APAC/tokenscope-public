// @vitest-environment node
/*
 * Cross-environment device-reuse guard — instance_attestation.deployment_env
 * (mig 0060). server/auth/emit-provision.ts §locateOrCreateInstance.
 *
 * BACKGROUND. A client that re-provisions a device against a DIFFERENT
 * deployment (Sandbox → Dev, later Dev → Production) may still carry the OLD
 * environment's tokenscope.instance_id. The old code, given an id it couldn't
 * find/own, SILENTLY minted a fresh instance — no signal a duplicate device
 * record was created in the wrong place. The guard stamps the minting
 * deployment's NUXT_DEPLOY_ENV label on each instance and REJECTS a
 * cross-environment reuse (409) instead of silently re-minting.
 *
 * We drive locateOrCreateInstance DIRECTLY (rather than through the MCP tool):
 * the tool always uses the running deployment's env, but the guard's whole point
 * is comparing TWO distinct deploy-env labels, so the test injects them
 * explicitly via the function's `deployEnv` argument. The label (not an origin
 * host) is used deliberately: it is stable across a custom-domain cutover. Real
 * DB via testcontainers (AGENTS.md: never mock Drizzle). Harness mirrors
 * setup/provision-emit.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { locateOrCreateInstance, type ProvisioningTeammate } from '../../../server/auth/emit-provision'

let t: TestDb
let regionId: string
let ouId: string
let tm: ProvisioningTeammate

const DEV = 'dev'
const SANDBOX = 'sandbox'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url

  const [r] = await t.db.insert(schema.region).values({ code: 'cx', displayName: 'CX Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'cx.svc', code: 'cx-svc', displayName: 'CX Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  const [teammate] = await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'cx-oid-1', email: 'cx-user@example.com', displayName: 'CX User', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
  tm = {
    teammateId: teammate!.id,
    principalOid: 'cx-oid-1',
    email: 'cx-user@example.com',
    regionId,
    orgUnitId: ouId,
  }
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function storedEnv(instanceId: string): Promise<string | null> {
  const rows = await t.client<{ deployment_env: string | null }[]>`
    SELECT deployment_env FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return rows[0]?.deployment_env ?? null
}

describe('cross-environment device-reuse guard', () => {
  it('(a) MINT stamps deployment_env with the current deploy-env label', async () => {
    const { instanceId, reused } = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    expect(reused).toBe(false)
    expect(await storedEnv(instanceId)).toBe('dev')
  })

  it('(b) same-env reuse returns the EXISTING instance (no duplicate minted)', async () => {
    const first = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    // Re-provision the same id against the SAME deployment env.
    const again = await locateOrCreateInstance(t.db as never, tm, first.instanceId, 'claude-code', DEV)
    expect(again.reused).toBe(true)
    expect(again.instanceId).toBe(first.instanceId)
    // Exactly one row for that id — idempotent, nothing new minted.
    const n = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE instance_id = ${first.instanceId}::uuid`
    expect(Number(n[0]!.n)).toBe(1)
  })

  it('(c) a supplied id whose stored env DIFFERS is REJECTED (409) — not silently re-minted', async () => {
    // Mint in DEV.
    const { instanceId } = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    const before = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM instance_attestation`

    // Re-provision the SAME id against SANDBOX → must throw, not mint.
    await expect(
      locateOrCreateInstance(t.db as never, tm, instanceId, 'claude-code', SANDBOX),
    ).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: expect.stringContaining('different TokenScope environment'),
    })

    // No new instance was created (the silent-mint bug would have added one).
    const after = await t.client<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM instance_attestation`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))
    // The original row is untouched (still DEV).
    expect(await storedEnv(instanceId)).toBe('dev')
  })

  it('(d) legacy NULL-env rows are tolerated as same-env AND back-filled on reuse', async () => {
    // Simulate a pre-0060 row: mint, then null out the env.
    const { instanceId } = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    await t.client`UPDATE instance_attestation SET deployment_env = NULL WHERE instance_id = ${instanceId}::uuid`
    expect(await storedEnv(instanceId)).toBeNull()

    // Reuse against SANDBOX must NOT reject (null = unknown = same-env back-compat)
    // and should back-fill the env so the NEXT reuse is guarded.
    const reused = await locateOrCreateInstance(t.db as never, tm, instanceId, 'claude-code', SANDBOX)
    expect(reused.reused).toBe(true)
    expect(reused.instanceId).toBe(instanceId)
    expect(await storedEnv(instanceId)).toBe('sandbox')

    // Now that it's stamped SANDBOX, a DEV reuse IS rejected (guard now active).
    await expect(
      locateOrCreateInstance(t.db as never, tm, instanceId, 'claude-code', DEV),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a supplied id NOT owned by this teammate still falls through to a fresh mint (no leak)', async () => {
    // Unknown id (never minted) → mint fresh, no reject.
    const { instanceId, reused } = await locateOrCreateInstance(t.db as never, tm, randomUUID(), 'claude-code', DEV)
    expect(reused).toBe(false)
    expect(await storedEnv(instanceId)).toBe('dev')
  })
})
