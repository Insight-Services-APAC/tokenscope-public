// @vitest-environment node
/*
 * WRITE-TIME billing-lane classification through the read joiner (mig 0119).
 * Design: docs/design/emitting-identity-and-subscription-type.md §1, §2, §5, §12.
 *
 * A telemetry record carries TWO identities: which DEVICE emitted it
 * (tokenscope.instance_id) and which ACCOUNT was signed in (Claude's per-event
 * user.email). This file pins the boundary between them:
 *
 *   - MONEY BINDS TO THE DEVICE. Nothing about the emitting address may move
 *     spend to a different teammate. (`money still binds to the instance`)
 *   - THE LANE IS DECIDED FROM THE ACCOUNT, once, at write time, and the only
 *     write that may ever change it is a backfill filling an 'unknown'.
 *
 * Every assertion here is written to go RED if its production line is removed —
 * see the per-test notes naming the exact line each one guards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runReadJoiner } from '../../../server/workers/azure-monitor-reader'
import { runAggregateRollup } from '../../../server/workers/aggregate-rollup'
import { WATERMARK_LOOKBACK_MS, type TelemetryReader, type UsageRecord } from '../../../server/azure/reader'

let t: TestDb

class StubReader {
  constructor(public readonly map: Map<string, UsageRecord[]>) {}
  async getSessionUsage(sessionId: string, sinceTsEvent?: Date): Promise<UsageRecord[]> {
    const all = this.map.get(sessionId) ?? []
    if (!sinceTsEvent) return all
    const cutoff = sinceTsEvent.getTime() - WATERMARK_LOOKBACK_MS
    return all.filter((u) => new Date(u.tsEvent).getTime() > cutoff)
  }
}

const REGION = '11111111-0119-0000-0000-000000000001'
const OU = '22222222-0119-0000-0000-000000000001'
const DEV = '33333333-0119-0000-0000-000000000001'
const OTHER = '33333333-0119-0000-0000-000000000002'
const INSTANCE = 'aaaa0119-0000-0000-0000-000000000001'

/** The teammate's PRIMARY address — always in the enterprise set. */
const PRIMARY = 'dev@example.com'
/**
 * A linked alias, FLAGGED is_enterprise. Stored MIXED CASE on purpose: it
 * proves the SET side of the comparison is canonicalised, not just the record
 * side. This is the design's expected real-world case (§2) — an acquired-company
 * or vanity domain that still routes SSO.
 */
const ALIAS_STORED = 'Alias@Acquired.TEST'
const ALIAS = 'alias@acquired.test'
/** Linked but NOT flagged — a known address that is nonetheless not enterprise. */
const UNFLAGGED = 'personal@gmail.test'
/** Another teammate's primary address, used to prove money does not follow it. */
const OTHERS_PRIMARY = 'other@example.com'

/**
 * One single-token-type span. `lawCostUsd` makes the cost provider-priced and
 * therefore deterministic, so a lane assertion never has to reason about rate
 * cards. Distinct sourceRunId + tsEvent give each record its own ledger row
 * under the (instance, conversation, ts_event, token_type, model, source_run_id)
 * unique index.
 */
function span(o: {
  runId: string
  ts: string
  emittingEmail?: string
  conv?: string
  tokens?: number
  cost?: number
  organizationId?: string
}): UsageRecord {
  return {
    tokens: o.tokens ?? 1000,
    tokenType: 'output',
    model: 'claude-fable-5',
    tsEvent: o.ts,
    sourceRunId: o.runId,
    claudeSessionId: o.conv ?? `conv-${o.runId}`,
    lawCostUsd: o.cost ?? 1.5,
    ...(o.emittingEmail === undefined ? {} : { emittingEmail: o.emittingEmail }),
    // BOTH fields, because that is what the parser emits for a storable
    // organization.id: `organizationId` is the raw reconciliation-lane operand,
    // `emittingOrgId` the bounded copy the joiner persists as emitting_org_id
    // (server/azure/reader.ts). They diverge only when the value is too long or
    // unsafe to store — covered in tests/integration/azure/joiner.test.ts.
    ...(o.organizationId === undefined
      ? {}
      : { organizationId: o.organizationId, emittingOrgId: o.organizationId }),
  }
}

interface LedgerRow {
  source_run_id: string
  teammate_id: string
  billing_lane: string
  emitting_email: string | null
  emitting_org_id: string | null
  cost_usd: string
  tokens: string
  claude_session_id: string | null
}

async function ledger(): Promise<LedgerRow[]> {
  return t.client<LedgerRow[]>`
    SELECT source_run_id, teammate_id::text AS teammate_id, billing_lane,
           emitting_email, emitting_org_id, cost_usd::text AS cost_usd,
           tokens::text AS tokens, claude_session_id
      FROM attribution_record
     WHERE instance_id = ${INSTANCE}::uuid
     ORDER BY source_run_id`
}

async function join(records: UsageRecord[]): Promise<void> {
  const reader = new StubReader(new Map([[INSTANCE, records]])) as unknown as TelemetryReader
  await runReadJoiner(t.db, reader, { sessionIds: [INSTANCE] })
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client.unsafe(`
    INSERT INTO region (id, code, display_name) VALUES ('${REGION}', 'lane', 'Lane');
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type, is_cost_owning_unit)
      VALUES ('${OU}', '${REGION}', 'lane'::ltree, 'lane-bu', 'Lane BU', 'bu', TRUE);
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id) VALUES
      ('${DEV}',   'oid-lane-dev',   '${PRIMARY}',        '${REGION}', '${OU}'),
      ('${OTHER}', 'oid-lane-other', '${OTHERS_PRIMARY}', '${REGION}', '${OU}');
    -- The enterprise address set is { teammate.email } ∪ { identities flagged
    -- is_enterprise }. Both rows below are linked to DEV; only the first is
    -- flagged, so exactly one of them widens the set.
    INSERT INTO teammate_identity_map
      (teammate_id, system, identifier, identifier_kind, is_enterprise) VALUES
      ('${DEV}', 'claude-code', '${ALIAS_STORED}', 'email', TRUE),
      ('${DEV}', 'claude-code', '${UNFLAGGED}',    'email', FALSE);
    INSERT INTO instance_attestation
      (instance_id, principal_oid, principal_email, teammate_id, project_code_hash,
       raw_project_code, tool, session_token_hash, ts_start, ts_actual_end,
       region_id, org_unit_id, cost_owning_unit_id)
    -- project_code_hash is the DEVICE's and is NOT what attributes a record
    -- (the joiner uses the per-EVENT claim); it is present only because an
    -- 'attested' row is required to carry one. No records here claim a project,
    -- so every ledger row below is deliberately unallocated.
    VALUES ('${INSTANCE}', 'oid-lane-dev', '${PRIMARY}', '${DEV}', 'h-lane', 'LANE-1',
            'claude-code', 'hashLane', '2026-07-01 00:00:00+00', '2026-07-31 23:59:00+00',
            '${REGION}', '${OU}', '${OU}');
  `)
}, 180_000)

afterAll(async () => {
  if (t) await stopTestDb(t)
}, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM attribution_record WHERE instance_id = ${INSTANCE}::uuid`
})

describe('billing lane — the write-time truth table (§12)', () => {
  it('stamps each of the four verdicts, and folds case + whitespace into the canonical one', async () => {
    /*
     * GUARDS: classifyBillingLane + loadEnterpriseAddressSet's is_enterprise
     * predicate + canonicaliseEmail on BOTH operands.
     *
     * Reverting any one of them moves at least one row:
     *   - drop the is_enterprise filter  → `alias` and `unflagged` both become
     *     provider-billed (the unflagged assertion goes red)
     *   - drop canon on the RECORD side  → `padded` becomes self-billed
     *   - drop canon on the SET side     → `alias` becomes self-billed
     *   - drop the absent → unknown arm  → `absent` becomes self-billed
     */
    await join([
      span({ runId: 'req-primary', ts: '2026-07-10T09:00:00Z', emittingEmail: PRIMARY }),
      span({ runId: 'req-alias', ts: '2026-07-10T09:01:00Z', emittingEmail: ALIAS }),
      span({ runId: 'req-unflagged', ts: '2026-07-10T09:02:00Z', emittingEmail: UNFLAGGED }),
      span({ runId: 'req-absent', ts: '2026-07-10T09:03:00Z' }),
      // Deliberately NOT pre-canonicalised — mimicking any producer that skips
      // the parser's canon step. The verdict must be identical to `req-primary`.
      span({ runId: 'req-padded', ts: '2026-07-10T09:04:00Z', emittingEmail: '  DEV@example.com  ' }),
    ])

    const rows = await ledger()
    expect(rows.map((r) => [r.source_run_id, r.billing_lane])).toEqual([
      ['req-absent', 'unknown'],
      ['req-alias', 'provider-billed'],
      ['req-padded', 'provider-billed'],
      ['req-primary', 'provider-billed'],
      ['req-unflagged', 'self-billed'],
    ])

    // The COLUMN's contract is "canonicalised" — not merely "the lane was
    // decided using a canonical form". A stored mixed-case address would make
    // every later consumer (the prompt, dismissal keys, the admin
    // different-teammate flag) re-derive canon or silently mismatch.
    const byRun = new Map(rows.map((r) => [r.source_run_id, r]))
    expect(byRun.get('req-padded')!.emitting_email).toBe(PRIMARY)
    expect(byRun.get('req-alias')!.emitting_email).toBe(ALIAS)
    expect(byRun.get('req-absent')!.emitting_email).toBeNull()
  })

  it('classifies COST and TOKENS identically — one row carries both, so they cannot describe different populations', async () => {
    /*
     * §7: `unaccounted_usage` recomputes cost AND tokens from the same operand.
     * At write time that reduces to: the lane is a property of the ROW, so the
     * row's dollars and its tokens are always on the same side. Asserted here
     * rather than assumed, because the failure it prevents (a lane decided per
     * measure) would be invisible until the two totals disagreed downstream.
     */
    await join([
      span({ runId: 'req-ct-self', ts: '2026-07-11T09:00:00Z', emittingEmail: UNFLAGGED, tokens: 4242, cost: 9.5 }),
      span({ runId: 'req-ct-prov', ts: '2026-07-11T09:01:00Z', emittingEmail: PRIMARY, tokens: 1111, cost: 3.25 }),
    ])
    const rows = await ledger()
    const self = rows.find((r) => r.source_run_id === 'req-ct-self')!
    const prov = rows.find((r) => r.source_run_id === 'req-ct-prov')!
    expect([self.billing_lane, self.tokens, Number(self.cost_usd)]).toEqual(['self-billed', '4242', 9.5])
    expect([prov.billing_lane, prov.tokens, Number(prov.cost_usd)]).toEqual(['provider-billed', '1111', 3.25])
  })

  it('MONEY STILL BINDS TO THE INSTANCE: an address belonging to another teammate does not move the spend', async () => {
    /*
     * The one property this design must not break. The emitting address is
     * SELF-REPORTED and unverifiable; the instance attestation is not. If the
     * address could redirect attribution, a one-line edit to a settings file
     * would move someone else's spend onto you.
     *
     * The lane assertion is the other half: emitting under an address outside
     * YOUR set stamps self-billed even when that address is a perfectly valid
     * enterprise address for SOMEBODY ELSE. The set is per-teammate, never
     * global — a global set would make every colleague's address launder
     * personal usage into the enterprise lane.
     */
    await join([span({ runId: 'req-foreign', ts: '2026-07-12T09:00:00Z', emittingEmail: OTHERS_PRIMARY })])
    const [row] = await ledger()
    expect(row!.teammate_id).toBe(DEV)
    expect(row!.billing_lane).toBe('self-billed')
  })

  it('MIXED SESSIONS resolve PER RECORD: one claude_session_id, two addresses, two lanes', async () => {
    /*
     * §12's last invariant, and the reason the stamp is applied inside the
     * per-record loop rather than once per grouped session. A developer who
     * switches accounts mid-conversation produces exactly this shape; a
     * session-level verdict would misclassify one of the two halves and there
     * would be no evidence left on the row to notice with.
     */
    const CONV = 'conv-mixed-0119'
    await join([
      span({ runId: 'req-mix-a', ts: '2026-07-13T09:00:00Z', emittingEmail: PRIMARY, conv: CONV }),
      span({ runId: 'req-mix-b', ts: '2026-07-13T09:05:00Z', emittingEmail: UNFLAGGED, conv: CONV }),
    ])
    const rows = await ledger()
    expect(rows.every((r) => r.claude_session_id === CONV)).toBe(true)
    expect(rows.map((r) => [r.source_run_id, r.billing_lane])).toEqual([
      ['req-mix-a', 'provider-billed'],
      ['req-mix-b', 'self-billed'],
    ])
  })
})

describe('billing lane — replay is FILL-ONLY-WHEN-MISSING (§5)', () => {
  it('fills an unknown row exactly once, then never overwrites the decided lane', async () => {
    /*
     * GUARDS: fillEmittingIdentity, and specifically its COALESCE/CASE shape.
     *
     * Three joins over the SAME span identity:
     *   1. no address        → row lands 'unknown', emitting_email NULL
     *   2. the primary       → the 'unknown' FILLS (this is the capability a
     *                          later backfill-by-replay depends on; with the
     *                          original bare ON CONFLICT DO NOTHING it could
     *                          never happen)
     *   3. a DIFFERENT address → NOTHING moves. A decided lane is immutable,
     *                          and emitting_email is COALESCE-guarded, so the
     *                          evidence that produced the verdict stays with it.
     *
     * Step 3 is the one that matters. "Immutable except when repairing" is what
     * three earlier drafts of this design shipped in spirit, and it is the exact
     * hole through which a present-day identity action rewrites historic
     * residuals, project totals and budgets.
     */
    const TS = '2026-07-14T09:00:00Z'
    const RUN = 'req-backfill'

    await join([span({ runId: RUN, ts: TS })])
    let [row] = await ledger()
    expect([row!.billing_lane, row!.emitting_email, row!.emitting_org_id]).toEqual(['unknown', null, null])

    await join([span({ runId: RUN, ts: TS, emittingEmail: PRIMARY, organizationId: 'org-alpha' })])
    ;[row] = await ledger()
    expect([row!.billing_lane, row!.emitting_email, row!.emitting_org_id]).toEqual([
      'provider-billed',
      PRIMARY,
      'org-alpha',
    ])

    await join([span({ runId: RUN, ts: TS, emittingEmail: UNFLAGGED, organizationId: 'org-beta' })])
    const rows = await ledger()
    // Still ONE row — the fill is an UPDATE of the deduped row, never a second insert.
    expect(rows).toHaveLength(1)
    expect([rows[0]!.billing_lane, rows[0]!.emitting_email, rows[0]!.emitting_org_id]).toEqual([
      'provider-billed',
      PRIMARY,
      'org-alpha',
    ])
  })

  it('a replay never touches the amount or the dimensions it conflicts with', async () => {
    /*
     * The fill statement's SET list contains ONLY the three identity columns.
     * If it ever grew to include an amount, a replay carrying a different cost
     * would silently restate booked money — which is precisely what
     * ON CONFLICT DO NOTHING was protecting against in the first place.
     */
    const TS = '2026-07-15T09:00:00Z'
    const RUN = 'req-amount'
    await join([span({ runId: RUN, ts: TS, tokens: 500, cost: 7.75 })])
    const before = (await ledger())[0]!
    await join([span({ runId: RUN, ts: TS, emittingEmail: PRIMARY, tokens: 999999, cost: 4321 })])
    const after = (await ledger())[0]!
    expect(after.cost_usd).toBe(before.cost_usd)
    expect(after.tokens).toBe(before.tokens)
    expect(after.teammate_id).toBe(before.teammate_id)
    // …while the identity DID fill, so this is not passing because nothing ran.
    expect(after.billing_lane).toBe('provider-billed')
  })

  it('an enriching replay RE-KEYS the incremental rollup; a no-op replay does not', async () => {
    /*
     * The fill changes billing_lane on a HISTORICAL row, and aggregate-rollup's
     * incremental day-set is discovered from ts_recorded
     * (aggregate-rollup.ts:127-132). Without a bump, a backfill replay moved the
     * live residual while the persisted rollups stayed stale indefinitely —
     * the defect class already recorded for confirm-instance.ts:278-279 in
     * docs/wiki/Data-Flow.md §8 gap 6.
     *
     * The bump has to be CONDITIONAL, which is the second half of this test. The
     * fill's original WHERE matched any row with a NULL emitting_org_id — and
     * most emitters never send organization.id at all — so an unconditional bump
     * would re-key the entire watermark-overlap window on every 5-minute tick.
     *
     * MUTATIONS, one per half:
     *   - drop `ts_recorded = now()` from the fill's SET → the day is never
     *     re-keyed and the "cells appear" assertion goes red
     *   - restore the weak WHERE (`emitting_email IS NULL OR emitting_org_id IS
     *     NULL OR billing_lane = 'unknown'`) → the no-op replay bumps and the
     *     last assertion goes red
     */
    const DAY = '2026-07-20'
    const TS = `${DAY}T09:00:00Z`
    const RUN = 'req-rekey'

    const cellsForDay = async (): Promise<number> => {
      const [r] = await t.client<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM attribution_aggregate
         WHERE scope_type = 'teammate' AND scope_id = ${DEV}::uuid
           AND (period_start AT TIME ZONE 'UTC')::date = ${DAY}::date`
      return Number(r!.n)
    }
    const recordedAt = async (): Promise<string> => {
      const [r] = await t.client<{ ts: string }[]>`
        SELECT ts_recorded::text AS ts FROM attribution_record
         WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = ${RUN}`
      return r!.ts
    }

    // A row that landed 'unknown' and was written long enough ago that the
    // incremental window cannot see it — i.e. exactly the row a later backfill
    // replay is for.
    await join([span({ runId: RUN, ts: TS })])
    await t.client`
      UPDATE attribution_record SET ts_recorded = now() - interval '45 days'
       WHERE instance_id = ${INSTANCE}::uuid AND source_run_id = ${RUN}`

    // The rollup self-bootstraps in backfill mode until one completes; record
    // the marker the dispatcher would have persisted so this goes incremental —
    // backfill keys on ts_event and would mask the whole defect.
    await t.client`DELETE FROM attribution_aggregate`
    await t.client`DELETE FROM worker_run WHERE worker_name = 'aggregate-rollup'`
    await t.client`
      INSERT INTO worker_run (worker_name, status, result, started_at)
      VALUES ('aggregate-rollup', 'success', '{"backfillComplete":true}'::jsonb, now())`

    const baseline = await runAggregateRollup(t.db, { lookbackDays: 2, freezeFloorDays: null })
    expect(baseline.mode).toBe('incremental')
    expect(await cellsForDay()).toBe(0) // stale by construction — the premise

    // The enriching replay: 'unknown' → a decided lane.
    await join([span({ runId: RUN, ts: TS, emittingEmail: PRIMARY })])
    const filled = (await ledger())[0]!
    expect(filled.billing_lane).toBe('provider-billed')

    const after = await runAggregateRollup(t.db, { lookbackDays: 2, freezeFloorDays: null })
    expect(after.mode).toBe('incremental')
    expect(await cellsForDay()).toBeGreaterThan(0)

    // A replay that would write the row identically must NOT re-key it. This
    // row has emitting_org_id NULL and the replay offers none, which is the
    // shape the old guard matched on every single tick.
    const settled = await recordedAt()
    await join([span({ runId: RUN, ts: TS, emittingEmail: PRIMARY })])
    expect(await recordedAt()).toBe(settled)
  })
})
