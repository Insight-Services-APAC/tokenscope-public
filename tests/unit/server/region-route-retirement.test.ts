// @vitest-environment node
/*
 * Region absorbs Across — the RETIREMENT half (04-prototype-delta.md §6 acceptance).
 *
 * The mapping and the selector are only half the merge. The other half is that the
 * old surfaces are GONE, and gone is a claim a test has to make, because nothing
 * else fails when a retired route survives: it keeps working, keeps its own gate,
 * and quietly becomes the second implementation the merge existed to delete. The two
 * composers had already drifted that way once — engine/scope.ts records their
 * (day, lane) map-key separators diverging, one a space and one a NUL escape.
 *
 * A STATIC test over the filesystem, not a request test, for the same reason the
 * lane firewall is static: Nitro builds routes from the directory tree, so the tree
 * IS the routing table. A file present here is a live route whether or not any test
 * remembers to call it — and "the old route 404s" is exactly the absence of a file.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPORTS_ROUTES = join(ROOT, 'server', 'api', 'v1', 'reports')
const COMPONENTS = join(ROOT, 'app', 'components', 'reporting')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Strip block + line comments so prose ABOUT a retired route is not a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('the retired route families are gone — /reports/regional and /reports/across-regions 404', () => {
  for (const retired of ['regional', 'across-regions']) {
    it(`server/api/v1/reports/${retired}/ does not exist`, () => {
      expect(
        existsSync(join(REPORTS_ROUTES, retired)),
        `server/api/v1/reports/${retired}/ still exists — that route still serves, so it does not 404`,
      ).toBe(false)
    })
  }

  it('the Region family serves BOTH widths from one route set', () => {
    const region = readdirSync(join(REPORTS_ROUTES, 'region')).sort()
    /*
     * The five surfaces the two retired families each had, now once — plus
     * `behaviour`, which never existed on either. It arrived as a PAIR from the
     * exposure track (one Across handler, one Regional) and was collapsed here on
     * merge, which is the same shape this test exists to hold: one handler, two
     * widths, dispatched by `resolveRegionRequest`. Listing it is affirming that
     * decision, not loosening the guard — a seventh file still fails.
     */
    expect(region).toEqual([
      'active-trend.get.ts',
      'behaviour.get.ts',
      'drivers.get.ts',
      'index.get.ts',
      'seasonality.get.ts',
      'trend.get.ts',
    ])
  })

  it('the whole-company answer is a WIDTH of those routes, not a second route', () => {
    // No route file anywhere under /reports names itself for the whole company.
    const named = walk(REPORTS_ROUTES).filter((f) =>
      /across|whole-?company|all-?regions/i.test(f.slice(REPORTS_ROUTES.length)),
    )
    expect(named, `these route files name a whole-company route: ${named.join(', ')}`).toEqual([])
  })
})

describe('no CLIENT code still calls a retired endpoint', () => {
  it('nothing under app/ requests /reports/regional* or /reports/across-regions*', () => {
    const offenders: string[] = []
    for (const f of walk(join(ROOT, 'app'))) {
      if (!/\.(ts|vue)$/.test(f)) continue
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/\/reports\/(regional|across-regions)\b/.test(code)) offenders.push(f)
    }
    expect(offenders, `still calling a retired endpoint: ${offenders.join(', ')}`).toEqual([])
  })
})

/*
 * "No component is reachable from two scopes."
 *
 * The shell renders exactly one component per scope, and the Region scope's two
 * WIDTHS live behind ScopeRegion — one tab, one entry point. The failure this
 * guards is the obvious shortcut through the merge: leave both scope components
 * mounted off the shell under different conditions, so the same view answers under
 * two tabs and the "which scope am I in" question has two answers again.
 */
describe('the shell mounts one component per scope', () => {
  const shell = readFileSync(join(ROOT, 'app', 'pages', 'reporting', 'index.vue'), 'utf8')
  const body = stripComments(shell)

  it('renders exactly three scope components, one per REPORT_SCOPES entry', () => {
    const mounted = [...body.matchAll(/<ReportingScope(\w+)\b/g)].map((m) => m[1])
    expect(mounted.sort()).toEqual(['CostCentre', 'Finance', 'Region'])
  })

  it('never mounts a width container directly — both go through ScopeRegion', () => {
    expect(body).not.toMatch(/<ReportingScopeAcrossRegions\b/)
    expect(body).not.toMatch(/<ReportingScopeRegional\b/)
  })

  it('ScopeRegion is the ONLY mount point for the two width containers', () => {
    const mounters: string[] = []
    for (const f of walk(COMPONENTS)) {
      if (!f.endsWith('.vue')) continue
      if (f.endsWith('ScopeRegion.vue')) continue
      const code = stripComments(readFileSync(f, 'utf8'))
      if (/<ScopeAcrossRegions\b|<ScopeRegional\b/.test(code)) mounters.push(f)
    }
    expect(
      mounters,
      `these components also mount a width container: ${mounters.join(', ')}`,
    ).toEqual([])
  })

  it('the scope tabs are the three live scopes — no retired label survives', () => {
    expect(body).toMatch(/region:\s*'Region'/)
    expect(body).not.toMatch(/across:\s*'/)
    expect(body).not.toMatch(/regional:\s*'/)
  })
})
