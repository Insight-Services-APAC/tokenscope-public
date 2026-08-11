// @vitest-environment node
/*
 * THE PRODUCT SAYS "BUDGET". THE REPORTING LAYER SAID "PROJECT".
 *
 * A developer tags a session to a **Budget** (TagSessionDialog), then opens a
 * report and picks a breakdown called **Project** — the same object under two
 * names, in two places one person visits in one sitting. `BUDGET_LABEL`
 * (shared/reports/vocabulary.ts) is the single authority, and this file is what
 * makes "no reporting component hardcodes the axis label" a fact rather than an
 * intention.
 *
 * ── WHY A SOURCE SCAN AND NOT A RENDER ASSERTION ─────────────────────────────
 * A rendered check proves one component says the right word today; it says
 * nothing about the NEXT axis list somebody adds. The failure mode here is
 * additive — a sixth site typing the literal — so the assertion has to be over
 * the whole directory, not over a hand-picked list that inherits the author's
 * blind spot.
 *
 * ── WHAT IS DELIBERATELY NOT ASSERTED ────────────────────────────────────────
 * The axis KEY. `value: 'project'` is the wire, the `?axis=` URL, the CSV export
 * column and every server enum, and it does NOT move — this is a display change.
 * The second test below pins exactly that, so a well-meaning "rename" that
 * changed the key would fail here rather than break saved links silently.
 *
 * Prose naming the project ENTITY (a project's code, a project ending, a PM) is
 * also untouched: this is only ever the word on the AXIS a reader picks.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGET_LABEL, BUDGET_LABEL_PLURAL } from '#shared/reports/vocabulary'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPORTING_DIR = join(ROOT, 'app', 'components', 'reporting')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.vue') || full.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk(REPORTING_DIR)
const read = (p: string) => readFileSync(p, 'utf8')
const rel = (p: string) => relative(ROOT, p)

/** The four axis lists the reporting layer still offers, plus the tag dialog. */
const AXIS_LABEL_SITES = [
  'app/components/reporting/across/TopDriversCard.vue',
  'app/components/reporting/ScopeRegionalView.vue',
  'app/components/reporting/finance/FinanceDrill.vue',
]
const CC_HERO = 'app/components/reporting/cost-centre/CcDrill.vue'
const TAG_DIALOG = 'app/components/home/TagSessionDialog.vue'

describe('no reporting component hardcodes the axis label', () => {
  it('scans the actual reporting component tree (sanity — files are present)', () => {
    // Vacuous-scan guard: an empty or mis-rooted file list would pass every
    // assertion below by scanning nothing.
    expect(files.length).toBeGreaterThan(20)
    expect(files.map(rel)).toContain('app/components/reporting/DriversTable.vue')
  })

  it('no axis option in app/components/reporting/** carries a literal label', () => {
    // The shape that matters: an AxisOption pair with a quoted label. A file may
    // still contain the word "project" in prose — that is the entity, not the axis.
    for (const f of files) {
      const src = read(f)
      const literals = [...src.matchAll(/value:\s*'project',\s*label:\s*(['"])(.+?)\1/g)].map(
        (m) => m[2],
      )
      expect(literals, `${rel(f)} hardcodes the axis label — use BUDGET_LABEL`).toEqual([])
    }
  })

  it.each(AXIS_LABEL_SITES)('%s renders the axis label from the shared constant', (file) => {
    const src = read(join(ROOT, file))
    expect(src, `${file} must import BUDGET_LABEL`).toMatch(
      /import \{[^}]*\bBUDGET_LABEL\b[^}]*\} from '#shared\/reports\/vocabulary'/,
    )
    expect(src, `${file} must USE it as the project axis label`).toMatch(
      /value:\s*'project',\s*label:\s*BUDGET_LABEL/,
    )
  })

  it('the cost-centre hero heads its list with the same constant, pluralised', () => {
    // It has no axis list at all (both heroes render at once), so the label lands
    // as a heading instead — the same authority, a different position.
    const src = read(join(ROOT, CC_HERO))
    expect(src).toMatch(
      /import \{[^}]*\bBUDGET_LABEL_PLURAL\b[^}]*\} from '#shared\/reports\/vocabulary'/,
    )
    expect(src).toContain('{{ BUDGET_LABEL_PLURAL }}')
  })

  it('the tag dialog reads the SAME constant it was already right about', () => {
    // One authority, both sides: the dialog is where the product's word came
    // from, so it consumes the constant rather than keeping a second copy of it.
    const src = read(join(ROOT, TAG_DIALOG))
    expect(src).toMatch(
      /import \{[^}]*\bBUDGET_LABEL\b[^}]*\} from '#shared\/reports\/vocabulary'/,
    )
    expect(src).toContain('{{ BUDGET_LABEL }}')
  })
})

describe('the axis KEY does not move — this is a display change', () => {
  it.each([...AXIS_LABEL_SITES])('%s still keys the axis as `project`', (file) => {
    expect(read(join(ROOT, file))).toMatch(/value:\s*'project'/)
  })

  it('the plural is DERIVED from the singular, so the two can never disagree', () => {
    expect(BUDGET_LABEL_PLURAL).toBe(`${BUDGET_LABEL}s`)
  })
})

/*
 * A moustache inside a STATIC attribute is not interpolated — Vue renders the
 * braces verbatim. The Business Unit rename introduced exactly that on the
 * cost-centre grid's empty state, which would have shipped
 * `No {{ BU_LABEL_LOWER_PLURAL }} in your scope` to a reader. Typecheck, lint
 * and 865 component tests were all green on it, because no test mounted that
 * particular branch.
 *
 * So the class gets a gate rather than the instance getting a fix: any
 * attribute whose value contains `{{` is a binding somebody forgot to prefix.
 */
describe('no moustache inside a static attribute', () => {
  it('every interpolated attribute is bound with : or v-bind', async () => {
    const { readFileSync } = await import('node:fs')
    const { globSync } = await import('node:fs')
    const files = globSync('app/**/*.vue')
    const offenders: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // `foo="… {{ x }} …"` — a plain attribute, not `:foo=` / `v-bind:foo=`.
          if (/(?<![:\w-])\b[a-z][a-z0-9-]*="[^"]*\{\{[^"]*\}\}[^"]*"/.test(line)) {
            offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 90)}`)
          }
        })
    }
    expect(offenders).toEqual([])
  })
})
