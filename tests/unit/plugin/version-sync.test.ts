/*
 * Distribution guard: Claude Code auto-reinstalls a plugin ONLY when the
 * MARKETPLACE entry's version increases — plugin.json alone is what a manual
 * `/plugin update` reads. A bump that misses marketplace.json therefore strands
 * the whole fleet on the old code SILENTLY: 0.1.25 (#174, the AUTO shim policy +
 * loud stash guard) shipped exactly this way and never auto-propagated; #115 hit
 * the same trap before it. Keep every version field in lockstep so a partial
 * bump fails CI instead of the fleet.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// Vitest runs with cwd at the repo root (the pattern claude-redeem.test.ts
// already uses for exactly this reason) — resolve everything from there
// rather than import.meta.url, whose relative-URL resolution is unreliable
// for a bare directory reference under this project's Vite/Vitest transform.
const ROOT = process.cwd()

function readJson(relPath: string) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'))
}

const marketplace = readJson('.claude-plugin/marketplace.json')
const claudePlugin = readJson('plugin/.claude-plugin/plugin.json')
const copilotPlugin = readJson('copilot-plugin/plugin.json')

function marketplaceEntry(name: string) {
  const entry = (marketplace.plugins ?? []).find((p: { name: string }) => p.name === name)
  expect(entry, `marketplace.json has no "${name}" plugin entry`).toBeDefined()
  return entry
}

describe('plugin version lockstep (marketplace is what the fleet auto-updates from)', () => {
  it('tokenscope: marketplace entry version === plugin.json version', () => {
    expect(marketplaceEntry('tokenscope').version).toBe(claudePlugin.version)
  })

  it('tokenscope: marketplace metadata.version tracks the tokenscope plugin version', () => {
    // Repo CONVENTION, not a CC requirement (CC only reads the plugin entry
    // version): keeping the catalogue version in the same lockstep means "did
    // the bump reach marketplace.json" is answerable from any one field.
    expect(marketplace.metadata.version).toBe(claudePlugin.version)
  })

  it('tokenscope-copilot: marketplace entry version === copilot-plugin/plugin.json version', () => {
    expect(marketplaceEntry('tokenscope-copilot').version).toBe(copilotPlugin.version)
  })

  it('versions are well-formed semver-ish x.y.z', () => {
    for (const v of [claudePlugin.version, copilotPlugin.version, marketplace.metadata.version]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})

// ── S1: distribution-manifest + sync-manifest guards ──────────────────────────

function readIfExists(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Recursively collect every file under `dir` whose name matches `pattern`. */
function walk(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, pattern))
    else if (entry.isFile() && pattern.test(entry.name)) out.push(full)
  }
  return out
}

describe('distribution manifest — S1: every file under plugin/scripts/ must be reachable', () => {
  // Distribution guard: a file that ships in plugin/scripts/ but is never
  // referenced by the hook, a command, .mcp.json, or another plugin script is
  // either dead weight that should have been deleted, or — the sharper
  // failure — a NEW file whose wiring was forgotten (imported nowhere, so it
  // silently never runs). Checked by substring presence of the bare filename
  // across a broad reference corpus, which catches BOTH static `import`
  // statements and dynamic `join(dir, 'x.mjs')`-style references without
  // needing a real JS parser.
  const scriptsDir = join(ROOT, 'plugin/scripts')
  const scriptFiles = readdirSync(scriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mjs|sh)$/.test(e.name))
    .map((e) => e.name)

  const referenceCorpusPaths = [
    join(ROOT, 'plugin/hooks/hooks.json'),
    ...walk(join(ROOT, 'plugin/hooks'), /\.mjs$/),
    ...walk(join(ROOT, 'plugin/commands'), /\.md$/),
    join(ROOT, 'plugin/.mcp.json'),
    join(ROOT, 'plugin/README.md'),
    // Other plugin/scripts files themselves — for cross-references (imports,
    // dynamic joins, or a comment naming a sibling file).
    ...scriptFiles.map((f) => join(scriptsDir, f)),
    // The Copilot lane: files here are vendored FROM plugin/scripts/ (see
    // sync-copilot-plugin.mjs) and referenced by the Copilot hook/skills.
    join(ROOT, 'copilot-plugin/hooks/hooks.json'),
    ...walk(join(ROOT, 'copilot-plugin/hooks'), /\.mjs$/),
    ...walk(join(ROOT, 'copilot-plugin/skills'), /\.md$/),
    join(ROOT, 'scripts/sync-copilot-plugin.mjs'),
    join(ROOT, 'scripts/check-copilot-plugin-sync.mjs'),
  ]

  it('every plugin/scripts/*.{mjs,sh} file is named somewhere OUTSIDE its own content', () => {
    const unreferenced: string[] = []
    for (const file of scriptFiles) {
      const corpus = referenceCorpusPaths
        .filter((p) => join(scriptsDir, file) !== p) // exclude the candidate's own file
        .map(readIfExists)
        .join('\n')
      if (!corpus.includes(file)) unreferenced.push(file)
    }
    expect(unreferenced, `unreferenced under plugin/scripts/: ${unreferenced.join(', ')}`).toEqual([])
  })

  // Explicit regression pin for the five files an earlier draft's test list
  // omitted — each is referenced only INDIRECTLY (a dynamic join, not a
  // static import), which is exactly the shape the heuristic above must not
  // miss.
  it.each(['statusline.mjs', 'statusline-toggle.mjs', 'tokenscope-reader.mjs', 'otlp-shim-policy.mjs', 'otlp-logs.mjs'])(
    '%s is present and reachable',
    (name) => {
      expect(scriptFiles).toContain(name)
    },
  )
})

describe('sync manifest — S1: every file a copilot-plugin/scripts/*.mjs sibling imports is tracked for drift', () => {
  // The shape of BD-2: a copilot-plugin/scripts file gains a `./X.mjs` import
  // for a genuinely VENDORED module (one that also exists, byte-identical
  // modulo the SYNC NOTE, in plugin/scripts/) before X.mjs is added to
  // sync-copilot-plugin.mjs's FILES list — so the copy silently never gets
  // parity-checked (or, worse, never gets copied at all and the import is
  // dangling). Two files (enrollment-secret.mjs, landed-check.mjs) are
  // DELIBERATELY divergent per-lane implementations that happen to share a
  // name with a Claude-side file — never sync-managed by design — and are
  // exempted below with the reason.
  const DELIBERATELY_NOT_VENDORED = new Set(['enrollment-secret.mjs', 'landed-check.mjs'])

  const syncScriptSrc = readFileSync(join(ROOT, 'scripts/sync-copilot-plugin.mjs'), 'utf8')
  // Pull the FILES list's `name: '...'` entries out of the source (cheaper
  // and more robust across ESM/CJS than executing the script here).
  const filesListNames = [...syncScriptSrc.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])

  const copilotScriptsDir = join(ROOT, 'copilot-plugin/scripts')
  const copilotScriptFiles = readdirSync(copilotScriptsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => e.name)

  it('the FILES list is non-empty (sanity: the regex above actually matched something)', () => {
    expect(filesListNames.length).toBeGreaterThan(0)
  })

  for (const importer of copilotScriptFiles) {
    it(`${importer}: every local import is either vendor-tracked or a documented exemption`, () => {
      const src = readFileSync(join(copilotScriptsDir, importer), 'utf8')
      const localImports = [...src.matchAll(/from\s+'\.\/([\w.-]+\.mjs)'/g)].map((m) => m[1])
      const untracked = localImports.filter(
        (name) => !filesListNames.includes(name) && !DELIBERATELY_NOT_VENDORED.has(name),
      )
      expect(untracked, `${importer} imports ${untracked.join(', ')} — not in sync-copilot-plugin.mjs's FILES and not a documented exemption`).toEqual([])
    })
  }
})
