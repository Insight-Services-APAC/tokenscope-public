// @vitest-environment node
/*
 * runPendingPlacementGc — prunes REPLAYED (placed) owed bills from pending_placement
 * (mig 0066) past a retention window, against testcontainers Postgres.
 *
 * The load-bearing invariant: an un-replayed row (placed_at IS NULL) is NEVER
 * deleted, regardless of age — deleting one silently loses owed spend not yet in
 * actual_spend. We pin both the happy path and that invariant.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { runPendingPlacementGc } from '../../../server/workers/pending-placement-gc'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
}, 180_000)
afterAll(async () => {
  await stopTestDb(t)
}, 30_000)
beforeEach(async () => {
  await t.client`DELETE FROM pending_placement`
})

// Insert a pending_placement row with explicit first_seen_at + placed_at so we can
// drive the retention window deterministically.
async function seed(email: string, placedAgeDays: number | null): Promise<void> {
  const placedAt =
    placedAgeDays == null ? null : `now() - (${placedAgeDays} * INTERVAL '1 day')`
  await t.client.unsafe(`
    INSERT INTO pending_placement
      (provider, actual_source, identity_email, tool, date, cost_usd, first_seen_at, placed_at)
    VALUES ('anthropic', 'anthropic-analytics-api:o1', lower('${email}'), 'claude-code',
            '2026-06-01', 1.0,
            now() - INTERVAL '120 days',
            ${placedAt ?? 'NULL'})`)
}

async function emails(): Promise<string[]> {
  const rows = await t.client<{ email: string }[]>`
    SELECT identity_email AS email FROM pending_placement ORDER BY identity_email`
  return rows.map((r) => r.email)
}

describe('runPendingPlacementGc', () => {
  it('deletes a placed+old row, keeps a placed+recent row and an un-replayed row', async () => {
    await seed('old-placed@example.com', 100) // placed 100d ago → past the 90d window
    await seed('recent-placed@example.com', 10) // placed 10d ago → within the window
    await seed('unplaced@example.com', null) // never replayed → must never be deleted

    const r = await runPendingPlacementGc(t.db)
    expect(r.deleted).toBe(1)
    expect(await emails()).toEqual(['recent-placed@example.com', 'unplaced@example.com'])
  })

  it('NEVER deletes an un-replayed row even when arbitrarily old', async () => {
    await seed('ancient-unplaced@example.com', null) // first_seen 120d ago, placed_at NULL
    const r = await runPendingPlacementGc(t.db, { olderThanDays: 0 })
    expect(r.deleted).toBe(0)
    expect(await emails()).toEqual(['ancient-unplaced@example.com'])
  })

  it('honours a custom olderThanDays window', async () => {
    await seed('placed-15d@example.com', 15)
    // Default 90d keeps it; a 7d window prunes it.
    expect((await runPendingPlacementGc(t.db)).deleted).toBe(0)
    expect((await runPendingPlacementGc(t.db, { olderThanDays: 7 })).deleted).toBe(1)
    expect(await emails()).toEqual([])
  })
})
