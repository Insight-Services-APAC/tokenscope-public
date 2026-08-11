/*
 * component-graph — which components does a reporting scope actually render?
 *
 * The parity gate needs to answer "is this card on this page?" without booting
 * Nuxt or a database. It resolves the transitive component tree from each
 * scope's root SFC, following BOTH explicit relative imports and template tags
 * (Nuxt auto-imports mean a component can be used with no import statement at
 * all — `<ReportingScopeRegion />` resolves to
 * `app/components/reporting/ScopeRegion.vue`).
 *
 * This is deliberately a STATIC read. A rendered test would need fixtures for
 * every scope and would answer "does it render with THIS data" — which is a
 * different, weaker question than "is this card wired to this page".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'

/*
 * COMPONENTS ONLY. This indexed all of `app/`, which pulled in `app/pages/**` —
 * nine files named `index.vue` and three named `[id].vue`. With a basename key
 * and first-match-wins, tag resolution was order-dependent, and the walk could
 * wander out of a scope's component tree into an unrelated page and report a
 * surface "present" on the strength of it. Nuxt only auto-imports from
 * `app/components` anyway, so this is also the more faithful index.
 */
const APP = resolve(process.cwd(), 'app', 'components')

/** Every `.vue` under app/, indexed by basename (without extension). */
function indexVueFiles(dir: string, out = new Map<string, string[]>()): Map<string, string[]> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      indexVueFiles(full, out)
    } else if (entry.endsWith('.vue')) {
      const name = basename(entry, '.vue')
      out.set(name, [...(out.get(name) ?? []), full])
    }
  }
  return out
}

const INDEX = indexVueFiles(APP)

/**
 * Nuxt prefixes an auto-imported component with its directory path, so
 * `components/reporting/ScopeRegion.vue` is `<ReportingScopeRegion>`. Resolve a
 * template tag by trying the whole name, then progressively stripping leading
 * PascalCase segments until one matches a real file.
 */
function resolveTag(tag: string, fromDir: string): string | null {
  /*
   * AMBIGUITY RESOLVES TOWARDS FEWER EDGES, NOT MORE. `DetailDrawer` exists three
   * times even within `app/components`, so a basename can still match several
   * files. Prefer one under the importing file's own directory — Nuxt's own
   * precedence is path-based — and if that does not disambiguate, resolve to
   * NOTHING rather than guessing.
   *
   * The direction matters for a gate that asserts PRESENCE: an over-approximated
   * tree can report a surface wired when it is not, which is a false pass and the
   * exact failure this whole gate exists to prevent. Under-approximating can only
   * produce a false FAILURE, which a human then reads.
   */
  const pick = (name: string): string | null => {
    const hits = INDEX.get(name)
    if (!hits?.length) return null
    if (hits.length === 1) return hits[0]!
    const local = hits.filter((h) => dirname(h) === fromDir)
    return local.length === 1 ? local[0]! : null
  }
  const direct = pick(tag)
  if (direct) return direct
  const parts = tag.match(/[A-Z][a-z0-9]*/g) ?? []
  for (let i = 1; i < parts.length; i++) {
    const hit = pick(parts.slice(i).join(''))
    if (hit) return hit
  }
  return null
}

export interface ScopeTree {
  /** Absolute paths of every SFC reachable from the root. */
  files: string[]
  /** Basenames of every reachable component, for membership tests. */
  components: Set<string>
  /** Concatenated source of the whole tree, for text assertions. */
  source: string
}

/**
 * Walk from a root SFC. `stopAt` prevents a scope's tree swallowing a sibling
 * scope's — the Region tab genuinely contains both widths, but the cost-centre
 * tree must not reach into Region's just because something re-exports it.
 */
export function scopeTree(rootBasename: string, stopAt: string[] = []): ScopeTree {
  const rootPaths = INDEX.get(rootBasename)
  if (!rootPaths) throw new Error(`scope root not found: ${rootBasename}.vue`)
  const stop = new Set(stopAt)
  const seen = new Set<string>()
  const queue = [rootPaths[0]!]
  const files: string[] = []

  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
    const src = readFileSync(file, 'utf8')

    // Explicit relative imports of SFCs.
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+\.vue)['"]/g)) {
      const target = resolve(dirname(file), m[1]!)
      if (!stop.has(basename(target, '.vue'))) queue.push(target)
    }
    // Template tags — the auto-import path.
    for (const m of src.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
      const tag = m[1]!
      if (stop.has(tag)) continue
      const target = resolveTag(tag, dirname(file))
      if (target) queue.push(target)
    }
  }

  return {
    files,
    components: new Set(files.map((f) => basename(f, '.vue'))),
    source: files.map((f) => readFileSync(f, 'utf8')).join('\n'),
  }
}

/**
 * The four reporting scopes, keyed to match `inventory.json`. The Region TAB
 * owns two widths behind its own selector (Reporting.md §7), which is why
 * `across` and `region` have different roots but the same tab.
 */
export const SCOPE_ROOTS: Record<string, { root: string; stopAt?: string[] }> = {
  across: { root: 'ScopeAcrossRegionsView' },
  region: { root: 'ScopeRegionalView', stopAt: ['ScopeAcrossRegions', 'ScopeAcrossRegionsView'] },
  cc: { root: 'ScopeCostCentreView' },
  finance: { root: 'ScopeFinanceView' },
}
