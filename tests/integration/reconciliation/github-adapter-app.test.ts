// @vitest-environment node
/*
 * GitHub Copilot adapter — APP-MODE DB path against testcontainers Postgres.
 *
 * Exercises pull() with credential.kind='github-app' and a STUBBED App-shaped client
 * (getUserDailyCredits — no live calls). App mode is the enterprise-grain, read-only
 * METRICS path: one users-1-day report per day yields per-user ai_credits_used. Asserts:
 *   - login → teammate resolution via the directory-seeded identity map;
 *   - a resolved login emits ONE copilot_interactive line per (teammate, day) priced at
 *     the flat $0.01/credit, held `indicative` (chargeback-exempt for the NFR enterprise);
 *   - an unmatched login carries forward; a zero-credit row emits no line;
 *   - a per-day report failure is isolated (it doesn't starve the rest of the window).
 *
 * PAT-mode behaviour is unchanged and covered by github-adapter.test.ts (back-compat).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { createGithubAdapterWithClient } from '../../../server/reconciliation/adapters/github'
import type { UserDailyCredits } from '../../../server/reconciliation/adapters/github-client'
import type { ResolvedCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
let teammateId = ''
const ENT = 'acme-partner-demo'
const RESOLVED_LOGIN = 'octocat'
const UNMATCHED_LOGIN = 'ghost-seat'

// App-mode credential: kind='github-app', value = (would be) base64 PEM, appId set. The
// client is stubbed so the value/appId are never used to mint a real token.
const appCredential: ResolvedCredential = {
  secretName: 'partner-demo',
  value: 'unused-in-stub',
  level: 'enterprise',
  kind: 'github-app',
  appId: '1234567',
}

beforeAll(async () => {
  t = await startTestDb()
  await t.client`INSERT INTO region (id, code, display_name) VALUES (gen_random_uuid(), 'apac-gha', 'APAC')`
  const [region] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM region WHERE code = 'apac-gha'`
  await t.client`
    INSERT INTO org_unit (id, region_id, path, code, display_name, unit_type)
    VALUES (gen_random_uuid(), ${region!.id}, 'apac.gha', 'gha-bu', 'GHA BU', 'bu')`
  const [org] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM org_unit WHERE code = 'gha-bu'`
  await t.client`
    INSERT INTO teammate (id, entra_oid, email, region_id, org_unit_id)
    VALUES (gen_random_uuid(), 'oid-gha', 'veli@example.com', ${region!.id}, ${org!.id})`
  const [tm] = await t.client<{ id: string }[]>`SELECT id::text AS id FROM teammate WHERE entra_oid = 'oid-gha'`
  teammateId = tm!.id

  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, billing, credential_secret_name, github_app_id)
    VALUES ('github', ${ENT}, 'Acme Partner Demo', 'reconciled', 'tracked', 'partner-demo', '1234567')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

beforeEach(async () => {
  await t.client`DELETE FROM teammate_identity_map WHERE system = 'github'`
})

async function linkLogin(login: string): Promise<void> {
  await t.client`
    INSERT INTO teammate_identity_map
      (teammate_id, system, identifier, identifier_kind, github_login, enterprise_slug, sso_email, source)
    VALUES
      (${teammateId}, 'github', ${login}, 'username', ${login}, ${ENT}, 'veli@example.com', 'directory-sync')`
}

function row(login: string, credits: number): UserDailyCredits {
  return { login, credits, raw: { user_login: login, ai_credits_used: credits } }
}

describe('GithubAdapter.pull (App mode, metrics DB path)', () => {
  it('reads users-1-day, resolves login → teammate, emits one $0.01/credit line per (teammate, day)', async () => {
    await linkLogin(RESOLVED_LOGIN)
    const getUserDailyCredits = vi.fn(async (_day: string) => [
      row(RESOLVED_LOGIN, 562.57),
      row(UNMATCHED_LOGIN, 10), // no teammate → carry forward
      row('zerocredits', 0), // 0 credits → no line (mirrors the billing path's gross<=0 skip)
    ])
    const adapter = createGithubAdapterWithClient(t.db, { externalRef: ENT, credential: appCredential }, { getUserDailyCredits })

    const lines = await adapter.pull({ startDate: '2026-06-29', endDate: '2026-06-29' })

    expect(lines).toHaveLength(1)
    expect(lines[0]!.subject).toEqual({ kind: 'teammate', teammateId })
    expect(lines[0]!.category).toBe('copilot_interactive')
    expect(lines[0]!.unit).toEqual({ quantity: 562.57, unitType: 'ai-credits' })
    expect(lines[0]!.amountUsd).toBe('5.625700') // 562.57 * $0.01
    expect(lines[0]!.rateUsdPerUnit).toBe('0.01000000')
    expect(lines[0]!.facets).toEqual({ gross: 562.57, discount: 0, net: 562.57 })
    expect(lines[0]!.spendClass).toBe('indicative')
    // partner-demo is an NFR/demo enterprise → chargeback-exempt (keyed off the enterprise
    // slug; the metrics record carries no per-user license org).
    expect(lines[0]!.indicativeReason).toBe('chargeback-exempt')
    expect(lines[0]!.licenseOrg).toBeNull()

    // ONE report fetch for the single day; no seats, no org enumeration.
    expect(getUserDailyCredits).toHaveBeenCalledTimes(1)
    expect(getUserDailyCredits).toHaveBeenCalledWith('2026-06-29')
  })

  it('emits nothing when no report login resolves to a teammate (all carry forward)', async () => {
    // No linkLogin → the roster is empty, so every report row carries forward.
    const getUserDailyCredits = vi.fn(async () => [row(RESOLVED_LOGIN, 50)])
    const adapter = createGithubAdapterWithClient(t.db, { externalRef: ENT, credential: appCredential }, { getUserDailyCredits })
    const lines = await adapter.pull({ startDate: '2026-06-29', endDate: '2026-06-29' })
    expect(lines).toEqual([])
  })

  it('isolates a per-day report failure rather than starving the window', async () => {
    await linkLogin(RESOLVED_LOGIN)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getUserDailyCredits = vi.fn(async (day: string) => {
      if (day === '2026-06-08') throw new Error('boom')
      return [row(RESOLVED_LOGIN, 100)]
    })
    const adapter = createGithubAdapterWithClient(t.db, { externalRef: ENT, credential: appCredential }, { getUserDailyCredits })
    const lines = await adapter.pull({ startDate: '2026-06-07', endDate: '2026-06-08' })
    expect(lines).toHaveLength(1)
    expect(lines[0]!.periodDate).toBe('2026-06-07')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
