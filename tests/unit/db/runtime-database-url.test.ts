/*
 * `runtimeDatabaseUrl()` is the whole rollback story for RLS enforcement.
 *
 * The cutover is "set TOKENSCOPE_APP_DATABASE_URL"; the rollback is "unset it".
 * No code change, no migration to reverse, no revision to roll back — which is
 * only true if unsetting it really does restore today's behaviour, byte for
 * byte. That is one `if`, and this is the test that keeps it honest.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { runtimeDatabaseUrl } from '../../../drizzle/connect'

const OWNER = 'postgresql://owner:pw@db.example:5432/tokenscope?sslmode=verify-full'
const APP = 'postgresql://tokenscope_app:pw@db.example:5432/tokenscope?sslmode=verify-full'

afterEach(() => {
  delete process.env.DATABASE_URL
  delete process.env.TOKENSCOPE_APP_DATABASE_URL
})

describe('runtimeDatabaseUrl', () => {
  it('is DATABASE_URL when the app URL is unset — today, and after a rollback', () => {
    process.env.DATABASE_URL = OWNER
    expect(runtimeDatabaseUrl()).toBe(OWNER)
  })

  it('prefers TOKENSCOPE_APP_DATABASE_URL when it is set — the cutover', () => {
    process.env.DATABASE_URL = OWNER
    process.env.TOKENSCOPE_APP_DATABASE_URL = APP
    expect(runtimeDatabaseUrl()).toBe(APP)
  })

  it('treats an empty or whitespace value as unset rather than connecting to ""', () => {
    // An unset Bicep param arrives as an empty string, not as an absent
    // variable. Falling through to DATABASE_URL is what makes a half-applied
    // template a no-op instead of an outage.
    process.env.DATABASE_URL = OWNER
    for (const blank of ['', '   ']) {
      process.env.TOKENSCOPE_APP_DATABASE_URL = blank
      expect(runtimeDatabaseUrl()).toBe(OWNER)
    }
  })

  it('is undefined when neither is set, so callers still raise their own error', () => {
    expect(runtimeDatabaseUrl()).toBeUndefined()
  })
})
