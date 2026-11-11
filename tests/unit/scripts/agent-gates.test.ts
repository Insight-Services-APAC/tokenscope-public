/*
 * The two process gates added 2026-10-08: lint before commit
 * (scripts/check-commit-lint.mjs) and an external review before pushing code
 * (scripts/check-external-review.mjs). Their decisions are pure; git is injected.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitShape, eslintEntry, isCommit } from '../../../scripts/check-commit-lint.mjs'
import { CODE_PATHS, codeFingerprint, decide, isPush, newCodeFiles, pushSkipsReview, reviewedFingerprints } from '../../../scripts/check-external-review.mjs'

describe('lint gate: which commands are commits', () => {
  it('matches commits, including chained and env-prefixed ones', () => {
    for (const c of ['git commit -m x', 'git add -A && git commit -q -F - <<EOF\nm\nEOF', 'GIT_X=1 git commit --amend']) {
      expect(isCommit(c), c).toBe(true)
    }
  })
  it('recognises the forms the backlink gate does (newlines, wrappers, global options)', () => {
    for (const c of ['echo hi\ngit commit -m x', 'git -C repo commit -m x']) {
      expect(isCommit(c), c).toBe(true)
    }
    // Not parsed as commits, so the lint hook refuses them as unmodelled (see the hook tests below).
    for (const c of ['/usr/bin/git -c a=b commit -m x', 'command git commit']) {
      expect(isCommit(c), c).toBe(false)
    }
    for (const c of ['echo hi\ngit push', 'git -C repo push', 'command git push -q', '/usr/bin/git --no-pager push']) {
      expect(isPush(c), c).toBe(true)
    }
    expect(isPush('git status && echo push')).toBe(false)
  })

  it('lints unstaged and untracked files only when the command stages them', () => {
    expect(commitShape('git commit -m x')).toEqual({ commit: true, stages: false })
    expect(commitShape('git add -A && git commit -m x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git commit -am x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git commit --all -m x')).toEqual({ commit: true, stages: true })
    expect(commitShape('git -C r add f.ts\ngit commit -m x')).toEqual({ commit: true, stages: true })
  })

  it('ignores everything else', () => {
    for (const c of ['git status', 'git log --grep commit', 'echo git commit', 'npm run lint']) {
      expect(isCommit(c), c).toBe(false)
    }
  })
})

describe('external-review gate', () => {
  const trees = (overrides: Record<string, string>) => (args: string[]) => {
    const [ref, path] = args[1]!.split(':')
    const t = overrides[`${ref}:${path}`]
    if (t === undefined) throw new Error('missing')
    return t
  }

  it('the fingerprint covers exactly the code trees: a docs change leaves it equal', () => {
    const base = Object.fromEntries(CODE_PATHS.map((p) => [`A:${p}`, `tree-${p}`]))
    const sameCode = Object.fromEntries(CODE_PATHS.map((p) => [`B:${p}`, `tree-${p}`]))
    const changed = { ...Object.fromEntries(CODE_PATHS.map((p) => [`C:${p}`, `tree-${p}`])), 'C:plugin': 'tree-plugin-2' }
    const git = trees({ ...base, ...sameCode, ...changed })
    expect(codeFingerprint('A', git)).toBe(codeFingerprint('B', git))
    expect(codeFingerprint('C', git)).not.toBe(codeFingerprint('A', git))
  })

  it('allows non-push commands, unchanged code, reviewed code and the explicit skip', () => {
    const reviewed = new Set(['fp-reviewed'])
    expect(decide({ command: 'git status', head: 'x', base: 'y', reviewed }).allow).toBe(true)
    expect(decide({ command: 'git push', head: 'same', base: 'same', reviewed }).allow).toBe(true)
    expect(decide({ command: 'git push -q', head: 'fp-reviewed', base: 'old', reviewed }).allow).toBe(true)
    expect(decide({ command: 'SKIP_EXTERNAL_REVIEW=1 git push', head: 'new', base: 'old', reviewed }).allow).toBe(true)
  })

  it('refuses a push of code no external review covers', () => {
    expect(decide({ command: 'cd x && git push', head: 'new', base: 'old', reviewed: new Set() }).allow).toBe(false)
    // Forms whose code the gate would read from the wrong place are refused even when HEAD is reviewed.
    for (const c of ['cd ../other && git push', 'git -C ../other push', 'git push origin feature:main', 'git push --all']) {
      const d = decide({ command: c, head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']), branch: 'feat/x' })
      expect(d.allow, c).toBe(false)
      expect(d.unmodelled, c).toBeTruthy()
    }
    // A wrapped push is still a push, and is refused.
    for (const c of ['sh -c "git push origin main"', 'env --chdir=../o git push', 'FOO=1 sh -c "git push"', 'git --config-env push.default=PD push']) {
      expect(isPush(c), c).toBe(true)
      expect(decide({ command: c, head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']) }).allow, c).toBe(false)
    }
    expect(decide({ command: 'git push -u origin feat/x', head: 'fp-reviewed', base: 'old', reviewed: new Set(['fp-reviewed']), branch: 'feat/x' }).allow).toBe(true)
    expect(decide({ command: 'git push --force-with-lease', head: 'new', base: 'old', reviewed: new Set(['other']) }).allow).toBe(false)
  })

  it('the emergency skip counts only as an env assignment on the push itself', () => {
    expect(pushSkipsReview('SKIP_EXTERNAL_REVIEW=1 git push')).toBe(true)
    expect(pushSkipsReview('A=b SKIP_EXTERNAL_REVIEW=1 git push -q')).toBe(true)
    for (const c of [
      'echo SKIP_EXTERNAL_REVIEW=1 && git push',
      'git push --push-option=SKIP_EXTERNAL_REVIEW=1',
      'SKIP_EXTERNAL_REVIEW=1 git status\ngit push',
      'SKIP_EXTERNAL_REVIEW=0 git push',
    ]) {
      expect(pushSkipsReview(c), c).toBe(false)
      expect(decide({ command: c, head: 'new', base: 'old', reviewed: new Set() }).allow, c).toBe(false)
    }
  })

  it('root manifests and workflows count as code', () => {
    for (const p of ['package.json', 'package-lock.json', 'nuxt.config.ts', 'Dockerfile', '.github/workflows', '.claude/settings.json']) {
      expect(CODE_PATHS).toContain(p)
    }
  })

  /*
   * Updating a branch from main brings main's merged code in. Compared with the
   * branch's upstream alone it read as new, and the gate asked for a review of
   * other PRs' code. Only a file that differs from BOTH the upstream and
   * origin/main is new.
   * REVERT: drop the `newCode` check in decide(), or return vsBase alone.
   */
  it('only a file main changed and HEAD carries as main has it is not new', () => {
    const z = (...f: string[]) => f.map((x) => `${x}\0`).join('')
    const diffs: Record<string, string> = {
      // HEAD vs the upstream: four code files differ.
      'origin/feat..HEAD': z('app/a.vue', 'server/b.ts', 'scripts/c.mjs', 'app/revert.vue'),
      // What main changed since the fork point.
      'fork..origin/main': z('app/a.vue', 'server/b.ts'),
      // HEAD vs main: b.ts differs (a hand-resolved conflict), c.mjs is the branch's own.
      'origin/main..HEAD': z('server/b.ts', 'scripts/c.mjs', 'app/own.vue'),
    }
    const git = (args: string[]) => {
      if (args[0] === 'merge-base') return 'fork'
      expect(args.slice(0, 5)).toEqual(['diff', '--name-only', '-z', '--no-renames', '--no-relative'])
      expect(args.slice(args.indexOf('--') + 1).every((p) => p.startsWith(':(top)'))).toBe(true)
      return diffs[`${args[5]}..${args[6]}`] ?? ''
    }
    // a.vue came from main. revert.vue equals main but main never changed it: the branch
    // reverted its own change, which is its own work and still needs the review.
    expect(newCodeFiles('origin/feat', git)).toEqual(['server/b.ts', 'scripts/c.mjs', 'app/revert.vue'])
    // Without an upstream the base IS origin/main: everything that differs is new.
    expect(newCodeFiles('origin/main', git)).toEqual(['server/b.ts', 'scripts/c.mjs', 'app/own.vue'])
    // A git error, or no merge base, is "cannot tell", never "nothing new".
    expect(newCodeFiles('origin/feat', () => { throw new Error('no origin/main') })).toBeNull()
    expect(newCodeFiles('origin/feat', (a: string[]) => (a[0] === 'merge-base' ? '' : z('app/a.vue')))).toBeNull()
  })

  it('decide: nothing new is allowed; something new still needs the review; unknown falls back', () => {
    const base = { command: 'git push', head: 'new', base: 'old', reviewed: new Set<string>() }
    expect(decide({ ...base, newCode: [] })).toEqual({ allow: true, reason: 'only code already on origin/main' })
    expect(decide({ ...base, newCode: ['server/b.ts'] }).allow).toBe(false)
    expect(decide({ ...base, newCode: null }).allow).toBe(false)
    expect(decide({ ...base, newCode: ['server/b.ts'], reviewed: new Set(['new']) }).allow).toBe(true)
    // The exemption never lifts a refusal of a form the gate cannot check.
    expect(decide({ ...base, command: 'cd ../other && git push', newCode: [] }).allow).toBe(false)
  })

  it('in a real repository: merging main needs no review, an edit on top of it does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-merge-'))
    const g = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
      return r.stdout.trim()
    }
    const write = (p: string, s: string) => {
      spawnSync('mkdir', ['-p', join(dir, p, '..')])
      writeFileSync(join(dir, p), s)
    }
    try {
      g('init', '-q', '-b', 'main')
      g('config', 'user.email', 't@x.test')
      g('config', 'user.name', 't')
      write('server/a.ts', 'a1\n')
      write('app/b.vue', 'b1\n')
      g('add', '.')
      g('commit', '-q', '-m', 'base')
      g('checkout', '-q', '-b', 'feat')
      write('app/b.vue', 'b-feat\n')
      g('commit', '-q', '-am', 'feat change')
      g('update-ref', 'refs/remotes/origin/feat', 'HEAD')
      g('checkout', '-q', 'main')
      write('server/a.ts', 'a-main\n')
      g('commit', '-q', '-am', 'another PR merged')
      g('update-ref', 'refs/remotes/origin/main', 'HEAD')
      g('checkout', '-q', 'feat')
      g('merge', '-q', '--no-edit', 'origin/main')
      const inRepo = (args: string[]) => g(...args)
      // server/a.ts came from main; app/b.vue equals the upstream: nothing is new.
      expect(newCodeFiles('origin/feat', inRepo)).toEqual([])
      // The script itself (not only the helper) uses it: --status runs the same decision as the hook.
      g('config', 'remote.origin.url', dir)
      g('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      g('config', 'branch.feat.remote', 'origin')
      g('config', 'branch.feat.merge', 'refs/heads/feat')
      const status = () =>
        spawnSync('node', [join(__dirname, '../../../scripts/check-external-review.mjs'), '--status'], { cwd: dir, encoding: 'utf8' }).stdout
      expect(status()).toContain('push allowed (only code already on origin/main, against origin/feat)')
      // --status reports what the hook decides: a push config that would push other refs is refused.
      g('config', 'push.default', 'matching')
      expect(status()).toContain('push refused whatever the review')
      g('config', '--unset', 'push.default')
      // And the hook itself: silent (allowed) now, a deny once the branch adds code of its own.
      const hook = () =>
        spawnSync('node', [join(__dirname, '../../../scripts/check-external-review.mjs'), '--hook'], {
          cwd: dir,
          encoding: 'utf8',
          input: JSON.stringify({ tool_input: { command: 'git push' } }),
        }).stdout
      expect(hook()).toBe('')
      // Run from a subfolder, the root-anchored paths still see the whole tree.
      const fromApp = (args: string[]) => {
        const r = spawnSync('git', args, { cwd: join(dir, 'app'), encoding: 'utf8' })
        if (r.status !== 0) throw new Error(r.stderr)
        return r.stdout.trim()
      }
      write('server/a.ts', 'a-main plus an edit\n')
      g('commit', '-q', '-am', 'edit after the merge')
      expect(newCodeFiles('origin/feat', inRepo)).toEqual(['server/a.ts'])
      expect(newCodeFiles('origin/feat', fromApp)).toEqual(['server/a.ts'])
      // diff.relative=true would still clip the diff to app/ without --no-relative.
      g('config', 'diff.relative', 'true')
      expect(newCodeFiles('origin/feat', fromApp)).toEqual(['server/a.ts'])
      g('config', '--unset', 'diff.relative')
      expect(hook()).toContain('"permissionDecision":"deny"')
      expect(hook()).toContain('new here, not on origin/main: server/a.ts')
      // Reverting the branch's own change back to main's copy is still the branch's work.
      g('update-ref', 'refs/remotes/origin/feat', 'HEAD')
      write('app/b.vue', 'b1\n')
      g('commit', '-q', '-am', 'revert the feat change')
      expect(newCodeFiles('origin/feat', inRepo)).toEqual(['app/b.vue'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the ledger’s first column', () => {
    expect(reviewedFingerprints('fp1\tsha\tts\t/path\nfp2\tsha\n\n')).toEqual(new Set(['fp1', 'fp2']))
  })
})

describe('commit-lint hook: a wrapped or relocated commit is refused', () => {
  const run = (command: string) =>
    spawnSync(process.execPath, ['scripts/check-commit-lint.mjs'], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).stdout
  it('launches ESLint through Node, not the .bin shim (eslint.cmd will not spawn on Windows)', () => {
    expect(eslintEntry()).toMatch(/eslint[\\/]bin[\\/]eslint\.js$/)
    expect(readFileSync('scripts/check-commit-lint.mjs', 'utf8')).toContain('spawnSync(process.execPath, [eslint')
  })

  it('a lint error refuses the commit (ESLint really runs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lint-gate-'))
    try {
      // A throwaway repo with this checkout's node_modules and a one-rule config.
      spawnSync('git', ['init', '-q', dir])
      symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'junction')
      writeFileSync(join(dir, 'eslint.config.mjs'), "export default [{ rules: { 'no-unused-vars': 'error' } }]\n")
      writeFileSync(join(dir, 'bad.mjs'), 'const unused = 1\n')
      spawnSync('git', ['-C', dir, 'add', 'bad.mjs'])
      const out = spawnSync(process.execPath, [join(process.cwd(), 'scripts/check-commit-lint.mjs')], {
        cwd: dir,
        input: JSON.stringify({ tool_input: { command: 'git commit -m x' } }),
        encoding: 'utf8',
        timeout: 60_000,
      }).stdout
      expect(out).toContain('"permissionDecision":"deny"')
      expect(out).toContain('eslint reports errors')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 70_000)

  it('denies sh -c "git commit", and stays silent for a non-commit', () => {
    expect(run('sh -c "git commit -m x"')).toContain('"permissionDecision":"deny"')
    expect(run('sh -c "ls"')).toBe('')
    expect(run('FOO=1 sh -c "git commit -m x"')).toContain('"permissionDecision":"deny"')
    // A commit in another checkout: the gate would lint this one's files.
    for (const c of ['git -C ../other commit -m x', 'git -C../other commit -m x', 'cd ../other && git commit -m x', 'GIT_DIR=../o/.git git commit -m x', '/usr/bin/git -c a=b commit -m x', 'command git commit']) {
      expect(run(c), c).toContain('"permissionDecision":"deny"')
    }
  })
})
