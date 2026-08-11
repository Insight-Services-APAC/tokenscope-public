#!/usr/bin/env node
/*
 * check-plugin-version-bump.mjs — CI guard.
 *
 * Claude Code / Copilot CLI only auto-reinstall a plugin when its
 * MARKETPLACE-entry version increases (tests/unit/plugin/version-sync.test.ts
 * enforces that plugin.json and the marketplace entry agree with each
 * other — it does NOT enforce that either one actually goes UP). A
 * same-version code edit is invisible to that test and strands the whole
 * fleet on the old code silently: 0.1.25 (#174) and #115 both shipped this
 * way. This check closes that gap: if a diff touches plugin code, the
 * plugin's version AND its marketplace entry must be a STRICTLY GREATER
 * semver than origin/main's — not merely present and self-consistent.
 *
 * Run: npm run check:plugin-version-bump
 * Override the base ref (e.g. for local testing against a scratch branch):
 *   VERSION_BUMP_BASE_REF=main node scripts/check-plugin-version-bump.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MARKETPLACE_PATH = '.claude-plugin/marketplace.json'

// Path prefixes that constitute a "plugin code change" for each distributed
// plugin. `docOnly` entries are exact-path carve-outs so doc-only edits
// (e.g. plugin/README.md) don't trip the gate.
export const SURFACES = [
  {
    label: 'tokenscope (Claude plugin)',
    prefixes: ['plugin/scripts/', 'plugin/hooks/', 'plugin/commands/', 'plugin/.mcp.json', 'plugin/.claude-plugin/'],
    docOnly: ['plugin/README.md'],
    pluginJsonPath: 'plugin/.claude-plugin/plugin.json',
    marketplaceEntryName: 'tokenscope',
  },
  {
    label: 'tokenscope-copilot (Copilot plugin)',
    prefixes: ['copilot-plugin/scripts/', 'copilot-plugin/hooks/', 'copilot-plugin/skills/', 'copilot-plugin/.mcp.json', 'copilot-plugin/plugin.json'],
    docOnly: [],
    pluginJsonPath: 'copilot-plugin/plugin.json',
    marketplaceEntryName: 'tokenscope-copilot',
  },
]

/** Parse "x.y.z" into [x, y, z]. Throws on anything else — no silent coercion. */
function parseSemver(v) {
  const m = typeof v === 'string' && v.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) throw new Error(`not a well-formed x.y.z semver: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** -1 / 0 / 1 as `a` compares to `b`. Exported for the unit test. */
export function compareSemver(a, b) {
  const [a1, a2, a3] = parseSemver(a)
  const [b1, b2, b3] = parseSemver(b)
  if (a1 !== b1) return a1 < b1 ? -1 : 1
  if (a2 !== b2) return a2 < b2 ? -1 : 1
  if (a3 !== b3) return a3 < b3 ? -1 : 1
  return 0
}

/** True if any changed file falls under one of `surface`'s prefixes and isn't doc-only-exempt. */
export function touchesSurface(changedFiles, surface) {
  return changedFiles.some((f) => {
    if (surface.docOnly.includes(f)) return false
    return surface.prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
  })
}

/**
 * Pure comparator: given the changed-files list and a surface's old/new
 * versions, decide whether a bump was required and whether it happened.
 * Exported for the unit test — this is the function the five scenarios
 * (same / lower / higher / no plugin files touched / docs-only touched)
 * drive directly, without shelling out to git.
 */
export function evaluateBump({ changedFiles, surface, oldVersion, newVersion }) {
  if (!touchesSurface(changedFiles, surface)) {
    return { required: false, ok: true, cmp: null }
  }
  const cmp = compareSemver(newVersion, oldVersion)
  return { required: true, ok: cmp > 0, cmp }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

function changedFilesAgainst(baseRef) {
  return git(['diff', '--name-only', `${baseRef}...HEAD`])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Read a JSON file as it existed at `ref`, or null if the path didn't exist there. */
function readJsonAtRef(ref, relPath) {
  try {
    return JSON.parse(git(['show', `${ref}:${relPath}`]))
  } catch {
    return null
  }
}

function readJsonNow(relPath) {
  return JSON.parse(readFileSync(resolve(root, relPath), 'utf8'))
}

function marketplaceEntryVersion(marketplaceJson, name) {
  const entry = (marketplaceJson?.plugins ?? []).find((p) => p.name === name)
  return entry ? entry.version : null
}

function main() {
  const baseRef = process.env.VERSION_BUMP_BASE_REF || 'origin/main'

  let changedFiles
  try {
    changedFiles = changedFilesAgainst(baseRef)
  } catch (err) {
    console.error(`✗ could not diff against ${baseRef}: ${err.message}`)
    console.error('  (CI checks out with fetch-depth: 0 specifically so this ref is available — see .github/workflows/ci.yml)')
    process.exit(1)
  }

  const marketplaceNow = readJsonNow(MARKETPLACE_PATH)
  const marketplaceBase = readJsonAtRef(baseRef, MARKETPLACE_PATH)

  let failed = false

  for (const surface of SURFACES) {
    if (!touchesSurface(changedFiles, surface)) {
      console.log(`- ${surface.label}: no plugin-surface files touched, no bump required`)
      continue
    }

    const pluginJsonNow = readJsonNow(surface.pluginJsonPath)
    const pluginJsonBase = readJsonAtRef(baseRef, surface.pluginJsonPath)

    if (!pluginJsonBase) {
      console.log(`- ${surface.label}: ${surface.pluginJsonPath} did not exist at ${baseRef} — new plugin, skipping bump comparison`)
      continue
    }

    const checks = [
      {
        what: `${surface.pluginJsonPath} version`,
        oldVersion: pluginJsonBase.version,
        newVersion: pluginJsonNow.version,
      },
      {
        what: `marketplace entry "${surface.marketplaceEntryName}" version`,
        oldVersion: marketplaceEntryVersion(marketplaceBase, surface.marketplaceEntryName),
        newVersion: marketplaceEntryVersion(marketplaceNow, surface.marketplaceEntryName),
      },
    ]

    for (const { what, oldVersion, newVersion } of checks) {
      if (!oldVersion || !newVersion) {
        console.error(`✗ ${surface.label}: could not resolve ${what} (old=${oldVersion}, new=${newVersion})`)
        failed = true
        continue
      }
      const result = evaluateBump({ changedFiles, surface, oldVersion, newVersion })
      if (!result.ok) {
        console.error(
          `✗ ${surface.label}: plugin surface changed but ${what} did not increase (${oldVersion} → ${newVersion}). ` +
            `Claude Code / Copilot CLI only auto-reinstall on a version INCREASE — bump plugin.json AND the marketplace entry.`,
        )
        failed = true
      } else {
        console.log(`✓ ${surface.label}: ${what} increased (${oldVersion} → ${newVersion})`)
      }
    }
  }

  if (failed) process.exit(1)
  console.log('✓ plugin version bump gate passed')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
