/*
 * Mock-directory contract tests for the #121 fixtures.
 *
 * The Rio Tanaka pair models one human with a standard `@example.com` account
 * (dir-oid-0007) and a separate privileged/CLD account (dir-oid-0007-cld) on
 * the tenant `*.onmicrosoft.com` domain — the shape the directory-exclusion
 * policy targets. These tests pin the mail/upn provenance so the exclusion
 * matcher has the fields it needs, and confirm each account resolves distinctly
 * by oid (getDirectoryUserByOid does NOT exclude — the policy is applied by the
 * search/guard/worker callers, not the pure Graph client).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { getDirectoryUserByMailOrUpn, getDirectoryUserByOid } from '../../../server/azure/directory'

beforeAll(() => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
})

describe('mock directory — #121 fixtures', () => {
  it('the standard account resolves by its @example.com address', async () => {
    const u = await getDirectoryUserByMailOrUpn('rio.tanaka@example.com')
    expect(u?.oid).toBe('dir-oid-0007')
  })

  it('the CLD account carries onmicrosoft upn + null mail (realistic privileged-account shape)', async () => {
    const cld = await getDirectoryUserByOid('dir-oid-0007-cld')
    expect(cld?.upn).toBe('rtanaka-cld@contoso.onmicrosoft.com')
    expect(cld?.mail).toBeNull()
    // getDirectoryUserByOid resolves it (the policy excludes at the caller, not here).
    expect(cld?.oid).toBe('dir-oid-0007-cld')
  })

  it('the standard account carries matching mail + upn', async () => {
    const primary = await getDirectoryUserByOid('dir-oid-0007')
    expect(primary?.mail).toBe('rio.tanaka@example.com')
    expect(primary?.upn).toBe('rio.tanaka@example.com')
  })

  it('a cloud-only real user (onmicrosoft-only, no vanity twin) still resolves', async () => {
    const kai = await getDirectoryUserByOid('dir-oid-0008')
    expect(kai?.upn).toBe('kwong@contoso.onmicrosoft.com')
    expect(kai?.oid).toBe('dir-oid-0008')
  })
})
