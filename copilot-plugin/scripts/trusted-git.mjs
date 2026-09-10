// SYNC NOTE: Auto-generated copy for standalone copilot-plugin distribution. Source: plugin/scripts/trusted-git.mjs. Re-generate with: npm run sync:copilot-plugin
/*
 * trusted-git.mjs — an absolute path to git, or nothing.
 *
 * `execFileSync('git', …)` resolves the name through the process lookup rules,
 * and on Windows those search the CURRENT DIRECTORY before PATH. The Copilot
 * forwarder runs automatically with a repository as its cwd, so a committed
 * `git.exe` would be executed by opening the repository — the same class Wave 1
 * removed from tag-repo.mjs, in the paths that were not walked with it.
 *
 * The trusted directory lists are absolute and fixed. Nothing here consults
 * PATH, the cwd, or any environment variable: those are the channels a
 * repository contributes to, and this module exists to not use them. Mirrors
 * TRUSTED_PATH in otel-headers-helper.sh.
 *
 * Returns null when git is not in a trusted location. EVERY caller is
 * best-effort (an org URL, a tracked-file test, a git email) and must degrade
 * rather than fall back to a name lookup — falling back would reinstate exactly
 * the bug this prevents.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const POSIX_DIRS = ['/usr/local/bin', '/usr/bin', '/bin', '/opt/homebrew/bin', '/opt/local/bin']

// Absolute install locations, not %ProgramFiles% — that variable is part of the
// environment a settings merge can contribute to.
const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files\\Git\\bin\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\bin\\git.exe',
]

let cached
/** Absolute path to a trusted git binary, or null when there isn't one. */
export function trustedGitPath() {
  if (cached !== undefined) return cached
  const candidates =
    process.platform === 'win32' ? WINDOWS_CANDIDATES : POSIX_DIRS.map((d) => join(d, 'git'))
  cached = candidates.find((p) => existsSync(p)) ?? null
  return cached
}

/** Test seam: drop the memoised answer. */
export function resetTrustedGitPathCache() {
  cached = undefined
}
