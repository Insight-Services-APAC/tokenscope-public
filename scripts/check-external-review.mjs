#!/usr/bin/env node
/*
 * External review before push (CLAUDE.md "Review shapes": internal agents
 * prove, external agents judge; one build, one external review, one fix pass).
 *
 * PreToolUse gate (Bash matcher, .claude/settings.json): `git push` is refused
 * when it would publish CODE that no external review has been recorded for.
 * On 2026-10-08 two follow-on builds were pushed on internal tests alone, and
 * the PR reviewer then found four trust-boundary bugs an external pass would
 * have caught first.
 *
 * Cheap where it can be: it keys on the CODE trees only (CODE_PATHS), so a
 * docs, copy or test-only push needs nothing, and a pure history rewrite (same
 * trees) passes. A recorded review covers that exact code state. Code a branch
 * took from origin/main (updating from main) is not new: only a code file that
 * differs from both the upstream and origin/main needs the review (newCodeFiles).
 *
 *   node scripts/check-external-review.mjs --hook            (the gate)
 *   node scripts/check-external-review.mjs --record <file>   (after the review
 *        and its fix pass: records the current code state as reviewed, citing
 *        the external review's output file)
 *   node scripts/check-external-review.mjs --status          (what a push needs)
 *
 * Emergency escape, visible in the transcript: prefix the push with
 * SKIP_EXTERNAL_REVIEW=1. The ledger lives in the git common dir, so every
 * worktree of the clone shares it and nothing is committed.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classify, currentBranch, pushConfigRedirects, simpleCommands, unmodelledForm } from './check-no-upstream-backlinks.mjs'

/** Directories and root files whose change is a change of behaviour. */
export const CODE_PATHS = [
  'app',
  'server',
  'shared',
  'lib',
  'plugin',
  'copilot-plugin',
  'drizzle',
  'scripts',
  'tools',
  'infra',
  '.github/workflows',
  '.claude-plugin',
  '.claude/settings.json',
  'package.json',
  'package-lock.json',
  'nuxt.config.ts',
  'tsconfig.json',
  'eslint.config.mjs',
  'vitest.config.ts',
  'Dockerfile',
]

export function isPush(command) {
  // A push the parser cannot see (a wrapper, an alias…) still counts, so decide() refuses it.
  return pushCommands(command).length > 0 || (/\bgit\b/.test(command) && unmodelledForm(command) !== null)
}

function pushCommands(command) {
  return simpleCommands(command).filter((w) => {
    const c = classify(w)
    return c?.tool === 'git' && c.sub === 'push'
  })
}

/** The escape counts only as an environment assignment on the push itself. */
export function pushSkipsReview(command) {
  const pushes = pushCommands(command)
  return (
    pushes.length > 0 &&
    pushes.every((words) => {
      const prefix = []
      for (const w of words) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) break
        prefix.push(w)
      }
      return prefix.includes('SKIP_EXTERNAL_REVIEW=1')
    })
  )
}
const MIN_REVIEW_BYTES = 200

const gitDefault = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A digest of the code trees at `ref`: equal digests mean equal code. */
export function codeFingerprint(ref, git = gitDefault) {
  const trees = CODE_PATHS.map((p) => {
    try {
      return `${p}:${git(['rev-parse', `${ref}:${p}`])}`
    } catch {
      return `${p}:-`
    }
  })
  return createHash('sha256').update(trees.join('\n')).digest('hex')
}

function ledgerPath(git = gitDefault) {
  return join(resolve(git(['rev-parse', '--git-common-dir'])), 'tokenscope-reviewed-code')
}

export function reviewedFingerprints(text) {
  return new Set(
    String(text ?? '')
      .split('\n')
      .map((l) => l.split('\t')[0].trim())
      .filter(Boolean),
  )
}

/**
 * Code files HEAD changes that are on neither `base` nor origin/main: what a
 * push would publish that no merged PR already carried. Updating a branch from
 * main brings main's merged (and reviewed) code into it; compared with the
 * branch's upstream alone, that code reads as new and the gate would ask for a
 * review of other PRs' code (five times on 2026-11-10). A changed file is let
 * through only when it CAME FROM MAIN: main changed it since the branch last
 * took main (their merge base), and HEAD's copy is main's copy. Everything else
 * that differs from the upstream still needs the review: the branch's own
 * changes, a hand-resolved conflict, and a branch change reverted back to
 * main's copy (main did not change that file, so the revert is the branch's
 * own work). Returns null when it cannot tell (no origin/main, no merge base,
 * a git error), and the caller then judges by the whole code fingerprint.
 *
 * Its limit is the gate's: it trusts the local origin/main ref. A ref moved by
 * hand to dodge the gate is deliberate evasion, which CI, the PR review and the
 * merge card still meet; a stale ref only makes the exemption smaller.
 */
export function newCodeFiles(base, git = gitDefault) {
  try {
    // ':(top)' anchors each path at the repository root, whatever folder the hook runs in;
    // -z keeps file names exact (no quoting, no trimmed spaces).
    const pathspecs = CODE_PATHS.map((p) => `:(top)${p}`)
    const changed = (from, to) =>
      new Set(
        // --no-relative: a diff.relative=true config would otherwise still limit the
        // output to the current folder, whatever the pathspecs say.
        git(['diff', '--name-only', '-z', '--no-renames', '--no-relative', from, to, '--', ...pathspecs])
          .split('\0')
          .filter(Boolean),
      )
    const vsBase = changed(base, 'HEAD')
    if (base === 'origin/main') return [...vsBase]
    const forkPoint = git(['merge-base', base, 'origin/main'])
    if (!forkPoint) return null
    const mainChanged = changed(forkPoint, 'origin/main')
    const vsMain = changed('origin/main', 'HEAD')
    return [...vsBase].filter((f) => vsMain.has(f) || !mainChanged.has(f))
  } catch {
    return null
  }
}

/** The ref a push is compared against: the branch's upstream, else origin/main. */
function pushBase(git = gitDefault) {
  try {
    return git(['rev-parse', '--abbrev-ref', '@{upstream}'])
  } catch {
    return 'origin/main'
  }
}

/**
 * Pure decision. `allow` with a reason, or `deny` with what to do.
 */
export function decide({ command, head, base, reviewed, branch = null, pushRedirected = false, newCode = null }) {
  if (!isPush(command)) return { allow: true, reason: 'not a push' }
  if (pushSkipsReview(command)) return { allow: true, reason: 'skipped explicitly' }
  // HEAD and the base are read in this directory: a push of another checkout
  // or other refs would be compared against the wrong code.
  const unmodelled = unmodelledForm(command, branch, pushRedirected)
  if (unmodelled) return { allow: false, unmodelled }
  if (head === base) return { allow: true, reason: 'no code change' }
  if (Array.isArray(newCode) && newCode.length === 0) return { allow: true, reason: 'only code already on origin/main' }
  if (reviewed.has(head)) return { allow: true, reason: 'reviewed' }
  return { allow: false }
}

/** The hook's and --status's one judgement, read from git in this directory. */
function judge(command, extra = {}) {
  const base = pushBase()
  const ledger = ledgerPath()
  const newCode = newCodeFiles(base)
  const d = decide({
    command,
    head: codeFingerprint('HEAD'),
    base: codeFingerprint(base),
    reviewed: reviewedFingerprints(existsSync(ledger) ? readFileSync(ledger, 'utf8') : ''),
    newCode,
    ...extra,
  })
  return { d, base, newCode }
}

function listed(files) {
  return files.length > 5 ? `${files.slice(0, 5).join(', ')} and ${files.length - 5} more` : files.join(', ')
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  )
}

function main(argv) {
  if (argv[0] === '--hook') {
    let command
    try {
      command = String(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '')
    } catch {
      return 0
    }
    if (!isPush(command)) return 0
    try {
      const { d, base, newCode } = judge(command, {
        branch: currentBranch(gitDefault),
        pushRedirected: pushConfigRedirects(gitDefault),
      })
      if (d.unmodelled) {
        deny(`External-review gate: cannot check this push: ${d.unmodelled}.`)
      } else if (!d.allow) {
        deny(
          `External-review gate: this push changes code (${CODE_PATHS.join(', ')}) against ${base} and no external review is recorded for it` +
            (newCode?.length ? ` (new here, not on origin/main: ${listed(newCode)}). ` : '. ') +
            `Run an external review of \`git diff ${base}...HEAD\` (CLAUDE.md "Review shapes": copilot or another non-Claude executor), ` +
            'do ONE fix pass, then `node scripts/check-external-review.mjs --record <review-output-file>` and push again. ' +
            'Emergency only: prefix the push with SKIP_EXTERNAL_REVIEW=1.',
        )
      }
    } catch {
      /* no git / no base: fail open, CI and the PR reviewer still run */
    }
    return 0
  }
  if (argv[0] === '--record') {
    const file = argv[1]
    if (!file || !existsSync(file) || statSync(file).size < MIN_REVIEW_BYTES) {
      console.error(`--record needs the external review's output file (at least ${MIN_REVIEW_BYTES} bytes)`)
      return 2
    }
    const fp = codeFingerprint('HEAD')
    appendFileSync(ledgerPath(), `${fp}\t${gitDefault(['rev-parse', 'HEAD'])}\t${new Date().toISOString()}\t${resolve(file)}\n`)
    console.log(`recorded: code state ${fp.slice(0, 12)} reviewed (${file})`)
    return 0
  }
  if (argv[0] === '--status') {
    // The same judgement the hook makes, with the same branch and push config, for a
    // plain push of the current branch.
    const { d, base, newCode } = judge('git push', {
      branch: currentBranch(gitDefault),
      pushRedirected: pushConfigRedirects(gitDefault),
    })
    console.log(
      d.unmodelled
        ? `push refused whatever the review: ${d.unmodelled}`
        : d.allow
          ? `push allowed (${d.reason}, against ${base})`
          : `push needs an external review (code changed against ${base}${newCode?.length ? `; new here, not on origin/main: ${listed(newCode)}` : ''})`,
    )
    return 0
  }
  console.error('usage: --hook | --record <review-output-file> | --status')
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2))
