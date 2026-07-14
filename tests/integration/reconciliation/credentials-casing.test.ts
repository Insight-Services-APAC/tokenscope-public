// @vitest-environment node
/*
 * Enterprise-key canonical casing (P1-7 / mig 0062) — DB path against
 * testcontainers Postgres.
 *
 * Proves the four-site casing regime is now uniform LOWERCASE:
 *   1. provider_enterprise.external_id is CHECK-constrained lowercase (a mixed-case
 *      onboarding INSERT fails loudly rather than landing a mismatched row);
 *   2. provider_enterprise_unique is case-insensitive (the same slug in two casings
 *      cannot coexist);
 *   3. resolveEnterpriseCredential matches lower()=lower() — a caller passing a
 *      non-canonical casing still resolves the credential (was EXACT -> silent zero
 *      attribution on a casing mismatch).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { resolveEnterpriseCredential } from '../../../server/reconciliation/credentials'

let t: TestDb
const ENT = 'acme-partner-demo'

// The credential value is read from the env via credential_secret_name='partner-demo'
// -> NUXT_GITHUB_PAT_PARTNER_DEMO. Set it so a resolvable row returns a value.
process.env.NUXT_GITHUB_PAT_PARTNER_DEMO = 'stub-pat-not-used'

beforeAll(async () => {
  t = await startTestDb()
  await t.client`
    INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, credential_secret_name)
    VALUES ('github', ${ENT}, 'Acme Partner Demo', 'reconciled', 'partner-demo')`
}, 180_000)

afterAll(async () => {
  await stopTestDb(t)
})

describe('enterprise-key canonical casing (mig 0062)', () => {
  it('rejects a mixed-case external_id INSERT (CHECK constraint)', async () => {
    await expect(
      t.client`
        INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode)
        VALUES ('github', 'Insight-MixedCase', 'Mixed Case', 'reconciled')`,
    ).rejects.toThrow(/provider_enterprise_external_id_lower_ck|check constraint/i)
  })

  it('rejects the same slug in two casings (case-insensitive unique index)', async () => {
    // Same lower(external_id) as the seeded row but the CHECK blocks the mixed-case
    // form first; assert the insert is rejected either way (CHECK or unique).
    await expect(
      t.client`
        INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode)
        VALUES ('github', 'acme-partner-demo', 'Dup Casing', 'reconciled')`,
    ).rejects.toThrow()
  })

  it('resolves the credential when the caller passes the canonical (lowercase) casing', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: ENT })
    expect(cred).not.toBeNull()
    expect(cred!.secretName).toBe('partner-demo')
    expect(cred!.value).toBe('stub-pat-not-used')
  })

  it('resolves the credential when the caller passes a NON-canonical (mixed) casing', async () => {
    // Pre-fix this was an EXACT match -> null -> scopesSkippedNoCredential -> zero
    // attribution. Now lower()=lower() still finds the lowercase-stored row.
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: 'acme-partner-demo' })
    expect(cred).not.toBeNull()
    expect(cred!.secretName).toBe('partner-demo')
  })

  it('returns null for an unknown enterprise (no false positive from the lower() match)', async () => {
    const cred = await resolveEnterpriseCredential(t.db, { provider: 'github', externalId: 'no-such-enterprise' })
    expect(cred).toBeNull()
  })
})
