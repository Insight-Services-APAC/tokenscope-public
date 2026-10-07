/*
 * Materialise a copy of the Claude plugin that a test can EXECUTE (spawn the
 * SessionStart hook, run the emit helper) without touching the developer's real
 * device.
 *
 * Three product paths anchor on the PASSWD home (`os.userInfo().homedir`), which
 * no environment variable can move — that anchor is what makes a repo-supplied
 * HOME harmless in production, and it is exactly why a spawned hook cannot be
 * sandboxed from outside:
 *   - otel-headers-helper.sh mints against `~/.tokenscope` when no --state-dir
 *     is pinned, leaving an access-token cache and, on an unhealthy device, a
 *     failure sentinel the status line reports as real.
 *   - main() calls migrateStoredEndpoints() on `~/.tokenscope`, which on a
 *     pre-split device CREATES the real config.claude-code.json.
 *   - selfHealPluginPaths() rewrites every settings file listed in
 *     `~/.tokenscope/settings-files.claude-code.json`, and every file in the
 *     trusted store's `isolated-settings-files.claude-code.json` index.
 * All four are replaced in the copy. Nothing that uses this fixture asserts the
 * helper's or the migration's own behaviour; they assert what the hook does
 * around them. tests/helpers/real-device-guard.ts fails the run if a test
 * leaves the real STORES or settings.json's enrolment changed; it does not
 * watch the access cache or the sentinel, so a spawned hook that skips this
 * fixture and mints for real is caught only when the mint changes a store.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_SIG = 'export function migrateStoredEndpoints(dir = trustedStateDir(), settingsEnv = null) {'
// Without a TOKENSCOPE_STATE_DIR pin the hook reads the session-scoped settings
// list from the passwd home and would rebuild the developer's REAL listed files
// against this throwaway install.
const SETTINGS_FILES_SIG = 'export function readSettingsFilesList(tool, dir) {'
// Same hazard through the index of session-scoped files with their own state
// dir: it lives in the passwd home, which overriding HOME does not move.
const ISOLATED_FILES_SIG = 'export function readIsolatedSettingsFiles(tool, dir) {'

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
  if (!src.includes(SETTINGS_FILES_SIG)) {
    throw new Error('readSettingsFilesList signature moved; update sandboxed-plugin.ts')
  }
  if (!src.includes(ISOLATED_FILES_SIG)) {
    throw new Error('readIsolatedSettingsFiles signature moved; update sandboxed-plugin.ts')
  }
  writeFileSync(
    runtime,
    src
      .replace(MIGRATION_SIG, `${MIGRATION_SIG}\n  return false // STUBBED by tests/unit/plugin/helpers/sandboxed-plugin.ts`)
      .replace(SETTINGS_FILES_SIG, `${SETTINGS_FILES_SIG}\n  return [] // STUBBED by tests/unit/plugin/helpers/sandboxed-plugin.ts`)
      .replace(ISOLATED_FILES_SIG, `${ISOLATED_FILES_SIG}\n  return [] // STUBBED by tests/unit/plugin/helpers/sandboxed-plugin.ts`),
  )
  return join(dest, 'hooks', 'session-start.mjs')
}
