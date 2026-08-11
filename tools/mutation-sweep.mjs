#!/usr/bin/env node
/*
 * mutation-sweep — "is this line actually tested?", derived mechanically.
 *
 * WHY THIS EXISTS. Six consecutive adversarial-review rounds on one branch each
 * found the same defect shape: NEW code shipped un-mutated. Deleting a freshly
 * added line left the whole suite green, so nothing would notice a future
 * refactor removing it. Each round the author hand-picked which lines to
 * mutation-test, and the hand-picked list kept converging on the lines they
 * already had in mind — never the ones they had overlooked. That is not a
 * diligence problem; it is a method problem, and the fix is to stop choosing.
 *
 * This derives the candidate list from `git diff <base>...HEAD` over the given
 * paths: EVERY added line that is not blank, not a comment, and not pure
 * punctuation. It then, one line at a time, comments the line out, runs the test
 * command, and records whether anything failed.
 *
 *   SURVIVED = the suite passes without that line. Either it needs a test, or it
 *              is an equivalent mutant (behaviour genuinely unchanged — e.g. an
 *              alias whose value equals the generic branch). Both are fine
 *              ANSWERS; neither is a fine SILENCE. Justify survivors explicitly.
 *   KILLED   = something failed. The line is pinned.
 *
 * THREE SURVIVOR CATEGORIES you will actually see, and how to treat them:
 *
 *   1. TYPE-ONLY (an interface member, a type alias). Vitest transpiles via
 *      esbuild, which STRIPS types without checking them, so a test run can
 *      never kill these. They are pinned by `vue-tsc`, not by the suite — pass
 *      `--typecheck "npm run typecheck"` to have the sweep confirm that rather
 *      than assume it. A type-only line that survives BOTH is genuinely unused.
 *   2. EQUIVALENT MUTANT — removing it changes no observable behaviour (e.g. a
 *      fast-path branch returning the same value the general path computes).
 *      Legitimate, but write down WHY; "probably fine" is how round 6 happened.
 *   3. GENUINELY UNTESTED — the interesting case. Write the test.
 *
 * Deliberately crude: commenting a line out can produce a syntax error, which
 * shows up as KILLED. That is a false negative for coverage, so `--report`
 * flags non-assertion failures separately (BROKE) rather than counting them as
 * pinned.
 *
 * Usage:
 *   node tools/mutation-sweep.mjs --base main --paths server --test "npx vitest run tests/unit --reporter=dot"
 *   node tools/mutation-sweep.mjs --list          # just print the candidates
 *   node tools/mutation-sweep.mjs --only 12,15    # re-run specific candidates
 *
 * This is a REVIEW aid, not CI: a full sweep costs (number of added lines) x
 * (suite runtime). Run it on the diff before opening a PR, and paste the
 * survivor list + justifications into the PR description.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? true)
}
const BASE = arg('base', 'main')
const PATHS = String(arg('paths', 'server')).split(',')
const TEST_CMD = String(arg('test', 'npx vitest run tests/unit --reporter=dot'))
// Optional second gate, run ONLY for lines the test command could not kill.
// Type-only lines are invisible to a transpile-and-run suite but caught by the
// compiler; without this they look like coverage gaps and send you chasing tests
// that cannot exist. Kept opt-in because it roughly doubles the cost per survivor.
const TYPECHECK_CMD = arg('typecheck', null)
// Reap orphaned testcontainers between mutations. REQUIRED for any sweep whose
// test command touches tests/integration: tests/integration/helpers/db.ts disables
// Ryuk (testcontainers' reaper sidecar cannot work in this rootless podman-socket
// setup), so a container is only removed by stopTestDb() in afterAll. A sweep runs
// the suite once PER MUTATION and any interrupted run skips afterAll — which is how
// one sweep left 100 postgres containers saturating the host's podman healthchecks.
const NO_REAP = process.argv.includes('--no-reap')
const LIST_ONLY = process.argv.includes('--list')
const ONLY = arg('only', null)

// A line worth mutating: real code, not blank/comment/punctuation-only. The
// language-agnostic filter is deliberate — it over-includes rather than letting
// a judgement call quietly drop something.
const SKIP = /^\s*(\/\/|\/\*|\*|--|#|$)/
const PUNCT_ONLY = /^[\s{}()[\];,]*$/

/** Added lines from the diff, as {file, line, text} against the CURRENT worktree. */
function candidates() {
  // spawnSync with an ARGV array, never a shell string: BASE and PATHS come from
  // the command line, and interpolating them into a shell command would let a
  // path like `x; rm -rf ~` execute. (Copilot review, PR #185.)
  const res = spawnSync('git', ['diff', `${BASE}...HEAD`, '--unified=0', '--', ...PATHS], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.status !== 0) {
    console.error(`git diff failed: ${res.stderr || res.error?.message || 'unknown error'}`)
    process.exit(2)
  }
  const diff = res.stdout
  const out = []
  let file = null
  let lineNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      lineNo = Number(hunk[1])
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const text = raw.slice(1)
      if (file && !SKIP.test(text) && !PUNCT_ONLY.test(text)) out.push({ file, line: lineNo, text })
      lineNo++
    }
  }
  return out
}

/*
 * OWNERSHIP, not a time delta. An earlier version reaped every
 * org.testcontainers container absent from a start-of-run baseline — which on a
 * shared host (this one runs several CWs) would also kill a container ANOTHER run
 * started after our baseline was taken. It claimed in a comment to leave
 * concurrent runs alone and did not. Instead we stamp our own containers with a
 * unique session label (tests/integration/helpers/db.ts honours
 * TOKENSCOPE_TEST_SESSION) and reap ONLY that label, so ownership is explicit and
 * a concurrent run is untouchable by construction.
 */
// Pure-Node id: shelling out to `date` added an external dependency AND a crash
// path (a missing `date`, or non-string stdout, throws on .trim() before the sweep
// even starts). Nothing here needs a subprocess to know the time.
const SESSION_ID = `sweep-${process.pid}-${randomUUID().slice(0, 8)}`
process.env.TOKENSCOPE_TEST_SESSION = SESSION_ID

/** Ids of containers THIS sweep created, or null if docker could not be queried. */
function testcontainerIds() {
  const r = spawnSync('docker', ['ps', '-aq', '--filter', `label=tokenscope.test-session=${SESSION_ID}`], {
    encoding: 'utf8',
  })
  if (r.status !== 0 || r.error) return null
  return new Set((r.stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean))
}

/*
 * Probe docker once up front so an unavailable/flaky runtime disables reaping
 * LOUDLY rather than silently doing nothing all run. (Historic note: an earlier
 * version diffed a start-of-run baseline, and a failed first probe made every
 * container on the host look like ours — it would have deleted the operator's own.
 * Ownership labelling removed that failure mode entirely; the loud disable stays
 * because a silent no-op reaper is how orphans accumulate unnoticed.)
 */
const REAP_ENABLED = !NO_REAP && testcontainerIds() !== null
if (!NO_REAP && !REAP_ENABLED) {
  console.error('[mutation-sweep] could not query docker — reaping DISABLED for this run (run `npm run test:reap` after).')
}

/**
 * Remove the containers THIS sweep created — identified by our own
 * `tokenscope.test-session` label, never by a time-based delta. Ownership is
 * explicit, so a concurrent run (the operator's, or another CW's on this shared
 * host) is untouchable by construction rather than by timing luck. Do NOT
 * "simplify" this back to diffing a baseline: that silently captures containers
 * other runs started after the baseline was taken.
 */
function reap() {
  if (!REAP_ENABLED) return 0
  const ours = testcontainerIds()
  if (ours === null || ours.size === 0) return 0
  spawnSync('docker', ['rm', '-f', ...ours], { encoding: 'utf8' })
  return ours.size
}

const MARKER = '// MUTANT '
// SQL has no `//` comment form, so commenting a .sql line with the JS marker makes
// EVERY line of that file unrunnable — the sweep reports BROKE for all of them and
// proves nothing. Use the file's own comment syntax.
const SQL_MARKER = '-- MUTANT '
const markerFor = (file) => (file.endsWith('.sql') ? SQL_MARKER : MARKER)

/**
 * Comment out `line` in `file` (1-indexed), returning a restore function.
 *
 * Refuses when the line's current content does not match what the diff said was
 * there. Editing the tree DURING a sweep (easy to do while waiting out a long
 * run) shifts every line below the edit, after which the sweep silently mutates
 * innocent lines and reports them SURVIVED — a whole run's worth of false
 * reassurance, which is worse than no sweep at all. Learned the hard way.
 */
function mutate(file, line, expected) {
  const original = readFileSync(file, 'utf8')
  const lines = original.split('\n')
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return null
  if (expected !== undefined && lines[idx] !== expected) return null
  lines[idx] = `${markerFor(file)}${lines[idx]}`
  writeFileSync(file, lines.join('\n'))
  return () => writeFileSync(file, original)
}

/**
 * A killed sweep (SIGKILL, a crash, a closed terminal) cannot run its restore,
 * so it leaves a commented-out line in a source file — which then looks like an
 * ordinary edit and can be committed. Refuse to start until the tree is clean.
 */
function assertNoLeftoverMutations() {
  // Same argv-array treatment as candidates(); `git grep` exits 1 on no match,
  // which is the normal case here, so status is not an error signal.
  // Check BOTH marker forms — a killed sweep may have left either behind.
  // LINE-ANCHORED (-E '^// MUTANT '): mutate() prefixes the marker at column 0, so
  // anchoring distinguishes a real leftover from an ordinary mention of the string
  // — including the MARKER constants in THIS file, which otherwise make the sweep
  // refuse to start forever whenever tools/ is in --paths. (Found by running the
  // harness on itself.)
  const js = spawnSync('git', ['grep', '-nE', `^${MARKER}`, '--', ...PATHS], { encoding: 'utf8' })
  const sqlm = spawnSync('git', ['grep', '-nE', `^${SQL_MARKER}`, '--', ...PATHS], { encoding: 'utf8' })
  const hits = `${js.stdout ?? ''}${sqlm.stdout ?? ''}`
  if (hits.trim()) {
    console.error(`Refusing to run: leftover mutation markers from an interrupted sweep.\n${hits}`)
    console.error('Revert them (git checkout -- <file>) before sweeping again.')
    process.exit(2)
  }
}

// A killed sweep (pkill sends SIGTERM) must still restore the file it mutated and
// reap its containers — otherwise it leaves both a commented-out source line and a
// pile of orphan postgres containers. SIGKILL cannot be caught: that residue is NOT
// self-healing, because a later sweep only ever reaps its OWN session label. Clean
// it up with `npm run test:reap`; assertNoLeftoverMutations catches the file half.
let activeRestore = null
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (activeRestore) activeRestore()
    const n = reap()
    console.error(`\n[mutation-sweep] interrupted — restored the mutated file, reaped ${n} container(s).`)
    process.exit(130)
  })
}

assertNoLeftoverMutations()
const all = candidates()
if (LIST_ONLY) {
  all.forEach((c, i) => console.log(`${i}\t${c.file}:${c.line}\t${c.text.trim().slice(0, 100)}`))
  console.log(`\n${all.length} candidate line(s).`)
  process.exit(0)
}

const selected = ONLY ? String(ONLY).split(',').map((n) => all[Number(n)]).filter(Boolean) : all
console.log(`Sweeping ${selected.length} of ${all.length} candidate line(s) against: ${TEST_CMD}\n`)

const results = []
for (const [i, c] of selected.entries()) {
  const restore = mutate(c.file, c.line, c.text)
  if (!restore) {
    // Content drift: the tree changed under us (a concurrent edit, or an earlier
    // mutation left behind). Report rather than silently mutating the wrong line.
    results.push({ ...c, verdict: 'DRIFTED' })
    console.log(`[${i + 1}/${selected.length}] DRIFTED  ${c.file}:${c.line}  (line no longer matches the diff — re-run on a quiet tree)`)
    continue
  }
  activeRestore = restore
  const run = spawnSync('bash', ['-lc', TEST_CMD], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  restore()
  activeRestore = null
  reap() // per-mutation: never let containers accumulate across 70+ runs
  const output = `${run.stdout}\n${run.stderr}`
  // A transform/parse error means the mutation broke syntax — the line is not
  // proven pinned, it was just unrunnable. Do not count it as covered.
  const broke = /Transform failed|SyntaxError|Expected "|error TS/.test(output)
  const failed = run.status !== 0
  let verdict = broke ? 'BROKE' : failed ? 'KILLED' : 'SURVIVED'
  // Second chance for apparent survivors: the compiler may pin what the runtime
  // suite cannot see. Re-mutate (the first pass restored the file) and typecheck.
  if (verdict === 'SURVIVED' && TYPECHECK_CMD) {
    const restore2 = mutate(c.file, c.line, c.text)
    if (restore2) {
      const tc = spawnSync('bash', ['-lc', String(TYPECHECK_CMD)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      restore2()
      if (tc.status !== 0) verdict = 'TYPE-PINNED'
    }
  }
  results.push({ ...c, verdict })
  console.log(`[${i + 1}/${selected.length}] ${verdict.padEnd(8)} ${c.file}:${c.line}  ${c.text.trim().slice(0, 80)}`)
}

const survived = results.filter((r) => r.verdict === 'SURVIVED')
const broke = results.filter((r) => r.verdict === 'BROKE')
const typePinned = results.filter((r) => r.verdict === 'TYPE-PINNED')
const drifted = results.filter((r) => r.verdict === 'DRIFTED')
console.log(
  `\n${results.filter((r) => r.verdict === 'KILLED').length} killed, ${typePinned.length} type-pinned, ${survived.length} survived, ${broke.length} unrunnable, ${drifted.length} drifted.`,
)
if (drifted.length) console.log('\nDRIFTED — the worktree changed mid-sweep; these lines were NOT tested. Re-run without editing.')
if (survived.length) {
  console.log('\nSURVIVORS — each needs a test or a written justification:')
  for (const s of survived) console.log(`  ${s.file}:${s.line}  ${s.text.trim().slice(0, 100)}`)
}
if (broke.length) {
  console.log('\nUNRUNNABLE (mutation broke syntax — coverage NOT proven):')
  for (const b of broke) console.log(`  ${b.file}:${b.line}  ${b.text.trim().slice(0, 100)}`)
}
process.exit(survived.length ? 1 : 0)
