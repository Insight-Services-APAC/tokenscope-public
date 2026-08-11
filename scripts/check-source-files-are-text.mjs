#!/usr/bin/env node
/*
 * check-source-files-are-text.mjs — CI guard.
 *
 * Fail the build if any tracked file that is not a known binary asset contains
 * a NUL byte.
 *
 * WHY THIS EXISTS. server/reporting/across-regions.ts carried two literal NUL
 * bytes, used as a composite map-key separator. NUL is the right CHARACTER for
 * that job — neither an ISO date nor a lane id can contain it — but written as a
 * raw byte it made the file `data` rather than text. ripgrep skipped it as
 * binary and `grep -c "^export"` returned nothing on 1200 lines of exports.
 *
 * The cost was not the file. It was that every grep-based audit, every "where
 * else does this pattern live" sweep and every refactor over the largest
 * whole-company query module silently under-reported, with no signal that
 * anything had been missed. It was found, written down as a quick win, and
 * still shipped — because nothing enforced it.
 *
 * Enabling this check found the same byte in two more files nobody had flagged
 * (server/api/v1/admin/rate-cards/index.post.ts, server/workers/archive-ledger.ts),
 * which is the argument for enforcing it rather than fixing the one known case.
 *
 * WHY TRACKED FILES RATHER THAN A DIRECTORY ALLOWLIST. The first version walked
 * a hand-maintained list of roots and matched a hand-maintained list of
 * extensions. Both under-covered, silently, which is the same failure mode the
 * check exists to prevent: `plugin/`, `copilot-plugin/`, `infra/`, every
 * root-level file (package.json, nuxt.config.ts, Dockerfile), every `.sh`,
 * `.css`, `.bicep`, `.py`, `.jsx` and every extensionless file were invisible.
 * Enumerating what git tracks and subtracting the known binary assets inverts
 * the default: a new file type is COVERED until someone declares it binary,
 * instead of ignored until someone remembers to add it.
 *
 * Run: node scripts/check-source-files-are-text.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/*
 * The repo the CALLER is in, not the one this script lives in. `git ls-files`
 * runs relative to a cwd while the reads resolved against the script's own
 * location, so the two could enumerate one tree and read another — and a
 * subprocess run from elsewhere silently reported success for a tree it never
 * looked at. Resolve once, use it for both.
 */
export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  } catch {
    return SCRIPT_ROOT
  }
}

const ROOT = SCRIPT_ROOT

/*
 * Real binary assets, which legitimately contain NUL. Everything else git
 * tracks is treated as text. Keep this list SMALL and justified — each entry
 * is a hole in the check, so adding one should feel like a decision.
 */
export const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'jar',
  'mp3', 'mp4', 'webm', 'mov', 'wav', 'ogg',
  'wasm', 'node', 'so', 'dylib', 'dll', 'exe', 'bin', 'class',
  'thumbnail',
])

/** @param {string} p @returns {boolean} */
export function isBinaryAsset(p) {
  const base = p.slice(p.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  /*
   * NO dot means NO extension, so the file is text — Dockerfile, LICENSE,
   * CODEOWNERS. Falling back to the whole name here would classify a file
   * literally named `bin`, `node` or `class` as a binary asset and skip it
   * silently, which is the exact failure this guard exists to prevent.
   *
   * A dot at index 0 (`.thumbnail`) IS an extension: the tracked design-tool
   * thumbnail is 310 NUL bytes, and reading it as extensionless failed the
   * build. Dotfiles that are genuinely text (.gitignore, .npmrc) are covered
   * because they simply do not appear in BINARY_EXTS.
   */
  if (dot === -1) return false
  const ext = base.slice(dot + 1).toLowerCase()
  if (!ext) return false // trailing dot
  return BINARY_EXTS.has(ext)
}


/**
 * Every tracked path git knows about, minus binary assets.
 * @param {string} base repo root
 * @returns {string[]} repo-relative paths
 */
export function candidateFiles(base = ROOT) {
  // -z: NUL-delimited, so a path containing a newline cannot split a record.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: base,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .toString('utf8')
    .split('\u0000')
    .filter(Boolean)
    .filter((p) => !isBinaryAsset(p))
}

/**
 * @param {string[]} files repo-relative paths
 * @param {string} base repo root
 * @returns {{ file: string, count: number }[]}
 */
export function findOffenders(files, base = ROOT) {
  const offenders = []
  for (const f of files) {
    const abs = join(base, f)
    let buf
    try {
      // A tracked path that is absent is a deleted-but-unstaged working tree,
      // not a violation. Anything else (permissions, I/O) FAILS CLOSED: a check
      // that reports success on files it could not read is the failure mode
      // this whole script exists to prevent.
      if (!statSync(abs).isFile()) continue
      buf = readFileSync(abs)
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ELOOP')) continue
      throw new Error(`could not read tracked file ${f}: ${err?.message ?? err}`, { cause: err })
    }
    let count = 0
    for (const b of buf) if (b === 0) count += 1
    if (count > 0) offenders.push({ file: f, count })
  }
  return offenders
}

function main() {
  const root = repoRoot()
  const files = candidateFiles(root)
  const offenders = findOffenders(files, root)

  if (offenders.length > 0) {
    for (const o of offenders) {
      console.error(
        `::error file=${o.file}::${o.count} NUL byte(s). This makes the file binary to ripgrep, grep, diffs and linters, so every text-based sweep silently skips it. Write the NUL as your language's escape instead (TypeScript/JS: the six characters backslash-u-0-0-0-0) — same runtime character, plain-text source. NOTE: in Postgres SQL a standard-conforming string does NOT interpret backslash escapes; use E'\\\\x00' or CHR(0) there. If the file is a binary asset, add its extension to BINARY_EXTS in scripts/check-source-files-are-text.mjs.`,
      )
    }
    console.error(`\n${offenders.length} tracked file(s) contain NUL bytes.`)
    process.exit(1)
  }

  // Deliberately NOT "are plain text": absence of NUL does not prove valid
  // UTF-8, and claiming more than the check establishes is how a guard starts
  // being trusted for something it never verified.
  console.log(`✓ ${files.length} tracked non-binary files contain no NUL bytes`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
