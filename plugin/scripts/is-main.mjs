/*
 * is-main.mjs — "was this module launched directly?" for every runnable script.
 *
 * Node resolves symlinks in the main module's path before loading it, so
 * `import.meta.url` names the REAL file while `process.argv[1]` keeps the path
 * as invoked. Comparing the two as strings therefore fails whenever the install
 * path crosses a symlink or junction: a symlinked ~/.claude, a macOS temp dir
 * (/var -> /private/var), a redirected Windows profile. The script then exits 0
 * having done nothing, and the hook or command reports no error at all.
 *
 * Both sides go through the same realpath here, so they agree however the
 * script was reached. Dependency-free so it vendors verbatim into the Copilot
 * distribution (scripts/sync-copilot-plugin.mjs).
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * @param {string} metaUrl  the caller's `import.meta.url`
 * @param {string | undefined} [argv1]  defaults to `process.argv[1]`
 * @returns {boolean}
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  const self = fileURLToPath(metaUrl)
  if (self === argv1) return true
  try {
    return realpathSync(self) === realpathSync(argv1)
  } catch {
    return false
  }
}
