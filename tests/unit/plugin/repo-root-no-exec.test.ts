/*
 * F34 — the repo-root resolver must not execute anything.
 *
 * THE DEFECT, as measured (probe 2026-08-21, Claude Code 2.1.238). A hostile
 * cloned repository sets `PATH` in its `.claude/settings.json` `env` block,
 * which Claude Code merges into the environment the SessionStart hook inherits.
 * `resolveRepoRoot` then ran `execFileSync('git', ['rev-parse', …])`, resolving
 * `git` through that PATH — and it is reached from `neutraliseRepoHome`, which
 * runs BEFORE `neutraliseRepoExecEnv`, the repair that exists to strip exactly
 * this. The planted binary executed as the developer, twice, and the session
 * completed normally: the hijack is silent. The developer only has to open the
 * repo.
 *
 * The ordering could not be flipped — the exec repair reads the global settings
 * file, so the HOME repair has to precede it, and both ask for the repo root.
 * The fix is that the resolver spawns nothing at all.
 *
 * THIS TEST IS THE PROBE, shrunk. It plants a `git` on PATH that writes a marker
 * and asserts the marker is never written. Restore the `execFileSync` fallback
 * in `resolveRepoRoot` and it goes red — the marker appears — which is the only
 * evidence that matters here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { resolveRepoRoot } from '../../../plugin/scripts/tag-repo.mjs'

let sandbox: string
let repo: string
let binDir: string
let marker: string
const REAL_PATH = process.env.PATH

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'reporoot-')))
  repo = join(sandbox, 'repo')
  mkdirSync(join(repo, 'nested', 'deep'), { recursive: true })
  mkdirSync(join(repo, '.git'), { recursive: true })

  // A `git` that announces it ran. It must never be reached.
  binDir = join(sandbox, 'evil-bin')
  mkdirSync(binDir, { recursive: true })
  marker = join(sandbox, 'PWNED')
  const shim = join(binDir, 'git')
  writeFileSync(shim, `#!/bin/sh\necho hijacked > "${marker}"\necho "${repo}"\n`)
  chmodSync(shim, 0o755)
})

afterEach(() => {
  process.env.PATH = REAL_PATH
  rmSync(sandbox, { recursive: true, force: true })
})

describe('resolveRepoRoot executes nothing (F34)', () => {
  it('does not run a repo-planted `git`, even when PATH holds nothing else', () => {
    process.env.PATH = binDir // the hostile repo's whole contribution

    const root = resolveRepoRoot(join(repo, 'nested', 'deep'))

    expect(existsSync(marker), 'a repo-supplied `git` on PATH was EXECUTED').toBe(false)
    expect(root).toBe(repo)
  })

  it('still answers correctly with PATH emptied entirely', () => {
    process.env.PATH = ''
    expect(resolveRepoRoot(join(repo, 'nested'))).toBe(repo)
  })

  it('resolves a linked worktree, where `.git` is a FILE not a directory', () => {
    const wt = join(sandbox, 'worktree')
    mkdirSync(join(wt, 'sub'), { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`)
    expect(resolveRepoRoot(join(wt, 'sub'))).toBe(wt)
  })

  it('ignores a repo-set GIT_DIR — honouring it was the behaviour we dropped', () => {
    const decoy = join(sandbox, 'decoy')
    mkdirSync(join(decoy, '.git'), { recursive: true })
    process.env.GIT_DIR = join(decoy, '.git')
    try {
      expect(resolveRepoRoot(join(repo, 'nested'))).toBe(repo)
    } finally {
      delete process.env.GIT_DIR
    }
  })

  it('returns null outside any work tree rather than guessing', () => {
    const bare = join(sandbox, 'not-a-repo')
    mkdirSync(bare, { recursive: true })
    // STRICTLY null. The walk returns null the moment it reaches the filesystem
    // root without finding a `.git` (tag-repo.mjs), so accepting '/' as well was
    // looser than this test's own name and would mask a regression that starts
    // guessing a root directory.
    expect(resolveRepoRoot(bare)).toBeNull()
  })

  it('answers a PHYSICAL path when handed one, which is what the caller realpaths for', () => {
    const link = join(sandbox, 'link-to-repo')
    symlinkSync(repo, link)
    // session-start's computeRepoSettingsDirs realpaths before calling; do the same.
    expect(resolveRepoRoot(realpathSync(join(link, 'nested')))).toBe(repo)
  })
})
