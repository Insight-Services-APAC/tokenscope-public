// @vitest-environment node
/*
 * recordJoinerSelectionCap — the reader-side signal for a TRUNCATED joinable-
 * instance selection.
 *
 * The cap has always been detected and threaded into worker_run.result, and
 * nothing ever read it (five write sites, no reader), so a fleet that outgrew
 * NUXT_JOINER_INSTANCE_CAP looked exactly like a healthy one: the surplus simply
 * stopped attributing. The platform admits 50,000 live emit devices while the
 * selection scans 500 per tick, so organic growth reaches this on its own.
 *
 * Real DB via testcontainers/TEST_PG_URL (AGENTS.md: never mock Drizzle). Pins
 * the three properties the 5-minute cadence makes load-bearing:
 *   - a capped run raises ONE admin-routed item;
 *   - a second capped run does NOT duplicate it (idempotent per episode);
 *   - an uncapped run raises nothing AND auto-resolves the open one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  recordJoinerSelectionCap,
  JOINER_SELECTION_CAP,
} from '../../../server/workers/azure-monitor-reader'
import * as schema from '../../../drizzle/schema'

let t: TestDb
let adminId: string
let devId: string

const NOW = new Date('2026-06-20T12:00:00Z')

beforeAll(async () => {
  t = await startTestDb()
  const [region] = await t.db.insert(schema.region).values({ code: 'jsc', displayName: 'JSC' }).returning()
  const regionId = region!.id
  const [bu] = await t.db
    .insert(schema.orgUnit)
    .values({
      regionId,
      path: 'jsc.svc',
      code: 'jsc-svc',
      displayName: 'JSC Services',
      unitType: 'bu',
      isCostOwningUnit: true,
    })
    .returning()
  const buId = bu!.id
  // The signal is admin-routed (resolveAdmins(null) → cross-region roles only),
  // so a platform-admin is the recipient and a plain developer must NOT be.
  const [admin] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-jsc-admin-${randomUUID().slice(0, 8)}`,
      email: `admin.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
      role: 'platform-admin',
      isActive: true,
    })
    .returning({ id: schema.teammate.id })
  adminId = admin!.id
  const [dev] = await t.db
    .insert(schema.teammate)
    .values({
      entraOid: `oid-jsc-dev-${randomUUID().slice(0, 8)}`,
      email: `dev.${randomUUID().slice(0, 8)}@example.com`,
      regionId,
      orgUnitId: buId,
      role: 'developer',
      isActive: true,
    })
    .returning({ id: schema.teammate.id })
  devId = dev!.id
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

async function items(): Promise<
  { id: string; recipient: string; severity: string; kind: string | null; state: string; body: Record<string, unknown> }[]
> {
  const rows = await t.client<
    {
      id: string
      recipient: string
      severity: string
      kind: string | null
      state: string
      body: Record<string, unknown>
    }[]
  >`
    SELECT id::text AS id, recipient_teammate_id::text AS recipient, severity,
           related_entity_kind AS kind, ack_state AS state, body::jsonb AS body
      FROM inbox_item WHERE category = ${JOINER_SELECTION_CAP} ORDER BY created_at`
  return rows
}

const open = async () => (await items()).filter((r) => ['unread', 'read', 'acknowledged'].includes(r.state))

describe('recordJoinerSelectionCap', () => {
  it('raises ONE admin item on a capped run, never duplicates it, and clears it when the selection fits', async () => {
    await t.client`DELETE FROM inbox_item WHERE category = ${JOINER_SELECTION_CAP}`

    // 1. A capped run raises exactly one item, to the platform-admin only.
    const first = await recordJoinerSelectionCap(t.db, 500, { now: NOW })
    expect(first).toEqual({ raised: 1, skippedExisting: 0, autoResolved: 0 })
    const raised = await items()
    expect(raised.length).toBe(1)
    expect(raised[0]!.recipient).toBe(adminId)
    expect(raised[0]!.recipient).not.toBe(devId)
    // A capacity warning, not the outage — the starved device still pages
    // urgently as attribution-gap. Severity comes from the dispatcher's default
    // for the category, so this assertion is what pins that registration.
    expect(raised[0]!.severity).toBe('attention')
    expect(raised[0]!.kind).toBe('read-path')
    expect(raised[0]!.body.cap).toBe(500)
    expect(raised[0]!.body.worker).toBe('azure-monitor-read')
    // The remedy has to name the knob that actually moves the cap.
    expect(String(raised[0]!.body.hint)).toContain('NUXT_JOINER_INSTANCE_CAP')

    // 2. The next 5-minute tick is still capped: no duplicate, one open item.
    const second = await recordJoinerSelectionCap(t.db, 500, { now: NOW })
    expect(second).toEqual({ raised: 0, skippedExisting: 1, autoResolved: 0 })
    expect((await items()).length).toBe(1)

    // …and a LOWER cap mid-episode is still the same episode, not a second alert.
    const third = await recordJoinerSelectionCap(t.db, 200, { now: NOW })
    expect(third.raised).toBe(0)
    expect((await open()).length).toBe(1)

    // 3. The fleet fits again → the open item auto-resolves.
    const recovered = await recordJoinerSelectionCap(t.db, null, { now: NOW })
    expect(recovered).toEqual({ raised: 0, skippedExisting: 0, autoResolved: 1 })
    expect((await open()).length).toBe(0)
    expect((await items())[0]!.state).toBe('resolved')

    // 4. An uncapped run with nothing open is a clean no-op (no churn every tick).
    const quiet = await recordJoinerSelectionCap(t.db, null, { now: NOW })
    expect(quiet).toEqual({ raised: 0, skippedExisting: 0, autoResolved: 0 })
    expect((await items()).length).toBe(1)

    // 5. A RELAPSE after recovery opens a fresh episode rather than staying silent.
    const relapse = await recordJoinerSelectionCap(t.db, 500, { now: NOW })
    expect(relapse.raised).toBe(1)
    expect((await open()).length).toBe(1)
  })
})
