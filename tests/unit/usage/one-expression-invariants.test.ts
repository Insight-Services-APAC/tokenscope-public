/*
 * SOURCE-LEVEL invariants for the three "there is only one of these" claims the
 * unhomed probe and the §A/§B card make about themselves.
 *
 * These are properties of the CODE, not of any dataset, and no fixture can
 * express them: two expressions for the same quantity agree on every test
 * estate right up until they do not, and a drill split across two statements
 * returns identical numbers on a quiescent database. A behavioural test
 * therefore cannot fail when the property is broken — which is precisely how
 * each of them was broken in the first place while the suite stayed green.
 *
 * Same technique and the same justification as tests/unit/pages/
 * unhomed-causes-panel.test.ts: assert the property against the source, name
 * the mutation each assertion kills, and keep the assertion narrow enough that
 * an innocent edit does not trip it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

const AB = read('server/usage/ab-decomposition.ts')
const PROBE = read('server/usage/unhomed-causes.ts')
const HOLDING_MODULE = 'shared/placement/holding-nodes.ts'
const HOLDING = read(HOLDING_MODULE)

/**
 * Everything outside a block comment, a `//` line comment or an HTML comment.
 *
 * A single forward scan, NOT regex replacement, for two independent reasons.
 *
 * Correctness: removing a multi-character delimiter by replacement can reassemble
 * that same delimiter from the surrounding text, and the earlier line-comment
 * pattern only matched lines that BEGAN with `//`, so a trailing `// ...` stayed in
 * the output. Both leave comment text in `code()`'s result, which is precisely how a
 * claim that lives only in a comment could satisfy an assertion about the code — the
 * failure this whole file exists to catch.
 *
 * String awareness: a scanner that did not track quoting would eat from the `//` in
 * a URL literal to end of line and silently delete real code. Quoted spans are
 * therefore copied through verbatim.
 *
 * Newlines are preserved so line-oriented assertions keep their shape.
 */
function code(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      out += ch
      i += 1
      while (i < src.length) {
        out += src[i]
        if (src[i] === '\\') {
          if (i + 1 < src.length) out += src[i + 1]
          i += 2
          continue
        }
        if (src[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end === -1 ? src.length : end + 3
      continue
    }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i + 2)
      i = end === -1 ? src.length : end
      continue
    }

    out += ch
    i += 1
  }
  return out
}

/**
 * EVERY first-party source file under `roots`, DISCOVERED — never a list.
 *
 * A hardcoded list is invisible to the one regression the check below exists to
 * catch: the file that was added without anyone updating the list. Proven, not
 * assumed — a new file carrying both sentinel literals left the suite green.
 */
function sourceFiles(roots: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.(ts|mts|vue)$/.test(entry.name)) out.push(relative(ROOT, p))
    }
  }
  for (const r of roots) walk(resolve(ROOT, r))
  return out.sort()
}

/*
 * `code()` decides what every assertion below is allowed to see, so a bug in it
 * silently weakens all of them: strip too little and a claim living in a comment
 * satisfies an assertion about the code, strip too much and real code vanishes
 * and the assertion passes for the wrong reason. It has been wrong twice — once
 * leaving trailing `// ...` in the output, once reassembling a delimiter it had
 * just removed — and both times nothing caught it, because the helper that
 * guards the guards had no guard.
 */
describe('code() — the comment stripper the other assertions rest on', () => {
  it('strips a trailing line comment, not just a whole-line one', () => {
    expect(code("const a = 1 // '__UNPLACED__'\n")).not.toContain('__UNPLACED__')
    expect(code("const a = 1 // x\n")).toContain('const a = 1')
  })

  it('strips block and HTML comments', () => {
    expect(code('a /* __UNPLACED__ */ b')).toBe('a  b')
    expect(code('a <!-- __UNPLACED__ --> b')).toBe('a  b')
  })

  /*
   * The property that matters is that comment CONTENT never reaches the output,
   * not that no delimiter fragment survives. Removing a span can leave text on
   * either side that abuts into a fresh `<!--`, and this scanner does exactly
   * that on the pathological input below. That is acceptable and deliberate:
   * `code()` runs once, nothing re-scans its output for comments, and a bare
   * delimiter carries no claim. Asserted explicitly so the next reader does not
   * "fix" it into a rescan loop and reintroduce the unbounded-work risk.
   */
  it('removes comment content even when the delimiters abut into a new one', () => {
    const out = code('<!<!-- __UNPLACED__ -->-- tail')
    expect(out).not.toContain('__UNPLACED__')
    expect(out).toContain('tail')
    expect(out).toContain('<!--')
  })

  it('leaves quoted text alone, including a URL that contains //', () => {
    expect(code("const u = 'https://example.com/x'\n")).toContain('https://example.com/x')
    expect(code('const s = "a // b"')).toContain('a // b')
    expect(code('const t = `a /* b */ c`')).toContain('/* b */')
  })

  it('does not let an escaped quote end a string early', () => {
    expect(code("const s = 'it\\'s // not a comment'")).toContain('// not a comment')
  })

  it('preserves newlines so line-oriented assertions keep their shape', () => {
    expect(code('a // c\nb\n').split('\n').length).toBe(3)
  })

  it('tolerates an unterminated comment without looping', () => {
    expect(code('a /* unterminated')).toBe('a ')
    expect(code('a <!-- unterminated')).toBe('a ')
  })
})

describe('one expression per quantity', () => {
  it('defines chargeable §B and its unhomed slice exactly once, in one place', () => {
    /*
     * `unhomedByMonthSql` is the single definition of both. The previous round
     * unified "unhomed" and stopped one line short of "chargeable", leaving
     * ab-decomposition.ts with its own SUM over v_finance_chargeback_month and
     * its own hardcoded lane exclusion — two expressions for the same §B
     * quantity, rendered on the same card, one keyed on a literal and one on the
     * shared constant. They agreed on every fixture, which is why nothing failed.
     */
    const abCode = code(AB)
    // The card's §B reads through the shared expression…
    expect(abCode).toContain('unhomedByMonthSql(startIso, endIso)')
    // …and has no SUM of its own over the month view.
    expect(abCode).not.toContain('FROM v_finance_chargeback_month')
    // …nor its own copy of the never-chargeable lane's name.
    expect(abCode).not.toContain('copilot-unclassified')

    // The one definition keys that exclusion on the shared constant, so the SQL
    // view and this reader cannot drift on which lane is excluded.
    const defStart = PROBE.indexOf('export function unhomedByMonthSql')
    const def = PROBE.slice(defStart, PROBE.indexOf('\n}', defStart))
    expect(def).toContain('AND tool <> ${COPILOT_UNCLASSIFIED_LANE}')
    expect(def).toContain('FROM v_finance_chargeback_month')
  })

  it('computes the split and its drill in ONE statement', () => {
    /*
     * The drill used to run in three further statements. Under READ COMMITTED
     * each takes its own snapshot, so a placement between them could move money
     * out of a bucket after the bucket total was read — `shownUsd` then exceeds
     * `bucketUsd` on screen while the residual, computed in the first statement,
     * still reads zero. Nothing in a quiescent test database can reproduce that,
     * so the property is pinned here instead: one execute, one snapshot.
     */
    const fn = PROBE.slice(
      PROBE.indexOf('export async function computeUnhomedCauses'),
      PROBE.indexOf('async function loadPlacementConfig'),
    )
    expect(fn).not.toBe('')
    // Exactly one query in the whole function — the drill and the trend's money
    // are scalar sub-selects inside it, not follow-up statements.
    expect([...fn.matchAll(/db\.execute</g)]).toHaveLength(1)
    // …and the follow-up reads that DO remain read no money: they are the
    // placement counters, the estate's first month and the finance periods.
    expect(fn).toContain('loadPlacementConfig(db)')
    expect(fn).toContain('loadEstateFirstMonth(db)')
    expect(fn).toContain('buildHistory(')

    // The drill really is inside that statement rather than beside it.
    for (const cte of ['people_ranked AS', 'unit_ranked AS', 'org_ranked AS', 'history AS']) {
      expect(fn, `drill CTE missing from the split statement: ${cte}`).toContain(cte)
    }
  })
})

describe('holding-node sentinels', () => {
  /*
   * The module's header promises that renaming a sentinel is a COMPILE-TIME
   * rename across every writer and reader. It promised that once before while
   * six readers were still on inline literals and its own list named only four
   * of them — a false guarantee, which is worse than none because the next
   * person trusts it. This is the guarantee, enforced.
   *
   * ENFORCED OVER A DISCOVERED FILE SET, because the previous version of this
   * suite iterated a HARDCODED list of nine readers — so the only regression it
   * exists to catch, a NEW file written on the literals, was invisible to it.
   * (Proven: a tenth file carrying both sentinels kept the suite green.) The
   * walk covers the whole first-party tree the sentinels can be typed into.
   */
  const ROOTS = ['server', 'shared', 'app', 'drizzle']
  const FILES = sourceFiles(ROOTS)

  /*
   * QUOTE-AGNOSTIC. The previous version matched `'__unassigned__'` and
   * `unit_type = 'holding'` with exactly those quotes and exactly that spacing,
   * so `"__unassigned__"`, a backticked one, or `unit_type='holding'` all slipped
   * through. These match the TOKEN, however it is written.
   */
  const SENTINELS: [string, RegExp][] = [
    ['__unassigned__ (UNASSIGNED_REGION_CODE)', /__unassigned__/],
    ['__UNPLACED__ (UNPLACED_UNIT_CODE)', /__UNPLACED__/],
    ["'holding' (HOLDING_UNIT_TYPE)", /(['"`])holding\1/],
  ]

  it('discovers the whole first-party tree, not a list of files', () => {
    // The walk itself must not be vacuous: if it silently returned nothing (a
    // renamed root, a broken filter), every assertion below would pass over an
    // empty set. Pin that it finds the tree AND reaches each root.
    expect(FILES.length).toBeGreaterThan(200)
    for (const root of ROOTS) {
      expect(FILES.some((f) => f.startsWith(`${root}/`)), `walk reached no file under ${root}/`).toBe(true)
    }
    expect(FILES).toContain(HOLDING_MODULE)
    // …and it sees the file kinds the sentinels can be typed into.
    expect(FILES.some((f) => f.endsWith('.vue'))).toBe(true)
  })

  it('is the only place the sentinel literals appear in executable code', () => {
    // Comments may (and should) spell the sentinels out — a comment reading
    // `UNPLACED_UNIT_CODE` says less than one reading `__UNPLACED__`, and a
    // comment cannot mis-measure anything.
    const offenders: string[] = []
    for (const file of FILES) {
      if (file === HOLDING_MODULE) continue
      const src = code(read(file))
      for (const [name, re] of SENTINELS) {
        if (re.test(src)) offenders.push(`${file} carries ${name} instead of the shared constant`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('lists every file that imports the constants in the guarantee it makes', () => {
    // A list that goes stale is how the false guarantee survived review. The
    // importers are DISCOVERED for the same reason as above: a new reader added
    // without updating the header fails here.
    const importers = FILES.filter(
      (f) => f !== HOLDING_MODULE && /placement\/holding-nodes/.test(code(read(f))),
    )
    expect(importers.length).toBeGreaterThan(0)
    for (const file of importers) {
      expect(HOLDING, `header does not name the reader ${file}`).toContain(file)
    }

    // …and the reverse: a path the header still names but nothing imports any
    // more is the same false guarantee pointing the other way.
    //
    // The class ACCEPTS `[` and `]`. Nuxt names its dynamic routes `[id].vue` /
    // `[regionId]/index.get.ts`, and a path pattern that cannot express those
    // cannot express most of `server/api/` — so a reader added there could be
    // named correctly in the header and still be reported as unnamed, which is
    // the false guarantee this pair of assertions exists to prevent.
    const named = [...HOLDING.matchAll(/(?:server|shared|app|drizzle)\/[\w./\][-]+\.(?:ts|mts|vue)/g)]
      .map((m) => m[0])
      .filter((p) => p !== HOLDING_MODULE)
    expect([...new Set(named)].sort()).toEqual([...importers].sort())
  })
})
