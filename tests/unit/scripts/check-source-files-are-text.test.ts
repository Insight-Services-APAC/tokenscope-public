// @vitest-environment node
/*
 * scripts/check-source-files-are-text.mjs — the guard that stops a literal NUL
 * byte reaching the tree. A NUL makes a file `data` rather than text, so
 * ripgrep skips it as binary and every grep-based audit over it silently
 * under-reports (server/reporting/across-regions.ts shipped this way; enabling
 * the guard found the same byte in two more files nobody had flagged).
 *
 * Detection itself is one byte comparison. What is worth pinning is COVERAGE,
 * because that is what went wrong twice while writing this guard: the first
 * version walked a hand-maintained directory allowlist, which silently missed
 * plugin/, copilot-plugin/, infra/, every root-level file and every .sh /
 * .css / .bicep / .py / extensionless file. Enumerating tracked files inverts
 * the default so a new file type is covered until declared binary.
 *
 * The subprocess tests exist because the earlier suite drove only the exported
 * helpers: flipping process.exit(1) to exit(0), or deleting main(), left every
 * assertion green while CI silently stopped failing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  candidateFiles,
  findOffenders,
  isBinaryAsset,
  BINARY_EXTS,
} from '../../../scripts/check-source-files-are-text.mjs'

// The escape, never the raw byte — this file is subject to its own guard.
const NUL = '\u0000'
const SCRIPT = resolve(__dirname, '../../../scripts/check-source-files-are-text.mjs')

let base: string

/** A throwaway git repo, because the guard enumerates via `git ls-files`. */
function initRepo(dir: string) {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
}
function write(dir: string, rel: string, body: string | Buffer) {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body)
}
function trackAll(dir: string) {
  execFileSync('git', ['add', '-A'], { cwd: dir })
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'nul-guard-'))
  initRepo(base)

  write(base, 'server/clean.ts', 'export const a = 1\n')
  write(base, 'server/dirty.ts', `const k = \`x${NUL}y\`\n`)
  // Every path the ALLOWLIST version silently missed.
  write(base, 'plugin/scripts/enroll.mjs', `bad${NUL}\n`)
  write(base, 'copilot-plugin/scripts/status.mjs', `bad${NUL}\n`)
  write(base, 'infra/main.bicep', `param x string${NUL}\n`)
  write(base, 'scripts/dev.sh', `#!/bin/sh\necho ${NUL}\n`)
  write(base, 'app/assets/css/main.css', `a{content:"${NUL}"}\n`)
  write(base, 'Dockerfile', `FROM node${NUL}\n`)
  write(base, 'nuxt.config.ts', `export default {}${NUL}\n`)
  write(base, 'plugin/.claude-plugin/plugin.json', `{"a":"${NUL}"}\n`)
  // A real binary asset must NOT fail the build.
  write(base, 'docs/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))
  write(base, 'docs/design/.thumbnail', Buffer.from([0x00, 0x01, 0x00]))
  // Untracked files are not the guard's business.
  write(base, 'scratch/untracked.ts', `nope${NUL}\n`)

  trackAll(base)
  // Track everything EXCEPT the scratch dir, to pin the tracked-only contract.
  execFileSync('git', ['rm', '--cached', '-q', '-r', 'scratch'], { cwd: base })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

const offenders = () =>
  findOffenders(candidateFiles(base), base)
    .map((o) => o.file.replace(/\\/g, '/'))
    .sort()

describe('coverage — the allowlist blind spots', () => {
  it.each([
    ['plugin/scripts/enroll.mjs', 'shipped Claude plugin code'],
    ['copilot-plugin/scripts/status.mjs', 'shipped Copilot plugin code'],
    ['infra/main.bicep', 'infrastructure source'],
    ['scripts/dev.sh', 'a shell script'],
    ['app/assets/css/main.css', 'a stylesheet'],
    ['Dockerfile', 'an extensionless root file'],
    ['nuxt.config.ts', 'a root-level config'],
    ['plugin/.claude-plugin/plugin.json', 'a file under a nested dot-directory'],
  ])('covers %s (%s)', (path) => {
    expect(offenders()).toContain(path)
  })

  it('covers the ordinary case it always covered', () => {
    expect(offenders()).toContain('server/dirty.ts')
  })

  it('leaves clean files alone', () => {
    expect(offenders()).not.toContain('server/clean.ts')
  })
})

describe('binary assets and tracking', () => {
  it('does not fail the build for a real PNG or a dotfile thumbnail', () => {
    const found = offenders()
    expect(found).not.toContain('docs/logo.png')
    expect(found).not.toContain('docs/design/.thumbnail')
  })

  it('classifies a dotfile whose whole name is the extension', () => {
    // `.thumbnail` looked extensionless — i.e. text — and failed the build.
    expect(isBinaryAsset('a/.thumbnail')).toBe(true)
    expect(isBinaryAsset('a/x.PNG')).toBe(true) // case-insensitive
    expect(isBinaryAsset('a/Dockerfile')).toBe(false)
    expect(isBinaryAsset('a/.gitignore')).toBe(false)
    expect(isBinaryAsset('a/.npmrc')).toBe(false)
  })

  it('does not classify an EXTENSIONLESS file by its whole name', () => {
    /*
     * No dot means no extension. Falling back to the whole name would skip a
     * file literally called `bin`, `node` or `class` as a binary asset — a
     * silent hole of exactly the kind this guard exists to close.
     */
    expect(isBinaryAsset('a/png')).toBe(false)
    expect(isBinaryAsset('a/bin')).toBe(false)
    expect(isBinaryAsset('a/node')).toBe(false)
    expect(isBinaryAsset('a/class')).toBe(false)
    expect(isBinaryAsset('a/trailing.')).toBe(false)
  })

  it('keeps the binary carve-out small — every entry is a hole in the check', () => {
    for (const e of ['ts', 'sql', 'md', 'sh', 'bicep', 'json', 'yml', 'css', 'py', 'vue']) {
      expect(BINARY_EXTS.has(e)).toBe(false)
    }
  })

  it('ignores untracked files', () => {
    expect(offenders()).not.toContain('scratch/untracked.ts')
  })
})

describe('detection', () => {
  it('counts every NUL in a file, not just the first', () => {
    const rel = 'server/multi.ts'
    write(base, rel, `a${NUL}b${NUL}c${NUL}\n`)
    const hit = findOffenders([rel], base)[0]
    expect(hit?.count).toBe(3)
    rmSync(join(base, rel))
  })

  it('fails closed on an unreadable tracked file rather than reporting success', () => {
    const rel = 'server/locked.ts'
    write(base, rel, 'export const x = 1\n')
    const abs = join(base, rel)
    chmodSync(abs, 0o000)
    try {
      // Running as root defeats the permission bit; skip rather than assert a
      // property the environment cannot produce.
      let readable = true
      try {
        readFileSync(abs)
      } catch {
        readable = false
      }
      if (readable) return
      expect(() => findOffenders([rel], base)).toThrow(/could not read tracked file/)
    } finally {
      chmodSync(abs, 0o644)
      rmSync(abs)
    }
  })

  it('skips a tracked path deleted from the working tree', () => {
    expect(() => findOffenders(['server/does-not-exist.ts'], base)).not.toThrow()
    expect(findOffenders(['server/does-not-exist.ts'], base)).toEqual([])
  })
})

/*
 * The helpers above can all be correct while the executable does nothing. These
 * run the script the way CI does.
 */
describe('the executable itself', () => {
  it('exits non-zero and annotates when a tracked file carries a NUL', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: base, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('::error file=server/dirty.ts::')
    expect(r.stderr).toMatch(/tracked file\(s\) contain NUL bytes/)
  })

  it('exits zero on a clean tree', () => {
    const clean = mkdtempSync(join(tmpdir(), 'nul-clean-'))
    try {
      initRepo(clean)
      write(clean, 'server/ok.ts', 'export const a = 1\n')
      write(clean, 'docs/logo.png', Buffer.from([0x89, 0x50, 0x00]))
      trackAll(clean)
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: clean, encoding: 'utf8' })
      expect(r.status).toBe(0)
      // Claims only what it verified — not "are plain text".
      expect(r.stdout).toContain('contain no NUL bytes')
    } finally {
      rmSync(clean, { recursive: true, force: true })
    }
  })

  it('passes on this repository', () => {
    const repo = resolve(__dirname, '../../..')
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: repo, encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})
