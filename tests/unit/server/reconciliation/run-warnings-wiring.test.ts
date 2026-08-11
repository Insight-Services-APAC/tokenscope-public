/*
 * WIRING GUARD — every key deriveRunWarnings probes must actually be written by a
 * producer, somewhere, onto the object that becomes worker_run.result.
 *
 * WHY THIS EXISTS. run-warnings.ts is a generic key-prober over a jsonb blob, so a
 * probe for a key nobody writes type-checks, passes its own unit test, and produces
 * a warning badge that can never light up. That happened: probes were added for
 * `seatPagesCapped` / `seatPageShort`, which live on CopilotBillResult — but
 * copilot-bill is not a registry worker, so that object is never persisted; only
 * ReconcileSyncResult is. The isolated unit test hid the gap by hand-building a
 * result object containing the keys, which asserts the prober works on input it was
 * handed rather than on input the system produces.
 *
 * This is the mirror image of the failure the sprint was fixing (written but never
 * probed), and it is why a per-instance test is not enough: the NEXT probe added
 * without a producer would be invisible again. Pinning the class is the durable fix.
 *
 * Source-level by necessity: the result objects are built inline in worker bodies,
 * not exported, so there is nothing to import and compare. Same shape as
 * tests/unit/plugin/command-frontmatter.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '../../../..')
const WARNINGS = resolve(ROOT, 'server/reconciliation/run-warnings.ts')

/** Every key name the prober reads, in either the num() or the bracket form. */
function probedKeys(src: string): string[] {
  const keys = new Set<string>()
  for (const m of src.matchAll(/\bnum\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) keys.add(m[1]!)
  for (const m of src.matchAll(/\br\[\s*'([A-Za-z0-9_]+)'\s*\]/g)) keys.add(m[1]!)
  return [...keys]
}

/** Recursively collect .ts sources under a directory. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('deriveRunWarnings probes are wired to a real producer', () => {
  const src = readFileSync(WARNINGS, 'utf8')
  const keys = probedKeys(src)

  it('finds the probes (guards against the extractor silently matching nothing)', () => {
    // If this regex stops matching, every assertion below vacuously passes.
    expect(keys.length).toBeGreaterThanOrEqual(6)
    expect(keys).toContain('scopesErrored')
  })

  it.each(probedKeys(readFileSync(WARNINGS, 'utf8')))(
    'key %s is assigned by at least one worker/reconciliation producer',
    (key) => {
      // A producer assignment looks like `key: 0,` in a result initialiser or
      // `result.key +=` / `result.key =` in a worker body.
      const assign = new RegExp(`(^|[^\\w.])${key}\\s*:|\\.${key}\\s*(\\+=|=[^=])`)
      const producers = [
        ...sources(resolve(ROOT, 'server/workers')),
        ...sources(resolve(ROOT, 'server/reconciliation')),
      ].filter((f) => f !== WARNINGS && assign.test(readFileSync(f, 'utf8')))

      expect(
        producers.length,
        `deriveRunWarnings probes '${key}' but no worker or reconciliation source assigns it. ` +
          `A probe with no producer is a warning badge that can never light up.`,
      ).toBeGreaterThan(0)
    },
  )
})
