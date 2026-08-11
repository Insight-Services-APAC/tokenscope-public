/*
 * Every builder that ends with the SHARED final projection must define every
 * scalar that projection references.
 *
 * WHY THIS EXISTS. `KQL_PROJECTED_COLUMNS` is single-sourced so the KQL and the
 * positional fallback parser cannot drift apart. But it is shared by MORE THAN
 * ONE builder, and adding a column to it silently obliges every one of them to
 * define that scalar. Adding `UserEmail: '_uemail'` for the emitting-identity
 * work updated `buildSessionUsageKql` and not `buildSessionUsageKqlGenAI`, which
 * left the GenAI query referencing an undefined `_uemail` — a Log Analytics
 * "unresolved scalar" failure the moment `NUXT_COPILOT_NATIVE_OTEL` is enabled.
 *
 * It shipped past a design that named this exact hazard, past a full test suite,
 * and past an adversarial review, because the broken builder is behind a
 * default-off flag and nothing executes it. A structural test does not care
 * whether the code path runs.
 *
 * This asserts the property STRUCTURALLY rather than enumerating builders one by
 * one: whatever the final clause references must already be bound. A future
 * column added to KQL_PROJECTED_COLUMNS fails here for every builder that
 * forgets it, without anyone remembering to extend this file.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionUsageKql, buildSessionUsageKqlGenAI } from '../../../server/azure/reader'

/** The `_alias` scalars a KQL body binds via `extend` / `project ... = ...`. */
function boundScalars(kql: string): Set<string> {
  const bound = new Set<string>()
  for (const m of kql.matchAll(/(_[a-z0-9_]+)\s*=/gi)) bound.add(m[1]!)
  return bound
}

/** The `_alias` scalars the FINAL `| project` line consumes. */
function finalClauseScalars(kql: string): string[] {
  const lines = kql.split('\n').filter((l) => l.includes('| project '))
  const final = lines[lines.length - 1] ?? ''
  return [...new Set([...final.matchAll(/(_[a-z0-9_]+)/gi)].map((m) => m[1]!))]
}

const BUILDERS: ReadonlyArray<[string, (id: string) => string]> = [
  ['buildSessionUsageKql', (id) => buildSessionUsageKql(id)],
  ['buildSessionUsageKqlGenAI', (id) => buildSessionUsageKqlGenAI(id)],
]

const SESSION_ID = '00000000-0000-4000-8000-000000000001'

describe('shared KQL final projection', () => {
  for (const [name, build] of BUILDERS) {
    it(`${name} binds every scalar its final projection reads`, () => {
      const kql = build(SESSION_ID)
      const bound = boundScalars(kql)
      const missing = finalClauseScalars(kql).filter((s) => !bound.has(s))

      expect(
        missing,
        `${name} projects ${missing.join(', ')} without binding them. Log Analytics ` +
          `rejects the whole query as an unresolved scalar — and if the builder is ` +
          `behind a feature flag, nothing notices until the flag is turned on. ` +
          `Add each to this builder's extend/project, even as a constant ''.`,
      ).toEqual([])
    })
  }

  it('covers every builder that uses the shared clause', async () => {
    /*
     * Guards the guard: if someone adds a third builder ending in
     * kqlFinalProjectClause(), BUILDERS above must grow too, or this file gives
     * false confidence over a builder it never sees.
     */
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'server/azure/reader.ts'), 'utf8')
    const callSites = [...src.matchAll(/kqlFinalProjectClause\(\)/g)].length - 1 // minus the definition
    expect(
      callSites,
      `reader.ts has ${callSites} builders using the shared final projection but this ` +
        `test exercises ${BUILDERS.length}. Add the new builder to BUILDERS.`,
    ).toBe(BUILDERS.length)
  })
})
