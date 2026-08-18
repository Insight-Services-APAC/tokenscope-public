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

  /*
   * Pin the RULE, not just its effect on today's tree. Mutating a real file to
   * check non-vacuity is unreliable — a key mutated in two places stays green when
   * you break one — so the discriminator is asserted directly on synthetic source.
   */
  it('the producer rule accepts real mutations and rejects a zero-initialised local', () => {
    const producesKey = (source: string, key = 'someCounter') => {
      const propMutation = new RegExp(`\\.${key}\\s*(\\+\\+|\\+=|=[^=])`)
      const localMutation = new RegExp(`(^|[^\\w.])${key}\\s*(\\+\\+|\\+=)`, 'm')
      return propMutation.test(source) || localMutation.test(source)
    }
    // Real producers.
    expect(producesKey('result.someCounter += 1')).toBe(true)
    expect(producesKey('result.someCounter = total')).toBe(true)
    expect(producesKey('let someCounter = 0\nsomeCounter += 1')).toBe(true)
    expect(producesKey('let someCounter = 0\nsomeCounter++')).toBe(true)
    // NOT producers — the dead-counter shapes this guard exists to reject.
    expect(producesKey('let someCounter = 0\nreturn { someCounter }')).toBe(false)
    expect(producesKey('interface R { someCounter: number }')).toBe(false)
    expect(producesKey('const r = { someCounter: 0 }')).toBe(false)
    // A read must never count as a write.
    expect(producesKey('if (bill.someCounter > 0) log()')).toBe(false)
  })

  it.each(probedKeys(readFileSync(WARNINGS, 'utf8')))(
    'key %s is assigned by at least one worker/reconciliation producer',
    (key) => {
      // A producer must MUTATE the key, in one of the two shapes the codebase
      // actually uses: `result.key +=` on the result object, or a local `key += 1`
      // returned via object shorthand (github-coverage-sweep.ts:75-112 does the
      // latter for three of these keys).
      //
      // Deliberately NOT `key\s*:` — that matched the interface declaration
      // `key: number` and the zero-initialiser `key: 0,`, so a counter that was
      // declared, initialised and then never incremented passed this guard while
      // producing a badge that can never light up. That is the same defect one
      // level subtler than the one this file was written for, and it was live:
      // copilotSeatOrgsUnavailable reached the result type with no `+=` anywhere.
      const propMutation = new RegExp(`\\.${key}\\s*(\\+\\+|\\+=|=[^=])`)
      // LOCAL form: increments ONLY. Allowing `=` here re-opened the exact hole
      // this guard exists for — `let key = 0` matched, so a local counter could be
      // declared, initialised and never incremented and still look wired. (The
      // PROPERTY form keeps `=`, because `result.key = value` is a real producer.)
      // Verified against all 18 probed keys: every one has a `++` or `+=`.
      const localMutation = new RegExp(`(^|[^\\w.])${key}\\s*(\\+\\+|\\+=)`, 'm')
      const producers = [
        ...sources(resolve(ROOT, 'server/workers')),
        ...sources(resolve(ROOT, 'server/reconciliation')),
      ].filter((f) => {
        if (f === WARNINGS) return false
        const text = readFileSync(f, 'utf8')
        return propMutation.test(text) || localMutation.test(text)
      })

      expect(
        producers.length,
        `deriveRunWarnings probes '${key}' but no worker or reconciliation source assigns it. ` +
          `A probe with no producer is a warning badge that can never light up.`,
      ).toBeGreaterThan(0)
    },
  )
})
