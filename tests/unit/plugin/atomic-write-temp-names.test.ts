// @vitest-environment node
/*
 * CLASS GATE: every atomic-write temp name under plugin/ and copilot-plugin/
 * carries cryptographic randomness (randomBytes in JS, mktemp in sh), never a
 * pid alone. `~/.claude` and `~/.tokenscope` are host bind-mounts shared by
 * every container, each with its own PID namespace, so two writers can hold the
 * same pid, open the same temp inode, and one mutates it after the other has
 * renamed it into place. The files at risk hold the durable refresh token and
 * the DCE revert key.
 *
 * Matched by VALUE (any expression building a `.tmp.` path, whatever it is
 * named), across newlines, in both languages; a matcher that keys on a
 * variable name or one spelling passes while the collision is reintroduced.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DIRS = ['plugin/scripts', 'plugin/hooks', 'copilot-plugin/scripts', 'copilot-plugin/hooks']
// Both languages: the helper's own cache write is shell.
const EXTS = ['.mjs', '.js', '.ts', '.sh']

function walk(dir: string): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs).flatMap((name) => {
    const full = join(abs, name)
    if (statSync(full).isDirectory()) return walk(join(dir, name))
    return EXTS.some((e) => name.endsWith(e)) ? [join(dir, name)] : []
  })
}

/**
 * Every temp-name assignment, as a whole expression — matched across newlines so
 * a template broken over several lines cannot slip through.
 */
function tempAssignments(src: string): string[] {
  const js = [...src.matchAll(/(?:const|let|var)\s+\w+\s*=\s*`[^`]*\.tmp\.[^`]*`/gs)].map((m) => m[0])
  // Shell: any assignment line whose value mentions `.tmp.`, whole line, so
  // nested quotes (`"$(mktemp "${X}.tmp.XXXXXX")"`) cannot end the match early.
  const sh = [...src.matchAll(/^\s*\w+=.*\.tmp\..*$/gm)].map((m) => m[0])
  return [...new Set([...js, ...sh])]
}

describe('atomic-write temp names are unpredictable', () => {
  const files = DIRS.flatMap(walk)

  it('scans every configured directory, so a lost path cannot pass vacuously', () => {
    for (const d of DIRS) {
      expect(walk(d).length, `${d} contributed no files to the scan`).toBeGreaterThan(0)
    }
    expect(files.length).toBeGreaterThan(10)
  })

  it('finds the known temp-writing sites, so the matcher itself is not broken', () => {
    // If the regex stops matching, every assertion below passes trivially.
    const total = files.reduce((n, rel) => n + tempAssignments(readFileSync(join(ROOT, rel), 'utf8')).length, 0)
    // The floor tracks the real count; a writer moving onto casWriteFile lowers it.
    expect(total, 'the temp-name matcher found nothing; it has drifted').toBeGreaterThanOrEqual(6)
    // The shell half specifically: the helper's own cache write.
    const helper = readFileSync(join(ROOT, 'plugin/scripts/otel-headers-helper.sh'), 'utf8')
    expect(tempAssignments(helper).some((e) => e.includes('ACCESS_CACHE')), 'the shell matcher no longer sees the helper').toBe(true)
  })

  it('requires cryptographic randomness in every temp name, not just a pid', () => {
    const offenders: string[] = []
    for (const rel of files) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      for (const expr of tempAssignments(src)) {
        // A pid, a counter, a timestamp or a fixed suffix are all predictable
        // enough for two containers to collide. Only randomBytes qualifies.
        // `mktemp` is the shell equivalent of a randomBytes suffix: it creates the
        // file exclusively rather than deriving a guessable name.
        if (!/randomBytes\s*\(/.test(expr) && !/\bmktemp\b/.test(expr)) {
          offenders.push(`${rel}: ${expr.replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }
    }
    expect(offenders, 'add a randomBytes suffix, as writeDeviceStore does').toEqual([])
  })
})
