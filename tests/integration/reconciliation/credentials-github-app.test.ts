// @vitest-environment node
/*
 * resolveEnterpriseCredential — GitHub-App credential-kind derivation (mig 0078).
 * DB path against testcontainers Postgres.
 *
 * Proves the fail-loud derivation contract (requirement 4):
 *   - github_app_id NULL  → kind 'github-pat', value from NUXT_GITHUB_PAT_<NAME> (unchanged);
 *   - github_app_id SET + App key present → kind 'github-app', value = base64 PEM, appId set;
 *   - github_app_id SET + App key ABSENT  → THROWS MissingGithubAppKeyError (no silent
 *     fall-back to PAT, even when a PAT env IS present for the same secret name).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  resolveEnterpriseCredential,
  MissingGithubAppKeyError,
} from '../../../server/reconciliation/credentials'

let t: TestDb
const PAT_ENT = 'pat-mode-ent'
const APP_ENT = 'app-mode-ent'
const APP_NOKEY_ENT = 'app-mode-nokey-ent'

// A throwaway base64 value — resolveEnterpriseCredential never parses it (that's the
// adapter/auth's job); it only reads the env value through, so any string works here.
// NOT PEM-armoured (armour trips secret scanners even around a non-key body).
const APP_KEY_B64 = Buffer.from('stub-app-key-resolver-reads-it-through-unparsed').toString('base64')

beforeAll(async () => {
  t = await startTestDb()
  // PAT-mode enterprise: github_app_id NULL, PAT wired.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${PAT_ENT}, 'PAT Mode', 'reconciled', 'pat-mode')`
  process.env.NUXT_GITHUB_PAT_PAT_MODE = 'ghp_classic_pat'

  // App-mode enterprise: github_app_id set, App key wired (NUXT_GITHUB_APP_KEY_APP_MODE).
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name, github_app_id)
    VALUES ('github', ${APP_ENT}, 'App Mode', 'reconciled', 'app-mode', '987654')`
  process.env.NUXT_GITHUB_APP_KEY_APP_MODE = APP_KEY_B64

  // App-mode-but-no-key enterprise: github_app_id set, App key ABSENT, but a PAT env IS
  // present for the same secret name (to prove no silent fall-back).
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name, github_app_id)
    VALUES ('github', ${APP_NOKEY_ENT}, 'App No Key', 'reconciled', 'app-nokey', '555')`
  process.env.NUXT_GITHUB_PAT_APP_NOKEY = 'ghp_should_not_be_used'
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_PAT_PAT_MODE
  delete process.env.NUXT_GITHUB_APP_KEY_APP_MODE
  delete process.env.NUXT_GITHUB_PAT_APP_NOKEY
  await stopTestDb(t)
})

describe('resolveEnterpriseCredential — kind derivation (mig 0078)', () => {
  it('derives PAT mode when github_app_id is NULL', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: PAT_ENT })
    expect(cred).not.toBeNull()
    expect(cred!.kind).toBe('github-pat')
    expect(cred!.value).toBe('ghp_classic_pat')
    expect(cred!.appId).toBeUndefined()
  })

  it('derives App mode (kind + appId + base64 PEM) when github_app_id is set and the App key is wired', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: APP_ENT })
    expect(cred).not.toBeNull()
    expect(cred!.kind).toBe('github-app')
    expect(cred!.appId).toBe('987654')
    expect(cred!.value).toBe(APP_KEY_B64)
  })

  it('FAILS LOUD when App mode is intended but the App key is absent — never falls back to PAT', async () => {
    await expect(
      resolveEnterpriseCredential(t.db, { provider: 'github', externalId: APP_NOKEY_ENT }),
    ).rejects.toBeInstanceOf(MissingGithubAppKeyError)
  })

  it('the fail-loud error names only the (non-secret) secret name, never a key value', async () => {
    let thrown: unknown
    try {
      await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: APP_NOKEY_ENT })
    } catch (e) {
      thrown = e
    }
    const dump = String(thrown)
    expect(dump).toContain('app-nokey')
    expect(dump).not.toContain('ghp_should_not_be_used')
    expect(dump).not.toContain(APP_KEY_B64)
  })
})
