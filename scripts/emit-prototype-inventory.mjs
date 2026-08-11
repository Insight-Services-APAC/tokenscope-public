/*
 * emit-prototype-inventory — the machine-readable answer to "what is on this page?"
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The approved prototype is EXECUTABLE JS, not a drawing. `cc(d)` is
 * `across(d,'cc')`, so a page's card list is whatever that 800-line function
 * emits for one scope — part from `if(SK==='cc')` blocks, and part from code
 * that names no scope at all.
 *
 * That asymmetry produced a real, measurable defect. Of the twelve cards the
 * approved prototype puts on the cost-centre page, the THREE inside
 * `if(SK==='cc')` blocks were built and EIGHT of the nine in the unconditional
 * tail were not (the ninth was built and later removed). A build agent told to
 * "match the prototype" reads the blocks that announce themselves and never
 * discovers the rest; a reviewer grepping the build for what they expect can
 * only ever confirm what is already there.
 *
 * So the instruction "match the prototype" had no checkable form. This gives it
 * one: run the prototype, per scope, per lane, and write down what it drew.
 * `tests/unit/reporting/prototype-parity.test.ts` then asserts the build
 * renders each entry.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *   node scripts/emit-prototype-inventory.mjs            # write the inventory
 *   node scripts/emit-prototype-inventory.mjs --check    # fail if it is stale
 *
 * The emitted file is CHECKED IN. `--check` is what CI runs, so a prototype
 * edit that changes a page's card list cannot land without the inventory (and
 * therefore the parity gate) moving with it.
 */
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, existsSync, globSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOTYPE = resolve(ROOT, 'docs/design/reporting-consolidation/prototype.html')
const OUT_JSON = resolve(ROOT, 'docs/design/reporting-consolidation/inventory.json')

/**
 * The scope values are the prototype's OWN select options, read at runtime
 * rather than hardcoded here — a new scope must not be able to appear in the
 * prototype and be silently absent from the inventory.
 */
const LANES = ['attributed', 'billed']

/** Chromium: prefer an explicit path (arm64 hosts need the downloaded build). */
function chromiumPath() {
  if (process.env.CH) return process.env.CH
  const home = process.env.HOME ?? ''
  for (const p of globSync(`${home}/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`)) return p
  return undefined
}

/**
 * Read the drawn page. A "surface" is anything a reader perceives as a distinct
 * block with a heading — card titles, band headings, and the KPI tiles, whose
 * eyebrow IS their heading. Notes are deliberately excluded: they are the
 * prototype's own annotation layer, not product surface.
 */
function readSurfaces() {
  /*
   * Dynamic titles are normalised to a stable token, or a surface whose heading
   * interpolates data would read as CONDITIONAL and drop out of the gate. The
   * month band is the case that matters: its heading IS the month, so "July
   * 2026" and "August 2026" are one surface, not two optional ones.
   */
  const MONTH =
    /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/
  const norm = (t) => (MONTH.test(t) ? '{month} {year}' : t)
  const txt = (el) => norm((el.textContent || '').replace(/\s+/g, ' ').trim())
  const out = []
  for (const el of document.querySelectorAll('#app .band > .bh > .bw')) {
    out.push({ kind: 'band', title: txt(el) })
  }
  for (const el of document.querySelectorAll('#app .card > .h3')) {
    out.push({ kind: 'card', title: txt(el) })
  }
  for (const el of document.querySelectorAll('#app .kpi > .eb')) {
    out.push({ kind: 'kpi', title: txt(el) })
  }
  return out
}

async function emit() {
  if (!existsSync(PROTOTYPE)) throw new Error(`prototype not found: ${PROTOTYPE}`)
  const browser = await chromium.launch({ executablePath: chromiumPath() })
  try {
    const page = await browser.newPage()
    await page.goto(`file://${PROTOTYPE}`)
    await page.waitForSelector('#app .band, #app .card', { timeout: 15_000 })

    const scopes = await page.$$eval('#role option', (os) =>
      os.map((o) => ({ value: o.value, label: (o.textContent || '').replace(/\s+/g, ' ').trim() })),
    )
    if (!scopes.length) throw new Error('no scope options found — the prototype shell changed')

    const inventory = { source: 'docs/design/reporting-consolidation/prototype.html', scopes: {} }

    const states = await page.$$eval('.bar .seg .btn[data-st]', (bs) => bs.map((b) => b.getAttribute('data-st')))
    if (!states.length) throw new Error('no data-state buttons found — the prototype shell changed')

    for (const scope of scopes) {
      /*
       * Cross the scope with every DATA state and every LANE. A single fixture
       * run cannot see a data-conditional card — the prototype gates
       * Concentration on `people>=30`, so a 14-person fixture hides it and a
       * one-shot inventory would silently record it as absent. Crossing the
       * states is what stops the gate inheriting one fixture's blind spot.
       */
      const drawn = new Map() // key -> { kind, title, lanes:Set, states:Set, pairs:Set }
      for (const st of states) {
        await page.click(`.bar .seg .btn[data-st="${st}"]`)
        await page.selectOption('#role', scope.value)
        await page.waitForTimeout(50)
        for (const lane of LANES) {
          // The lane control is a click target in the prototype, not a form field.
          const laneEl = await page.$(`.lens span[data-lane="${lane}"]`)
          if (laneEl) {
            await laneEl.click()
            await page.waitForTimeout(50)
          }
          for (const s of await page.evaluate(readSurfaces)) {
            const key = `${s.kind}:${s.title}`
            if (!drawn.has(key))
              drawn.set(key, { kind: s.kind, title: s.title, lanes: new Set(), states: new Set(), pairs: new Set() })
            drawn.get(key).lanes.add(lane)
            drawn.get(key).states.add(st)
            // The PAIR, not just the two members — see `always` below.
            drawn.get(key).pairs.add(`${st}|${lane}`)
          }
        }
      }
      const surfaces = [...drawn.values()].map((s) => ({
        kind: s.kind,
        title: s.title,
        lanes: LANES.filter((l) => s.lanes.has(l)),
        states: states.filter((k) => s.states.has(k)),
        /*
         * ALWAYS = drawn in every (state, lane) PAIR, so the build must render it
         * unconditionally and the parity gate asserts it. CONDITIONAL = the
         * prototype itself only draws it for some data, so its absence is not
         * evidence of a gap; it is recorded, and reported, but not asserted.
         *
         * The CARTESIAN product, not the two sets independently. A surface drawn
         * only for (mid, attributed) and (d1, billed) fills both member sets and
         * would read as unconditional under `lanes.size === n && states.size === m`
         * — asserting a surface the prototype does not always draw, which is a
         * gate demanding work nobody asked for.
         */
        always: s.pairs.size === states.length * LANES.length,
      }))
      inventory.scopes[scope.value] = { label: scope.label, surfaces }
    }
    return inventory
  } finally {
    await browser.close()
  }
}

const inventory = await emit()
const serialised = JSON.stringify(inventory, null, 2) + '\n'

if (process.argv.includes('--check')) {
  const current = existsSync(OUT_JSON) ? readFileSync(OUT_JSON, 'utf8') : ''
  if (current !== serialised) {
    console.error(
      'prototype inventory is STALE.\n' +
        'The approved prototype draws a different set of surfaces than inventory.json records.\n' +
        'Run: node scripts/emit-prototype-inventory.mjs\n' +
        'Then answer the parity gate for anything newly added or removed.',
    )
    process.exit(1)
  }
  console.log('prototype inventory is current.')
} else {
  writeFileSync(OUT_JSON, serialised)
  const counts = Object.entries(inventory.scopes)
    .map(([k, v]) => `${k}=${v.surfaces.length}`)
    .join(' · ')
  console.log(`wrote ${OUT_JSON}\n  ${counts}`)
}
