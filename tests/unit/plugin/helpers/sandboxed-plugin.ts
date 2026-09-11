/*
 * Materialise a copy of the Claude plugin that a test can EXECUTE (spawn the
 * SessionStart hook, run the emit helper) without touching the developer's real
 * device.
 *
 * Two product paths anchor on the PASSWD home (`os.userInfo().homedir`), which
 * no environment variable can move — that anchor is what makes a repo-supplied
 * HOME harmless in production, and it is exactly why a spawned hook cannot be
 * sandboxed from outside:
 *   - otel-headers-helper.sh mints against `~/.tokenscope` when no --state-dir
 *     is pinned, leaving an access-token cache and, on an unhealthy device, a
 *     failure sentinel the status line reports as real.
 *   - main() calls migrateStoredEndpoints() on `~/.tokenscope`, which on a
 *     pre-split device CREATES the real config.claude-code.json.
 * Both are replaced in the copy. Nothing that uses this fixture asserts the
 * helper's or the migration's own behaviour; they assert what the hook does
 * around them. tests/helpers/real-device-guard.ts fails the run if a test
 * leaves the real STORES or settings.json's enrolment changed; it does not
 * watch the access cache or the sentinel, so a spawned hook that skips this
 * fixture and mints for real is caught only when the mint changes a store.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_SIG = 'export function migrateStoredEndpoints(dir = trustedStateDir(), settingsEnv = null) {'

/** Copy `bundleSrc` (the plugin/ tree) to `dest` and neutralise the two paths. Returns the hook path. */
export function materialiseSandboxedPlugin(bundleSrc: string, dest: string): string {
  cpSync(bundleSrc, dest, { recursive: true })
  writeFileSync(
    join(dest, 'scripts', 'otel-headers-helper.sh'),
    `#!/bin/sh\necho '{"Authorization":"Bearer STUB"}'\nexit 0\n`,
    { mode: 0o755 },
  )
  const runtime = join(dest, 'scripts', 'plugin-runtime.mjs')
  const src = readFileSync(runtime, 'utf8')
  if (!src.includes(MIGRATION_SIG)) {
    throw new Error('migrateStoredEndpoints signature moved; update sandboxed-plugin.ts')
  }
  writeFileSync(runtime, src.replace(MIGRATION_SIG, `${MIGRATION_SIG}\n  return false // STUBBED by tests/unit/plugin/helpers/sandboxed-plugin.ts`))
  return join(dest, 'hooks', 'session-start.mjs')
}
