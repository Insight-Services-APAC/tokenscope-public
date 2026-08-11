/*
 * The anti-fossil rule for the normalised-lane modules.
 *
 * WHY THIS TEST EXISTS. `provider_usage_fact` shipped with an Anthropic arm and
 * a GitHub arm that was described as unwritten in half a dozen comments, none of
 * which said WHO would write it or WHEN it stopped being true. At the next
 * reading those comments were no longer notes about a gap — they read as the
 * design. That is how the GitHub arm stayed unbuilt while both providers were
 * sending a model dimension on every row.
 *
 * So: scaffolding is allowed, and it must carry an expiry.
 *
 *   RULE 1 — a comment that defers must name what it is waiting for.
 *   RULE 2 — a branch conditional on a PROVIDER must carry a reference near it,
 *            so a reader can tell "this arm's permanent predicate" apart from
 *            "a narrowing nobody has got round to widening".
 *
 * SCOPE is derived by GLOB, never hand-listed: every `server/workers/provider-*.ts`
 * is in, so a third provider's arm is covered on the day it is created rather
 * than on the day someone remembers to add it here. A repo-wide version of this
 * rule would fire on hundreds of pre-existing comments and be switched off
 * within a week — which is its own kind of fossil.
 *
 * An accepted reference is a task id (`#49`), a migration (`mig 0118`,
 * `0120_...sql`), a branch (`feat/provider-raw-capture`) or the wire-capture
 * directory. All four name something a reader can go and check the state of.
 * A bare "later" or "for now" names nothing and is what this test rejects.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKERS = join(REPO, 'server', 'workers')

/** Every module that derives or writes the normalised provider lane. */
function laneModules(): string[] {
  return readdirSync(WORKERS)
    .filter((f) => /^provider-.*\.ts$/.test(f))
    .sort()
    .map((f) => join('server', 'workers', f))
}

/**
 * A pointer a reader can resolve: a task, a migration, a branch, or the capture
 * directory. Deliberately NOT satisfied by prose like "later" or "in future".
 */
const REFERENCE =
  /#\d+|\bUF-\d+\b|\bmig(ration)? ?0\d{3}\b|\b0\d{3}[_:]|feat\/[a-z0-9-]+|provider-wire-captures/i

/** Phrases that mean "this is not the end state". */
const DEFERRAL =
  /\b(TODO|FIXME|XXX|for now|not yet|unbuilt|until then|until it lands|when it lands|once it lands|deferred|arm only|only arm|not supported|does not exist here)\b/i

/** A branch whose condition is a provider identity. */
const PROVIDER_CONDITION =
  /(===|!==|<>|\s=\s|NOT IN|\bIN\b)\s*'(anthropic|github)'|'(anthropic|github)'\s*(===|!==|<>)/

/** Lines within `radius` of `i`, joined — the comment block a reader sees. */
function context(lines: string[], i: number, radius: number): string {
  return lines.slice(Math.max(0, i - radius), i + radius + 1).join('\n')
}

function scan(rule: RegExp, radius: number): string[] {
  const offenders: string[] = []
  for (const rel of laneModules()) {
    const lines = readFileSync(join(REPO, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!rule.test(line)) return
      if (REFERENCE.test(context(lines, i, radius))) return
      offenders.push(`${rel}:${i + 1}  ${line.trim()}`)
    })
  }
  return offenders
}

describe('the normalised-lane modules carry no scaffolding without an expiry', () => {
  it('finds the modules by glob, so a new arm is in scope the day it exists', () => {
    // Guards the whole file against becoming vacuous: a broken glob would make
    // every rule below pass over an empty set.
    const modules = laneModules()
    expect(modules).toContain('server/workers/provider-transform.ts')
    expect(modules).toContain('server/workers/provider-transform-github.ts')
    expect(modules).toContain('server/workers/provider-fact.ts')
  })

  it('RULE 1 — every deferral names a task, migration, branch or capture', () => {
    /*
     * MUTATION: add `// PAT mode is not yet supported` anywhere in
     * provider-transform-github.ts with no reference within 8 lines → it appears
     * in `offenders` and this goes red. Add `(#49)` to the same line and it
     * passes, which is the whole point: the comment is welcome, the silence
     * about its expiry is not.
     */
    expect(scan(DEFERRAL, 8)).toEqual([])
  })

  it('RULE 2 — every provider-conditional branch carries a reference', () => {
    /*
     * The acceptance criterion for #49, mechanically. `provider = 'github'` in
     * the GitHub arm's own query is legitimate and PERMANENT — the reference
     * beside it is what says so, instead of leaving a future reader to guess
     * whether it is a narrowing someone forgot to widen.
     *
     * MUTATION: delete the "(#49)" from either `WHERE provider = 'github'`
     * comment in provider-transform-github.ts → that line appears in `offenders`
     * and this goes red.
     */
    expect(scan(PROVIDER_CONDITION, 15)).toEqual([])
  })

  it('the rules can actually fire — a deferral with no reference is caught', () => {
    /*
     * A rule that cannot fail certifies nothing. Both regexes are exercised
     * here against synthetic text, so a future edit that (say) breaks the
     * DEFERRAL alternation cannot leave the two assertions above passing
     * vacuously over a rule that matches nothing.
     */
    expect(DEFERRAL.test('// GitHub arm not yet built')).toBe(true)
    expect(REFERENCE.test('// GitHub arm not yet built')).toBe(false)
    expect(REFERENCE.test('// GitHub arm is #49; delete when it lands')).toBe(true)
    expect(PROVIDER_CONDITION.test("if (provider === 'anthropic') return")).toBe(true)
    expect(PROVIDER_CONDITION.test("WHERE r.provider = 'github'")).toBe(true)
    // An assignment is not a branch — the rule must not fire on every row build.
    expect(PROVIDER_CONDITION.test("      provider: 'github' as const,")).toBe(false)
  })
})
