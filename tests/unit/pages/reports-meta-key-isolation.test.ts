// @vitest-environment node
/*
 * GUARD — nothing may resolve the shared 'reports-meta' key WITHOUT fetching.
 *
 * Sharing the key is fine and intended: ScopeRegion and useDrillGrants ride the
 * shell's one request. The hazard is a caller that combines the shared key with
 * `default:` or `immediate:` — that registers the key as RESOLVED with a truthy
 * value and issues no request, so the shell dedupes onto it, reads `scopes` as
 * absent and renders "You don't have access to any reports" to a granted admin,
 * with no reports/meta row in the network tab. AppHeader did exactly this, and
 * its offending fetch is gone (reporting visibility is now resolved server-side
 * and rides the session — server/auth/nav-visibility.ts). The guard stays
 * because the shared key still has three live callers. Nothing type-checks a
 * fetch key.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
/** Both quote styles, any spacing. */
const KEY_RE = /key:\s*['"]reports-meta['"]/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(e)) out.push(p)
  }
  return out
}

/**
 * The useFetch(...) call surrounding each use of the shared key.
 *
 * Brace-BALANCED from the opening paren. An earlier version cut at the first
 * `})`, so a nested object (`transform: x => ({ ...x })`) truncated the call
 * before its own `immediate:` and the guard passed on a real offender.
 */
function callsUsingKey(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(new RegExp(KEY_RE.source, 'g'))) {
    const start = src.lastIndexOf('useFetch', m.index!)
    if (start === -1) continue
    let depth = 0
    let end = -1
    for (let i = src.indexOf('(', start); i < src.length && i !== -1; i++) {
      const c = src[i]
      if (c === '(' || c === '{' || c === '[') depth++
      else if (c === ')' || c === '}' || c === ']') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    out.push(src.slice(start, end === -1 ? src.length : end + 1))
  }
  return out
}

describe("the shared 'reports-meta' fetch key", () => {
  it('is never resolved by a caller that may not fetch', () => {
    const offenders: string[] = []
    for (const path of walk(resolve(ROOT, 'app'))) {
      const src = readFileSync(path, 'utf8')
      if (!KEY_RE.test(src)) continue
      for (const call of callsUsingKey(src)) {
        const bad = ['default:', 'immediate:'].filter((o) => call.includes(o))
        if (bad.length) offenders.push(`${path.slice(ROOT.length + 1)} — ${bad.join(' + ')}`)
      }
    }
    expect(
      offenders,
      "A caller shares the shell's 'reports-meta' key AND may resolve it without fetching. " +
        'Give it its own key, or let it ride the shell request without a default/immediate.',
    ).toEqual([])
  })
})
