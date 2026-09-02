#!/usr/bin/env node
/*
 * check-sql-comment-backticks.mjs — a backtick in a SQL comment ENDS the query.
 *
 * THE RULE: no backtick inside a `--` SQL comment.
 *
 * Inside a sql`…` tagged template, a backtick closes the template. Put one in a
 * `-- comment` and everything after it becomes TypeScript, so the file fails to
 * parse — and the parse error points at a LATER line, usually in a different
 * construct, so the reported location is not the fault. That misdirection is
 * what makes it expensive: the obvious suspects are all innocent.
 *
 * Nothing else catches it. It is not a type error, not a lint rule, and the
 * tests do not run because the file cannot load at all.
 *
 * The check is a line test rather than a template parser on purpose: `--` at the
 * start of a line in TypeScript is a pre-decrement, which is vanishingly rare
 * and would be strange style anyway, so the false-positive rate is effectively
 * zero and the rule stays readable.
 *
 * ESCAPED backticks are fine and are not flagged: a `\\`` inside a template
 * literal does not close it, and flagging one would make this cry wolf.
 *
 * KNOWN GAP, deliberately left, and typecheck is the backstop. This catches
 * `--` comments only. A backtick in
 * a BLOCK comment inside a template fails identically, but every attempt to
 * catch it has produced false positives: `*`-prefixed lines are ordinary JSDoc
 * everywhere in the repo, and locating the template terminator instead trips on
 * prose that merely mentions sql`` . A guard that cries wolf gets switched off,
 * so this stays narrow and honest rather than broad and ignored.
 *
 * The gap is DIAGNOSTIC, not correctness: a block-comment backtick still breaks
 * the parse, so `typecheck` fails either way. What it loses is the clear
 * message — typecheck reports "',' expected" on a line that looks fine, several
 * lines past the real fault. If that costs anyone real time again, the fix is a
 * proper template-region scanner, not a wider line test: `*`-prefixed lines are
 * ordinary JSDoc across this repo, and flagging them was tried and reverted.
 *
 * Run: node scripts/check-sql-comment-backticks.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOTS = ['server', 'shared', 'drizzle', 'app', 'tests']
const SKIP = new Set(['node_modules', '.nuxt', '.output', 'dist', '.git'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|vue|mjs)$/.test(entry)) out.push(p)
  }
  return out
}

const offenders = []
for (const base of ROOTS) {
  const dir = join(root, base)
  try {
    statSync(dir)
  } catch {
    continue
  }
  for (const file of walk(dir)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // UNESCAPED only. A `\`` inside a template literal is legal and renders
      // as a literal backtick in the SQL comment — flagging it would be a false
      // positive, and a guard that cries wolf gets switched off.
      if (/^\s*--/.test(line) && /(^|[^\\])`/.test(line)) {
        offenders.push(`${relative(root, file)}:${i + 1}  ${line.trim().slice(0, 90)}`)
      }
    })
  }
}

if (offenders.length) {
  console.error(
    '✗ backtick inside a SQL comment — this CLOSES the surrounding sql`` template,\n' +
      '  and the resulting parse error points at an unrelated later line.\n' +
      '  Drop the backticks; name the identifier in plain text.\n',
  )
  for (const o of offenders) console.error(`  ${o}`)
  process.exit(1)
}

console.warn('✓ no backticks inside SQL comments')
