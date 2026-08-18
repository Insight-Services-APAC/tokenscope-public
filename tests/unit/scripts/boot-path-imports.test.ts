// @vitest-environment node
/*
 * GUARD — boot-path code may not import from `server/` or `shared/`.
 *
 * The runtime image copies `node_modules`, `.output`, `drizzle/`, `scripts/` and
 * `entrypoint.sh` (Dockerfile stage 4). It does NOT copy `server/` or `shared/`:
 * those exist only as compiled output inside `.output`, which a boot script run
 * under `tsx` against raw files never touches.
 *
 * So a `drizzle/` or `scripts/` file that imports from `server/` RESOLVES IN DEV
 * AND IS MISSING IN PRODUCTION. Nothing else catches it:
 *
 *   - `npm run typecheck` type-checks the source tree, where the file is present;
 *   - `npm run build` compiles the Nuxt app and never touches boot scripts;
 *   - the integration tests run from the repo, not the image;
 *   - and `entrypoint.sh` runs these steps NON-FATALLY, so the symptom in
 *     production is a line in a deploy log and a step that silently never ran.
 *
 * This is the same class as the `#shared` import that only failed in the ACR
 * image build (CLAUDE.md: "CI misses the prod build"), one layer earlier.
 *
 * It was live: `drizzle/provision-app-role.ts` imported the app-role name and the
 * RLS bootstrap table list from `server/db/rls-bootstrap.ts`. Two parallel tracks
 * each did the reasonable thing — one put the constant beside its documentation,
 * the other noticed the Dockerfile — and only the integration caught it. Hence a
 * machine rather than a convention.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'

const ROOT = resolve(__dirname, '../../..')

/**
 * The boot set is DERIVED from entrypoint.sh, not listed here — a hand-kept list
 * would silently stop covering a step the day someone adds one. Only these files
 * (and what they pull in) run from the image; `drizzle/seed.ts`,
 * `scripts/emit-data.ts` and friends are dev-only and may import server/ freely.
 */
function bootEntrypoints(): string[] {
  const sh = readFileSync(resolve(ROOT, 'entrypoint.sh'), 'utf8')
  const found = [...sh.matchAll(/tsx\s+([\w./-]+\.ts)/g)].map((m) => m[1]!)
  return [...new Set(found)]
}

/** Follow relative imports, staying inside the repo, to get the real boot closure. */
function bootClosure(entries: string[]): string[] {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length) {
    const rel = queue.shift()!
    if (seen.has(rel)) continue
    seen.add(rel)
    let src: string
    try {
      src = readFileSync(resolve(ROOT, rel), 'utf8')
    } catch {
      continue
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1]!
      const base = resolve(resolve(ROOT, rel), '..', spec)
      for (const cand of [`${base}.ts`, `${base}/index.ts`, base]) {
        try {
          if (statSync(cand).isFile()) {
            queue.push(relative(ROOT, cand))
            break
          }
        } catch {
          /* not this candidate */
        }
      }
    }
  }
  return [...seen]
}

/** Directories the runtime image does NOT copy as source. */
const ABSENT_AT_RUNTIME = /(^|['"(\s])(\.\.\/)+(server|shared)\//

describe('boot-path code does not import from directories absent at runtime', () => {
  const entries = bootEntrypoints()
  const closure = bootClosure(entries)

  it('derives the boot set from entrypoint.sh (guards against matching nothing)', () => {
    expect(entries).toContain('drizzle/migrate.ts')
    expect(entries).toContain('drizzle/provision-app-role.ts')
    expect(entries).toContain('drizzle/assert-runtime-rls-safe.ts')
    expect(entries).toContain('scripts/preflight-run.ts')
    expect(closure.length).toBeGreaterThanOrEqual(entries.length)
  })

  it('confirms the Dockerfile still omits server/ and shared/ — the premise of this guard', () => {
    const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8')
    const runtimeCopies = dockerfile
      .split('\n')
      .filter((l) => /^COPY --from=build/.test(l))
      .join('\n')
    expect(runtimeCopies).toMatch(/\/app\/drizzle/)
    expect(runtimeCopies).toMatch(/\/app\/scripts/)
    expect(runtimeCopies).not.toMatch(/\/app\/server/)
    expect(runtimeCopies).not.toMatch(/\/app\/shared/)
  })

  it('no file reachable from entrypoint.sh imports server/ or shared/', () => {
    const offenders: string[] = []
    for (const rel of closure) {
      const src = readFileSync(resolve(ROOT, rel), 'utf8')
      for (const line of src.split('\n')) {
        if (!/^\s*(import|export)\s|require\(/.test(line)) continue
        if (ABSENT_AT_RUNTIME.test(line)) offenders.push(`${rel}  ${line.trim().slice(0, 110)}`)
      }
    }
    expect(
      offenders,
      'A file reachable from entrypoint.sh imports server/ or shared/, which the runtime image does ' +
        'not copy. It resolves in dev and is MISSING in production, and entrypoint.sh runs these ' +
        'steps non-fatally — so the failure is a log line and a step that silently never ran. Move ' +
        'the shared value into scripts/ (see scripts/rls-roles.ts) and re-export it from server/.',
    ).toEqual([])
  })
})
