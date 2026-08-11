// @vitest-environment node
/*
 * WHO changed the placement decides whether history follows.
 *
 * A directory/graph sync means the person genuinely moved team, and a reorg must
 * not hand February's consumption to March's Business Unit. An admin manual move
 * means a human is correcting a mis-placement, so the record was always wrong
 * and history follows.
 *
 * That distinction is the entire safety property of the feature, and it is
 * enforced by WHICH CODE CAN REACH the re-home. So it is asserted here rather
 * than left to a comment: the sync paths must not be able to import it, and the
 * two admin doors must actually pass it through.
 *
 * Same shape as `reports-lane-firewall.test.ts`, for the same reason — a
 * directory that must never import a module is a property no runtime test can
 * see, because the failure is code that does not exist yet.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MODULE = 'rehome-placement'

/** Every .ts file under a directory, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('the re-home is unreachable from the sync path', () => {
  it('nothing under server/reconciliation or server/workers imports it', () => {
    /*
     * These are the paths a REORG travels: the directory sync, the placement
     * store it writes through, the region re-resolve and the re-enrichment
     * worker. If any of them could re-home history, a person changing team in
     * March would silently rewrite February.
     */
    const offenders = [...walk('server/reconciliation'), ...walk('server/workers')].filter((f) =>
      readFileSync(f, 'utf8').includes(MODULE),
    )
    expect(offenders).toEqual([])
  })

  it('the two ADMIN doors do pass it through', () => {
    /*
     * The other half, and the reason this is not just a ban list: a gate that
     * only forbids would still pass if the feature were wired to nothing.
     */
    for (const door of [
      'server/api/v1/admin/users/[id]/org-unit.patch.ts',
      'server/api/v1/admin/users/bulk-place.post.ts',
    ]) {
      const src = readFileSync(door, 'utf8')
      expect(src, `${door} must accept a rehome instruction`).toMatch(/rehome:/)
      expect(src, `${door} must pass it to placeTeammate`).toMatch(/rehome: body\.rehome/)
    }
  })

  it('placeTeammate treats the re-home as OPT-IN', () => {
    // Absent ⇒ history stays. If this ever became the default, every sync move
    // would start rewriting history and the distinction above would be moot.
    const src = readFileSync('server/db/place-teammate.ts', 'utf8')
    expect(src).toMatch(/rehome\?: RehomePlacementRange/)
    expect(src).toMatch(/opts\.rehome\s*\n?\s*\?/)
  })
})
