// @vitest-environment node
/*
 * The two sync manifests must name the SAME files.
 *
 * `scripts/sync-copilot-plugin.mjs` decides what gets vendored into
 * copilot-plugin/; `scripts/check-copilot-plugin-sync.mjs` decides what CI
 * checks for drift. They are hand-maintained duplicates, so a file added to the
 * syncer alone is copied but never gated: it drifts silently, which is the one
 * outcome the gate exists to prevent.
 *
 * That is not hypothetical. `device-store.mjs` was added to the syncer and
 * missed the checker in the same change, and `trusted-git.mjs` had been in that
 * state already. Both were found by review rather than by CI, which is the
 * point of this test.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

/** Every quoted `<name>.mjs` / `<name>.sh` inside the file's FILES array. */
function manifest(relPath: string): string[] {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
  const start = src.indexOf('const FILES = [')
  expect(start, `${relPath} has no FILES array`).toBeGreaterThan(-1)
  const body = src.slice(start, src.indexOf('\n]', start))
  return [...body.matchAll(/'([^']+\.(?:mjs|sh))'/g)].map((m) => m[1]).sort()
}

describe('sync manifests agree', () => {
  it('every file the syncer vendors is also gated by the drift checker', () => {
    const synced = manifest('scripts/sync-copilot-plugin.mjs')
    const checked = manifest('scripts/check-copilot-plugin-sync.mjs')
    expect(synced.length).toBeGreaterThan(0)
    // Named difference rather than a bare equality, so a failure says WHICH file.
    expect(synced.filter((f) => !checked.includes(f))).toEqual([])
    expect(checked.filter((f) => !synced.includes(f))).toEqual([])
  })

  it('gates the store-layout module specifically', () => {
    // Its whole invariant is that both lanes agree on a filename, so an
    // un-gated copy defeats the module outright.
    expect(manifest('scripts/check-copilot-plugin-sync.mjs')).toContain('device-store.mjs')
  })
})
