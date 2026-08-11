// @vitest-environment node
/*
 * Cross-TOOL device-reuse guard — instance_attestation.tool.
 * server/auth/emit-provision.ts §locateOrCreateInstance.
 *
 * BACKGROUND (reproduced live 2026-07-28). An instance is per-HOST but bound to
 * ONE emit tool. The reuse branch checked deployment_env but NOT tool, so
 * provisioning an existing `claude-code` instance as `copilot-cli` returned
 * `reused: true`. The caller then rotated the durable credential and built a
 * bundle for the WRONG tool; the redeem helper rejected that bundle CLIENT-side,
 * AFTER the rotation had already committed. Net effect: the old secret was dead
 * on disk, the new one was never written, and attempting to set up ONE CLI
 * SILENTLY BROKE THE OTHER CLI's working emitting on the same host — the
 * affected CLI kept running while emitting nothing.
 *
 * The guard must reject BEFORE any rotation, so the failure is safe (nothing
 * changes) rather than destructive (credential destroyed, nothing written).
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). Harness mirrors
 * setup/cross-env-guard.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  locateOrCreateInstance,
  issueInstanceEmitCredentialTx,
  requireEmitTool,
  EMIT_TOOLS,
  type ProvisioningTeammate,
} from '../../../server/auth/emit-provision'
import { hashSessionToken } from '../../../server/auth/hmac'

let t: TestDb
let tm: ProvisioningTeammate

const DEV = 'dev'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_HMAC_SESSION_KEY = 'cross-tool-guard-test-hmac-key-padded-beyond-32'

  const [r] = await t.db
    .insert(schema.region)
    .values({ code: 'ct', displayName: 'CT Region' })
    .returning()
  const regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'ct.svc',
      code: 'ct-svc',
      displayName: 'CT Svc',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  const ouId = ou!.id
  const [teammate] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'ct-oid-1',
      email: 'ct-user@example.com',
      displayName: 'CT User',
      role: 'developer',
      regionId,
      orgUnitId: ouId,
    })
    .returning()
  tm = {
    teammateId: teammate!.id,
    principalOid: 'ct-oid-1',
    email: 'ct-user@example.com',
    regionId,
    orgUnitId: ouId,
  }
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function storedTool(instanceId: string): Promise<string | null> {
  const rows = await t.client<{ tool: string | null }[]>`
    SELECT tool FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
  return rows[0]?.tool ?? null
}

describe('cross-tool device-reuse guard', () => {
  it('mint stamps the requested tool', async () => {
    const a = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    const b = await locateOrCreateInstance(t.db as never, tm, undefined, 'copilot-cli', DEV)
    expect(await storedTool(a.instanceId)).toBe('claude-code')
    expect(await storedTool(b.instanceId)).toBe('copilot-cli')
  })

  it('same-tool reuse still returns the existing instance', async () => {
    const first = await locateOrCreateInstance(t.db as never, tm, undefined, 'copilot-cli', DEV)
    const again = await locateOrCreateInstance(
      t.db as never,
      tm,
      first.instanceId,
      'copilot-cli',
      DEV,
    )
    expect(again.reused).toBe(true)
    expect(again.instanceId).toBe(first.instanceId)
  })

  it('provisioning a claude-code instance as copilot-cli is REJECTED (409), not reused', async () => {
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )
    const before = await t.client<
      { n: string }[]
    >`SELECT COUNT(*)::text AS n FROM instance_attestation`

    await expect(
      locateOrCreateInstance(t.db as never, tm, instanceId, 'copilot-cli', DEV),
    ).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: expect.stringContaining('already provisioned for'),
    })

    // Nothing minted, and — critically — the instance still belongs to claude-code,
    // so no rotation of the Claude credential can have been triggered downstream.
    const after = await t.client<
      { n: string }[]
    >`SELECT COUNT(*)::text AS n FROM instance_attestation`
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n))
    expect(await storedTool(instanceId)).toBe('claude-code')
  })

  it('the reverse direction is rejected too (copilot-cli instance provisioned as claude-code)', async () => {
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'copilot-cli',
      DEV,
    )
    await expect(
      locateOrCreateInstance(t.db as never, tm, instanceId, 'claude-code', DEV),
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(await storedTool(instanceId)).toBe('copilot-cli')
  })

  it('a degenerate BLANK tool fails CLOSED — refused, never adopted', async () => {
    // Fails closed, not open. A blank tool means we cannot prove which CLI owns
    // this instance, and the caller rotates the durable emit credential on a
    // successful reuse. Adopting the caller's tool here (the earlier behaviour)
    // would hand a copilot-cli provision an instance that might belong to
    // claude-code and revoke its credential, which is exactly the destruction
    // this guard exists to prevent. Refusing costs only a re-run with no
    // instance_id, which always works.
    //
    // Written via raw SQL because migration 0099's CHECK now forbids this state
    // through every normal path; the guard remains as defence for rows written
    // before it, or by a future raw backfill.
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )
    await t.client`DROP TRIGGER instance_attestation_tool_nonblank ON instance_attestation`
    try {
      await t.client`UPDATE instance_attestation SET tool = '   ' WHERE instance_id = ${instanceId}::uuid`

      await expect(
        locateOrCreateInstance(t.db as never, tm, instanceId, 'copilot-cli', DEV),
      ).rejects.toMatchObject({ statusCode: 409 })

      // And it did NOT quietly adopt the requested tool on its way out.
      expect((await storedTool(instanceId))?.trim()).toBe('')
    } finally {
      // finally, NOT tail code. If an assertion above throws, tail restoration
      // is skipped and every LATER test in this file runs without the
      // constraint, turning one real failure into a set of misleading ones.
      // Restore the row before re-adding: the ADD would otherwise be validating
      // against a row it forbids.
      await t.client`UPDATE instance_attestation SET tool = 'claude-code' WHERE instance_id = ${instanceId}::uuid`
      await t.client`
        CREATE TRIGGER instance_attestation_tool_nonblank
          BEFORE INSERT OR UPDATE OF tool ON instance_attestation
          FOR EACH ROW EXECUTE FUNCTION instance_attestation_tool_nonblank()`
    }
  })

  it('migration 0099 forbids a blank tool at the database level', async () => {
    // The guard above is defence in depth; this is the primary control. Without
    // it the degenerate state stays reachable by any raw writer.
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )
    await expect(
      t.client`UPDATE instance_attestation SET tool = '' WHERE instance_id = ${instanceId}::uuid`,
    ).rejects.toThrow(/tool must be non-blank/)
  })

  it('a legacy blank row can still be ENDED and maintained (why a trigger, not a CHECK)', async () => {
    // The control has to shut the door on NEW blanks without bricking a row
    // that predates it. A CHECK constraint cannot do that: valid or NOT VALID,
    // PostgreSQL re-evaluates it against the whole new row version on EVERY
    // update, so a legacy blank row could never be revoked, region-reassigned,
    // PII-purged, or have its bearer refreshed. That turns "one refused setup"
    // into "one row no operator can remediate and no worker can maintain",
    // which is strictly worse than the state being closed. A
    // `BEFORE INSERT OR UPDATE OF tool` trigger fires only for writes that
    // actually touch the column.
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )
    // Manufacture the legacy row exactly as a pre-migration deployment would
    // hold it: drop the trigger, blank the tool, put the trigger back.
    await t.client`DROP TRIGGER instance_attestation_tool_nonblank ON instance_attestation`
    try {
      await t.client`UPDATE instance_attestation SET tool = '' WHERE instance_id = ${instanceId}::uuid`
    } finally {
      await t.client`
        CREATE TRIGGER instance_attestation_tool_nonblank
          BEFORE INSERT OR UPDATE OF tool ON instance_attestation
          FOR EACH ROW EXECUTE FUNCTION instance_attestation_tool_nonblank()`
    }

    // The remediation path: end it. This MUST succeed.
    await t.client`UPDATE instance_attestation SET ts_actual_end = NOW() WHERE instance_id = ${instanceId}::uuid`
    const [ended] = await t.client<{ ts_actual_end: Date | null }[]>`
      SELECT ts_actual_end FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(ended?.ts_actual_end).not.toBeNull()

    // Routine maintenance that does not touch `tool` must also still work.
    await t.client`UPDATE instance_attestation SET raw_project_code = 'maintained' WHERE instance_id = ${instanceId}::uuid`

    // Vacuity guard: the row really is blank, so the assertions above were not
    // exercising an ordinary row that the trigger would never have objected to.
    const [row] = await t.client<{ tool: string }[]>`
      SELECT tool FROM instance_attestation WHERE instance_id = ${instanceId}::uuid`
    expect(row?.tool).toBe('')

    // And the door is still shut: writing a blank tool remains refused.
    await expect(
      t.client`UPDATE instance_attestation SET tool = '' WHERE instance_id = ${instanceId}::uuid`,
    ).rejects.toThrow(/tool must be non-blank/)
  })

  it('the claude-code emit credential survives a REJECTED copilot-cli provision', async () => {
    // R2 finding: the 409 assertions above prove the guard refuses, not that
    // refusing PROTECTS anything. The liveness proof was added on the enrol path
    // only, which is a different door. This is the authenticated one, where the
    // caller (provision_emit / redeem) calls issueInstanceEmitCredentialTx and
    // rotates. What matters is that the refusal lands BEFORE that rotation.
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )

    const clientId = randomUUID()
    await t.client`
      INSERT INTO oauth_client (client_id, client_secret_hash, client_name, redirect_uris)
      VALUES (${clientId}::uuid, 'test-secret-hash', 'test-cli', ARRAY['http://127.0.0.1/cb'])
    `
    const refreshToken = `rt-${randomUUID()}`
    await t.db.transaction(async (tx) => {
      await issueInstanceEmitCredentialTx(tx as never, tm.teammateId, instanceId, async (db) => {
        await (db as unknown as typeof tx).execute(sql`
          INSERT INTO oauth_token
            (access_token_hash, refresh_token_hash, client_id, teammate_id, scope,
             access_expires_at, refresh_expires_at)
          VALUES (${hashSessionToken(`at-${refreshToken}`)}, ${hashSessionToken(refreshToken)},
                  ${clientId}::uuid, ${tm.teammateId}::uuid, 'tokenscope.emit',
                  now() + interval '1 hour', now() + interval '90 days')
        `)
        return { clientId, tokens: { refresh_token: refreshToken } }
      })
    })

    const live = async () => {
      const rows = await t.client<{ revoked_at: Date | null }[]>`
        SELECT revoked_at FROM oauth_token WHERE refresh_token_hash = ${hashSessionToken(refreshToken)}
      `
      expect(rows.length).toBe(1) // vacuity guard: a typo'd hash must fail, not read as "live"
      return rows[0]!.revoked_at === null
    }
    expect(await live()).toBe(true)

    await expect(
      locateOrCreateInstance(t.db as never, tm, instanceId, 'copilot-cli', DEV),
    ).rejects.toMatchObject({ statusCode: 409 })

    // The whole point of refusing BEFORE the rotation.
    expect(await live()).toBe(true)
  })
})

/*
 * The closed tool set — migration 0100 + requireEmitTool().
 *
 * The two halves are deliberately separate and neither is redundant. The
 * trigger cannot help a row written before it existed; the narrowing cannot
 * help a reader that is not the redeem handler. So both are tested, and the
 * narrowing is tested against a value the trigger would have refused, which is
 * exactly the pre-existing-row case it exists for.
 */
describe('closed tool set', () => {
  it('the trigger refuses an unknown tool on INSERT', async () => {
    const id = randomUUID()
    await expect(
      t.client`
        INSERT INTO instance_attestation (instance_id, teammate_id, tool, deployment_env)
        VALUES (${id}::uuid, ${tm.teammateId}::uuid, 'vim', ${DEV})
      `,
    ).rejects.toThrow(/must be one of claude-code, copilot-cli/)

    const rows = await t.client<
      { n: string }[]
    >`SELECT COUNT(*)::text AS n FROM instance_attestation WHERE instance_id = ${id}::uuid`
    expect(Number(rows[0]!.n)).toBe(0)
  })

  it('the trigger refuses an unknown tool on UPDATE of an existing good row', async () => {
    const { instanceId } = await locateOrCreateInstance(
      t.db as never,
      tm,
      undefined,
      'claude-code',
      DEV,
    )
    await expect(
      t.client`UPDATE instance_attestation SET tool = 'emacs' WHERE instance_id = ${instanceId}::uuid`,
    ).rejects.toThrow(/must be one of claude-code, copilot-cli/)
    // The refusal must not have half-applied.
    expect(await storedTool(instanceId)).toBe('claude-code')
  })

  it('the trigger still permits both known tools (anti-vacuity control)', async () => {
    // Without this, the two tests above would also pass if the trigger refused
    // EVERY value, which would be a far worse bug than the one being fixed.
    const a = await locateOrCreateInstance(t.db as never, tm, undefined, 'claude-code', DEV)
    const b = await locateOrCreateInstance(t.db as never, tm, undefined, 'copilot-cli', DEV)
    expect(await storedTool(a.instanceId)).toBe('claude-code')
    expect(await storedTool(b.instanceId)).toBe('copilot-cli')
  })

  it('requireEmitTool refuses an unknown stored tool rather than serving a Claude bundle', () => {
    // The value a row written before 0100 could still be holding.
    expect(() => requireEmitTool('vim')).toThrowError(expect.objectContaining({ statusCode: 409 }))
    // Silence is the failure mode being prevented: it must NOT quietly answer
    // 'claude-code' the way the old cast did.
    const served = ((): string | null => {
      try {
        return requireEmitTool('vim')
      } catch {
        return null
      }
    })()
    expect(served).toBeNull()
  })

  it('the DB trigger accepts exactly EMIT_TOOLS, no more and no less', () => {
    // The trigger's list is a hand-written copy of EMIT_TOOLS in SQL, which is
    // the drift the consolidation could not remove (the database cannot import
    // TypeScript). Pin the two together so adding a tool to EMIT_TOOLS without
    // a follow-up migration fails here rather than at a device's redeem.
    const migration = readFileSync(
      join(process.cwd(), 'drizzle', 'migrations', '0100_instance_tool_known.sql'),
      'utf8',
    )
    const inClause = /NEW\.tool NOT IN \(([^)]*)\)/.exec(migration)
    expect(inClause, 'the closed-set check is gone from the migration').not.toBeNull()
    const sqlTools = [...inClause![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(sqlTools.length).toBeGreaterThan(0) // vacuity guard
    expect([...sqlTools].sort()).toEqual([...EMIT_TOOLS].sort())
  })

  it('requireEmitTool reads NULL as claude-code and passes both known tools through', () => {
    expect(requireEmitTool(null)).toBe('claude-code')
    expect(requireEmitTool(undefined)).toBe('claude-code')
    expect(requireEmitTool('claude-code')).toBe('claude-code')
    expect(requireEmitTool('copilot-cli')).toBe('copilot-cli')
  })
})
