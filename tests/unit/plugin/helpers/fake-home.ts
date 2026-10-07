/*
 * Move the account's home for ONE spawned Node child.
 *
 * The plugin scripts anchor the trusted store on the passwd entry
 * (`os.userInfo().homedir`, real-home.mjs), which no environment variable moves.
 * That is right for production and means a spawned redeem writes the REAL
 * `~/.tokenscope` for anything not steered by argv, such as the isolated
 * settings index in the default store. The preload patches `os.userInfo` in the
 * child before the script loads, so the child's "real home" is a fixture dir.
 *
 * pwsh on Linux takes its profile from HOME, so `HOME` in `env` moves that lane.
 * Windows has no equivalent for PowerShell (GetFolderPath ignores HOME).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PRELOAD = [
  "import os from 'node:os'",
  "import { syncBuiltinESMExports } from 'node:module'",
  "if (!process.env.TS_TEST_REAL_HOME) throw new Error('fake-home preload: TS_TEST_REAL_HOME is not set')",
  'const real = os.userInfo',
  'os.userInfo = (...a) => ({ ...real(...a), homedir: process.env.TS_TEST_REAL_HOME })',
  'syncBuiltinESMExports()',
].join('\n')

/** Write the preload into `dir`; returns its path. */
export function writeFakeHomePreload(dir: string): string {
  const path = join(dir, 'fake-home-preload.mjs')
  writeFileSync(path, PRELOAD)
  return path
}

/** Node argv prefix + env that make `home` the child's account home. */
export function fakeHomeNode(preload: string, home: string): { args: string[]; env: Record<string, string> } {
  return {
    args: ['--import', pathToFileURL(preload).href],
    env: { HOME: home, TS_TEST_REAL_HOME: home },
  }
}

/** The real default store's isolated index, verbatim, or null: compare before and after a suite. */
export function realIsolatedIndex(realHome: string): string | null {
  const p = join(realHome, '.tokenscope', 'isolated-settings-files.claude-code.json')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
