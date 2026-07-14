// @vitest-environment node
/*
 * Epic 11 /api/v1/me/sessions/recent — SQL-contract integration test.
 *
 * Validates the query the handler runs:
 *   - Most-recent instance_attestation rows for this user, capped by limit
 *   - Tokens + cost summed from attribution_record per session
 *   - LEFT JOIN to project on raw_project_code (project may be null)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let priyaId: string
let regionId: string
let orgUnitId: string
let projectId: string

beforeAll(async () => {
  t = await startTestDb()

  const [region] = await t.db.insert(schema.region).values({ code: 'apac-s', displayName: 'APAC' }).returning()
  regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'apac.svc',
      code: 'svc',
      displayName: 'Services',
      unitType: 'bu',
    })
    .returning()
  orgUnitId = bu!.id
  const [priya] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: 'oid-priya-s',
      email: 'priya.sessions@example.com',
      regionId,
      orgUnitId,
    })
    .returning()
  priyaId = priya!.id

  const [proj] = await t.db
    .insert(schema.project)
    .values({
      code: 'AFL-AII-S',
      codeHash: 'h-afl-aii-s',
      displayName: 'AFL · AI Insights',
      type: 'billable',
      regionId,
      costOwningUnitId: orgUnitId,
    })
    .returning()
  projectId = proj!.id

  // Insert 3 sessions: one tagged, one without rate_card join, one with
  // multiple attribution_record rows so the SUM is exercised.
  const [rc] = await t.db
    .select({ id: schema.rateCard.id, version: schema.rateCard.version })
    .from(schema.rateCard)
    .limit(1)
  for (let i = 0; i < 3; i++) {
    const sid = randomUUID()
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: sid,
      principalOid: 'oid-priya-s',
      teammateId: priyaId,
      projectCodeHash: 'h-afl-aii-s',
      rawProjectCode: 'AFL-AII-S',
      tool: 'claude-code',
      sessionTokenHash: 'tok-s-' + sid,
      tsStart: new Date(Date.now() - (i + 1) * 60 * 60_000),
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
    })
    // Two attribution rows per session — exercises SUM behavior.
    for (let j = 0; j < 2; j++) {
      await t.db.insert(schema.attributionRecord).values({
        instanceId: sid,
        teammateId: priyaId,
        projectId,
        regionId,
        orgUnitId,
        costOwningUnitId: orgUnitId,
        tool: 'claude-code',
        model: 'claude-opus-4-1',
        tokenType: j === 0 ? 'input' : 'output',
        tokens: BigInt(1000 * (i + 1) * (j + 1)),
        costUsd: (0.1 * (i + 1) * (j + 1)).toFixed(6),
        rateCardId: rc!.id,
        rateCardVersion: rc!.version,
        fidelityTier: 'tier-1',
        costBasis: 'estimated',
        tsEvent: new Date(Date.now() - (i + 1) * 60 * 60_000),
      })
    }
  }
}, 60_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

describe('Epic 11 /me/sessions/recent SQL contract', () => {
  it('returns the user`s sessions ordered most-recent-first up to limit', async () => {
    const rows = await t.db.execute<{
      instance_id: string
      project_code: string | null
      tool: string
      tokens: string
      cost_usd: string
    }>(
      sql`
        SELECT
          sa.instance_id::text AS instance_id,
          p.code AS project_code,
          sa.tool,
          COALESCE((SELECT SUM(tokens) FROM attribution_record ar WHERE ar.instance_id = sa.instance_id), 0)::text AS tokens,
          COALESCE((SELECT SUM(cost_usd) FROM attribution_record ar WHERE ar.instance_id = sa.instance_id), 0)::text AS cost_usd
        FROM instance_attestation sa
        LEFT JOIN project p ON p.code = sa.raw_project_code
        WHERE sa.teammate_id = ${priyaId}::uuid
        ORDER BY sa.ts_start DESC
        LIMIT 10
      `,
    )
    const list = [...rows]
    expect(list.length).toBe(3)
    // Most-recent session is i=0 (1 hour ago); tokens = 1000*1*1 + 1000*1*2 = 3000.
    expect(Number(list[0]!.tokens)).toBe(3000)
    expect(list[0]!.project_code).toBe('AFL-AII-S')
    expect(list[0]!.tool).toBe('claude-code')
  })

  it('honours the limit clamp', async () => {
    const rows = await t.db.execute<{ instance_id: string }>(
      sql`
        SELECT sa.instance_id::text AS instance_id
        FROM instance_attestation sa
        WHERE sa.teammate_id = ${priyaId}::uuid
        ORDER BY sa.ts_start DESC
        LIMIT 2
      `,
    )
    expect([...rows].length).toBe(2)
  })
})

describe('per-conversation grouping + dedup (claude_session_id, migration 0017)', () => {
  it('groups two conversations on one instance as two rows, and dedups within a conversation', async () => {
    const inst = randomUUID()
    const convA = randomUUID()
    const convB = randomUUID()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: inst,
      principalOid: 'oid-conv',
      teammateId: priyaId,
      projectCodeHash: 'h-afl-aii-s',
      rawProjectCode: 'AFL-AII-S',
      tool: 'claude-code',
      sessionTokenHash: 'tok-conv-' + inst,
      tsStart: new Date(),
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
    })
    const ts = new Date('2026-06-01T00:00:00.000Z')
    const baseRow = {
      instanceId: inst,
      teammateId: priyaId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'input',
      tokens: 100n,
      costUsd: '0.010000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: ts,
    }
    // Two DIFFERENT conversations, identical (instance, ts, token_type, model).
    // Pre-0017 these collided on the dedup key and the 2nd was dropped (F1).
    for (const conv of [convA, convB]) {
      await t.db.insert(schema.attributionRecord).values({ ...baseRow, claudeSessionId: conv }).onConflictDoNothing()
    }
    // Re-insert convA's identical row — the unique index must dedup it.
    await t.db.insert(schema.attributionRecord).values({ ...baseRow, claudeSessionId: convA }).onConflictDoNothing()

    const rows = await t.db.execute<{ conv: string; n: number }>(sql`
      SELECT COALESCE(ar.claude_session_id, ar.instance_id::text) AS conv, count(*)::int AS n
      FROM attribution_record ar
      JOIN instance_attestation sa ON sa.instance_id = ar.instance_id
      WHERE sa.teammate_id = ${priyaId}::uuid AND ar.instance_id = ${inst}::uuid
      GROUP BY 1
    `)
    const convs = [...rows]
    // Two conversations, NOT one merged instance row (the whole point).
    expect(convs.length).toBe(2)
    // One row each: both conversations survived (F1 fix) AND the re-insert deduped.
    expect(convs.every((r) => r.n === 1)).toBe(true)
  })
})

describe('untagged worklist tagged-set query (§13 — per-conversation, not per-instance)', () => {
  it('a sibling conversation getting attributed does NOT mark the other tagged', async () => {
    // One shared instance, two conversations. convTagged has an attribution_record;
    // convUntagged has neither attribution nor assignment → still untagged. The OLD
    // per-instance logic excluded the whole instance once ANY conversation attributed.
    const inst = randomUUID()
    const convTagged = 'csid-tagged-' + randomUUID()
    const convUntagged = 'csid-untagged-' + randomUUID()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: inst,
      principalOid: 'oid-wl',
      teammateId: priyaId,
      tool: 'claude-code',
      sessionTokenHash: 'tok-wl-' + inst,
      tsStart: new Date(),
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      attestationState: 'unassigned',
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: inst,
      claudeSessionId: convTagged,
      teammateId: priyaId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'input',
      tokens: 100n,
      costUsd: '0.010000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(),
    })

    // The handler's tagged-set query (claude_session_id from attribution_record
    // UNION session_assignment).
    const taggedRows = await t.db.execute<{ claude_session_id: string }>(sql`
      SELECT DISTINCT claude_session_id FROM attribution_record
      WHERE teammate_id = ${priyaId}::uuid
        AND claude_session_id IS NOT NULL
        AND ts_recorded > now() - interval '60 days'
      UNION
      SELECT claude_session_id FROM session_assignment
      WHERE teammate_id = ${priyaId}::uuid
    `)
    const tagged = new Set([...taggedRows].map((r) => r.claude_session_id))
    expect(tagged.has(convTagged)).toBe(true)
    // The sibling is STILL untagged — the per-conversation fix.
    expect(tagged.has(convUntagged)).toBe(false)
  })

  it('a session_assignment marks a conversation tagged (immediately, before the joiner)', async () => {
    const conv = 'csid-assigned-' + randomUUID()
    await t.db.insert(schema.sessionAssignment).values({
      claudeSessionId: conv,
      teammateId: priyaId,
      projectId,
      source: 'manual',
    })
    const taggedRows = await t.db.execute<{ claude_session_id: string }>(sql`
      SELECT DISTINCT claude_session_id FROM attribution_record
      WHERE teammate_id = ${priyaId}::uuid AND claude_session_id IS NOT NULL
      UNION
      SELECT claude_session_id FROM session_assignment
      WHERE teammate_id = ${priyaId}::uuid
    `)
    expect(new Set([...taggedRows].map((r) => r.claude_session_id)).has(conv)).toBe(true)
  })
})

describe('recent untagged lane is PER-CONVERSATION, not per-instance (F6)', () => {
  it('a partially-attributed instance does NOT drop its still-untagged sibling from the untagged lane', async () => {
    // One shared instance, two conversations: convDone is attributed, convOpen is
    // not. The OLD recent untagged query used
    //   NOT EXISTS (... attribution_record ar WHERE ar.instance_id = sa.instance_id)
    // → the instance had an attribution_record, so the WHOLE instance dropped out,
    // hiding convOpen. The NEW lane subtracts a PER-CONVERSATION tagged-set from
    // the reader's per-conversation summaries, so convOpen still surfaces.
    const inst = randomUUID()
    const convDone = 'csid-rdone-' + randomUUID()
    const convOpen = 'csid-ropen-' + randomUUID()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: inst,
      principalOid: 'oid-f6',
      teammateId: priyaId,
      tool: 'claude-code',
      sessionTokenHash: 'tok-f6-' + inst,
      tsStart: new Date(),
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      attestationState: 'unassigned',
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: inst,
      claudeSessionId: convDone,
      teammateId: priyaId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'input',
      tokens: 100n,
      costUsd: '0.010000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(),
    })

    // The handler's per-conversation tagged-set (attribution_record claude_session_id
    // UNION session_assignment) — the same one untagged.get.ts uses.
    const taggedRows = await t.db.execute<{ claude_session_id: string }>(sql`
      SELECT DISTINCT claude_session_id FROM attribution_record
      WHERE teammate_id = ${priyaId}::uuid
        AND claude_session_id IS NOT NULL
        AND ts_recorded > now() - interval '60 days'
      UNION
      SELECT claude_session_id FROM session_assignment
      WHERE teammate_id = ${priyaId}::uuid
    `)
    const tagged = new Set([...taggedRows].map((r) => r.claude_session_id))
    // The untagged lane = reader summaries MINUS tagged. Simulate the two
    // conversations the reader would return for this instance.
    const readerSummaries = [
      { sessionId: convDone, instanceId: inst },
      { sessionId: convOpen, instanceId: inst },
    ]
    const untagged = readerSummaries.filter((s) => !tagged.has(s.sessionId))
    // convOpen survives even though its instance is partially attributed (F6 fix).
    expect(untagged.map((s) => s.sessionId)).toEqual([convOpen])
    expect(untagged[0]!.instanceId).toBe(inst) // each untagged row carries its instance

    // Proof the OLD per-instance predicate would have hidden convOpen:
    const instanceDropped = await t.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM attribution_record ar WHERE ar.instance_id = ${inst}::uuid
      ) AS exists
    `)
    expect([...instanceDropped][0]!.exists).toBe(true) // → old query dropped the whole instance
  })
})

describe('recent surfaces the instance_id per conversation row (§13)', () => {
  it('the attributed grouping returns the instance alongside the conversation', async () => {
    const inst = randomUUID()
    const conv = 'csid-recent-' + randomUUID()
    const [rc] = await t.db
      .select({ id: schema.rateCard.id, version: schema.rateCard.version })
      .from(schema.rateCard)
      .limit(1)
    await t.db.insert(schema.instanceAttestation).values({
      instanceId: inst,
      principalOid: 'oid-ri',
      teammateId: priyaId,
      tool: 'claude-code',
      sessionTokenHash: 'tok-ri-' + inst,
      tsStart: new Date(),
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      attestationState: 'unassigned',
    })
    await t.db.insert(schema.attributionRecord).values({
      instanceId: inst,
      claudeSessionId: conv,
      teammateId: priyaId,
      projectId,
      regionId,
      orgUnitId,
      costOwningUnitId: orgUnitId,
      tool: 'claude-code',
      model: 'claude-opus-4-1',
      tokenType: 'input',
      tokens: 100n,
      costUsd: '0.010000',
      rateCardId: rc!.id,
      rateCardVersion: rc!.version,
      fidelityTier: 'tier-1',
      costBasis: 'estimated',
      tsEvent: new Date(),
    })
    const rows = await t.db.execute<{ conversation_id: string; instance_id: string }>(sql`
      SELECT
        COALESCE(ar.claude_session_id, ar.instance_id::text) AS conversation_id,
        MAX(ar.instance_id::text) AS instance_id
      FROM attribution_record ar
      JOIN instance_attestation sa ON sa.instance_id = ar.instance_id
      WHERE sa.teammate_id = ${priyaId}::uuid AND ar.claude_session_id = ${conv}
      GROUP BY COALESCE(ar.claude_session_id, ar.instance_id::text)
    `)
    const row = [...rows][0]!
    expect(row.conversation_id).toBe(conv)
    expect(row.instance_id).toBe(inst)
  })
})
