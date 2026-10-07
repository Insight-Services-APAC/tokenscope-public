// @vitest-environment node
/*
 * is-main.mjs — a script reached through a symlinked directory still runs.
 *
 * Node realpaths the main module before loading it, so `import.meta.url` is the
 * real file while `process.argv[1]` is the path as invoked. The old string
 * compare made every hook and command exit 0 having done nothing whenever the
 * install path crossed a symlink (first seen as the macOS CI job, where
 * tmpdir() is /var -> /private/var). Scripts are run here through an explicit
 * link, so the guard is exercised on every OS — not only on the one whose temp
 * dir happens to be a symlink — and a source scan keeps the string compare from
 * coming back in any one script.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, symlinkSync, writeFileSync, realpathSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { isMainModule } from '../../../plugin/scripts/is-main.mjs'

const SCRIPTS = join(process.cwd(), 'plugin', 'scripts')

let root: string
let realDir: string
let linkDir: string

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ts-is-main-')))
  realDir = join(root, 'real')
  cpSync(SCRIPTS, join(realDir, 'scripts'), { recursive: true })
  writeFileSync(
    join(realDir, 'scripts', 'probe.mjs'),
    "import { isMainModule } from './is-main.mjs'\nif (isMainModule(import.meta.url)) process.stdout.write('ran')\n",
  )
  linkDir = join(root, 'link')
  // A junction needs no privilege on Windows; elsewhere the type is ignored.
  symlinkSync(realDir, linkDir, 'junction')
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(script: string, args: string[] = []): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 })
}

describe('isMainModule', () => {
  it('runs a script invoked by its real path', () => {
    expect(run(join(realDir, 'scripts', 'probe.mjs'))).toBe('ran')
  })

  it('runs a script invoked THROUGH a symlinked directory', () => {
    expect(run(join(linkDir, 'scripts', 'probe.mjs'))).toBe('ran')
  })

  it('is false for a module that is not the entry point', () => {
    const other = pathToFileURL(join(realDir, 'scripts', 'is-main.mjs')).href
    expect(isMainModule(other, join(realDir, 'scripts', 'probe.mjs'))).toBe(false)
    expect(isMainModule(other, undefined)).toBe(false)
  })

  it('a real script (copilot-redeem.mjs) reached through the link runs main()', () => {
    // With no arguments main() refuses before touching the network or any
    // store. Before the fix this exited 0 with no output at all.
    let out: string
    let status = 0
    try {
      out = run(join(linkDir, 'scripts', 'copilot-redeem.mjs'))
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number }
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
      status = err.status ?? -1
    }
    expect(out).toContain('--handoff-code is required')
    expect(status).not.toBe(0)
  })

  it('no shipped script compares argv[1] as a string any more', () => {
    const offenders: string[] = []
    for (const dir of ['plugin', 'copilot-plugin']) {
      for (const rel of readdirSync(join(process.cwd(), dir), { recursive: true }) as string[]) {
        if (!rel.endsWith('.mjs') || rel.includes('node_modules')) continue
        const src = readFileSync(join(process.cwd(), dir, rel), 'utf8')
        if (/(===|!==)\s*(resolve\()?process\.argv\[1\]|process\.argv\[1\]\)?\s*(===|!==)/.test(src)) {
          offenders.push(join(dir, rel))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
