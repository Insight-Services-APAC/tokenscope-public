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
 *
 * S9 addition: the silent-mirror guard — an App key wired under a secret name while
 * github_app_id stays NULL used to select the PAT path with NO signal at all. PAT mode
 * is still selected (first-ship: do not refuse), but it must now warn loudly and record
 * `appKeyMirrorWarning` on the resolved credential so the caller (reconciliation-sync)
 * can surface a downgrade instead of it being silent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { consola } from 'consola'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import {
  resolveEnterpriseCredential,
  MissingGithubAppKeyError,
} from '../../../server/reconciliation/credentials'

let t: TestDb
const PAT_ENT = 'pat-mode-ent'
const APP_ENT = 'app-mode-ent'
const APP_NOKEY_ENT = 'app-mode-nokey-ent'
const MIRROR_ENT = 'mirror-mode-ent'

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

  // Silent-mirror enterprise: github_app_id NULL (PAT mode intended/selected), but an
  // App key IS wired under the SAME secret name — e.g. mid App-mode cutover, or a key
  // provisioned ahead of the DB flip.
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${MIRROR_ENT}, 'Mirror Mode', 'reconciled', 'mirror-mode')`
  process.env.NUXT_GITHUB_PAT_MIRROR_MODE = 'ghp_pat_for_mirror'
  process.env.NUXT_GITHUB_APP_KEY_MIRROR_MODE = APP_KEY_B64
}, 180_000)

afterAll(async () => {
  delete process.env.NUXT_GITHUB_PAT_PAT_MODE
  delete process.env.NUXT_GITHUB_APP_KEY_APP_MODE
  delete process.env.NUXT_GITHUB_PAT_APP_NOKEY
  delete process.env.NUXT_GITHUB_PAT_MIRROR_MODE
  delete process.env.NUXT_GITHUB_APP_KEY_MIRROR_MODE
  await stopTestDb(t)
})

describe('resolveEnterpriseCredential — kind derivation (mig 0078)', () => {
  it('derives PAT mode when github_app_id is NULL (regression pin: neither App key nor mirror warning present)', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: PAT_ENT })
    expect(cred).not.toBeNull()
    expect(cred!.kind).toBe('github-pat')
    expect(cred!.value).toBe('ghp_classic_pat')
    expect(cred!.appId).toBeUndefined()
    expect(cred!.appKeyMirrorWarning).toBeFalsy()
  })

  it('derives App mode (kind + appId + base64 PEM) when github_app_id is set and the App key is wired — unchanged, no mirror warning', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: APP_ENT })
    expect(cred).not.toBeNull()
    expect(cred!.kind).toBe('github-app')
    expect(cred!.appId).toBe('987654')
    expect(cred!.value).toBe(APP_KEY_B64)
    expect(cred!.appKeyMirrorWarning).toBeFalsy()
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

  it('S9 SILENT-MIRROR GUARD: an App key wired but github_app_id NULL still selects PAT (no refuse on first ship), but warns loudly and records appKeyMirrorWarning', async () => {
    // consola, not console: AGENTS.md's logging convention (raised in PR #204
    // review). Spying the wrong sink would silently assert nothing.
    const warnSpy = vi.spyOn(consola, 'warn').mockImplementation(() => {})
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: MIRROR_ENT })
    expect(cred).not.toBeNull()
    expect(cred!.kind).toBe('github-pat') // still PAT — a documented, owner-accepted fallback
    expect(cred!.value).toBe('ghp_pat_for_mirror')
    expect(cred!.appKeyMirrorWarning).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warned = String(warnSpy.mock.calls[0]?.[0] ?? '')
    expect(warned).toContain(MIRROR_ENT)
    // Never logs the key value, even while warning about it.
    expect(warned).not.toContain(APP_KEY_B64)
    warnSpy.mockRestore()
  })
})
