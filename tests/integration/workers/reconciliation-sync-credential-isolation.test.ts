// @vitest-environment node
/*
 * reconciliation-sync — per-enterprise isolation of credential RESOLUTION (UF-20).
 *
 * resolveEnterpriseCredential deliberately THROWS (MissingGithubAppKeyError) when an
 * enterprise has opted into GitHub App mode with the private key unwired: a silent PAT
 * fall-back would be a green run with zero attribution. That contract is proven in
 * tests/integration/reconciliation/credentials-github-app.test.ts.
 *
 * What was NOT proven — and was broken — is what the hourly driver does with that throw.
 * The call sat OUTSIDE the per-scope try/catch, so ONE mis-configured enterprise aborted
 * every REMAINING scope in the tick and failed the whole worker_run: an unwired key on
 * enterprise A stopped enterprise B reconciling, and the operator saw a worker failure
 * rather than a scope-level config gap. copilot-pool-bill.ts:611-618 already isolates the
 * identical call per-enterprise; this pins the same shape here.
 *
 * Fixtures are ordered so the THROWING enterprise sorts FIRST (the loop is
 * `ORDER BY external_id`) — otherwise the survivor would have run before the failure and
 * the test would pass with the bug present.
 *
 * The adapter + the Copilot bill writer are stubbed: both reach api.github.com, and this
 * test is about the driver's control flow, not the GitHub surface. Everything else —
 * Postgres, the credential resolver, the engine, the dial resolution — is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'

// Sorts first: proves the survivor runs AFTER the failure, not before it.
const APP_NOKEY_ENT = 'aaa-app-nokey-ent'
const PAT_ENT = 'zzz-pat-mode-ent'

const { pull, runCopilotBillWriter } = vi.hoisted(() => ({
  pull: vi.fn(async () => []),
  runCopilotBillWriter: vi.fn(async () => ({
    flatRowsWritten: 0,
    overageRowsWritten: 0,
    prunedRows: 0,
    seatsCarriedUnmapped: 0,
    seatPagesCapped: false,
    seatPageShort: false,
    // Both of these are SUMMED by runReconciliationSync. Omitting them made the
    // worker execute `0 += undefined`, so copilotSeatOrgsUnavailable landed in
    // worker_run.result as NaN — and this test still passed, because it asserts
    // on the isolation counter, not on the seat counters. A stub of a result type
    // has to carry the whole type; tests/ is not type-checked, so nothing else
    // will say so.
    seatOrgsUnavailable: 0,
    seatRosterIncomplete: false,
  })),
}))

// A github factory that never touches the network. Anthropic is absent on purpose —
// no anthropic org is seeded, so that arm of the driver never looks for one.
vi.mock('../../../server/reconciliation/adapters/registry', () => ({
  ADAPTER_FACTORIES: { github: () => ({ pull }) },
}))

vi.mock('../../../server/workers/copilot-bill', async () => {
  const actual =
    await vi.importActual<typeof import('../../../server/workers/copilot-bill')>(
      '../../../server/workers/copilot-bill',
    )
  return { ...actual, runCopilotBillWriter }
})

/* eslint-disable import/first */
import { runReconciliationSync } from '../../../server/workers/reconciliation-sync'
/* eslint-enable import/first */

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()

  // App-mode INTENDED (github_app_id set) with NO NUXT_GITHUB_APP_KEY_* wired → the
  // resolver throws MissingGithubAppKeyError for this enterprise.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name, github_app_id)
    VALUES ('github', ${APP_NOKEY_ENT}, 'App No Key', 'reconciled', 'uf20-app-nokey', '4242')`

  // A perfectly healthy PAT-mode enterprise that must still reconcile.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${PAT_ENT}, 'PAT Mode', 'reconciled', 'uf20-pat-mode')`
  process.env.NUXT_GITHUB_PAT_UF20_PAT_MODE = 'ghp_healthy_enterprise'
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_PAT_UF20_PAT_MODE
  await stopTestDb(t)
}, 30_000)

describe('reconciliation-sync — an unwired App key is isolated to its own enterprise', () => {
  it('the tick COMPLETES, counts the failure, and still reconciles the healthy enterprise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runReconciliationSync(t.db, { now: new Date('2026-08-14T09:00:00Z') })

      // Both enterprises were considered; the broken one is an ERROR, not a silent skip
      // (scopesSkippedNoCredential means "no credential configured", a different fact).
      expect(result.scopesConsidered).toBe(2)
      expect(result.scopesErrored).toBe(1)
      expect(result.scopesSkippedNoCredential).toBe(0)

      // The survivor: it ran, and it ran on the PAT lane.
      expect(result.scopesRun).toBe(1)
      expect(result.githubPatCredentialScopes).toBe(1)
      expect(result.githubAppCredentialScopes).toBe(0)
      expect(pull).toHaveBeenCalledTimes(1)

      // The failure is on the log too — a scope that fails every tick has to be findable.
      const warned = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(warned).toContain(APP_NOKEY_ENT)
      // ...and the enterprise that worked is not reported as failing.
      expect(warned).not.toContain(PAT_ENT)
    } finally {
      warn.mockRestore()
    }
  })
})
