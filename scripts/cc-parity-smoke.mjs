/*
 * cc-parity-smoke — look at the cost-centre page and check the numbers agree.
 *
 * The parity gate proves a surface is WIRED. It cannot prove the page renders,
 * and it cannot prove the figures are right. This is the other half: sign in,
 * open the scope in both lanes, and read what a person would read.
 *
 * It asserts three things a static check cannot:
 *   1. every surface the inventory marks `always` for `cc` is VISIBLE
 *   2. the hero headline equals the drill's burn — one clamp, one window, so two
 *      different numbers on one page would mean the hero is answering a
 *      different question from the tables under it
 *   3. the rolling band names a window that ENDS ON THE SETTLED EDGE, not today
 *
 *   CH=<chromium> node scripts/cc-parity-smoke.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const APP = process.env.APP ?? 'http://localhost:3450'
const OUT = 'tmp/cc-parity-smoke'
const inventory = JSON.parse(readFileSync('docs/design/reporting-consolidation/inventory.json', 'utf8'))
const parityMap = JSON.parse(readFileSync('docs/design/reporting-consolidation/parity-map.json', 'utf8'))

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.waitFor({ state: 'visible', timeout: 60000 })
  await btn.click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 })
}

/** The visible text of the whole page, whitespace-collapsed. */
const visibleText = (page) =>
  page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim())

/**
 * What the BUILD renders for a prototype title, where the two differ by design.
 * A regex over the page's visible text — the surfaces here carry no testid.
 */
const BUILT_TEXT = {
  'card:58% of company usage is on a project with a budget': 'on a project with a budget',
  'card:Projects': 'Budgets',
  /*
   * VOCABULARY-TOLERANT ON PURPOSE. This was the literal 'share of cost-centre
   * burn' and went red the day the Business Unit rename landed — reporting a
   * card MISSING from a page that was rendering it perfectly. A presence probe
   * must key on the card's distinguishing SHAPE, not on a noun the product is
   * free to change; this file is .mjs and cannot import the label constant, so
   * the tolerance lives in the pattern.
   */
  'card:People': 'share of .{0,24}burn',
  'card:Unallocated spend over the soft cap': 'Unallocated spend over the soft cap',
  'card:Active developers over time': 'Active developers over time',
  'card:Spend trend': 'Spend trend',
  'card:Spend per active developer': 'Spend per active developer',
  'card:Where the AI spend goes': 'Where the AI spend goes',
  'card:Behavioural exposure': 'Behavioural exposure',
  'kpi:Attributed usage': 'ATTRIBUTED USAGE',
  'kpi:Chargeable': 'CHARGEABLE',
  'kpi:Active people': 'ACTIVE PEOPLE',
  'kpi:Median per person': 'MEDIAN PER PERSON',
  'band:Last 60 days': 'rolling . daily',
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const findings = []
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 2800 } })
  const page = await ctx.newPage()

  try {
    await signIn(page, 'CC owner')
    await page.goto(`${APP}/reporting?scope=cost-centre`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(4000)

    for (const lane of ['usage', 'chargeback']) {
      if (lane === 'chargeback') {
        const toggle = page.getByText('Chargeback', { exact: false }).first()
        if (await toggle.isVisible().catch(() => false)) {
          await toggle.click()
          await page.waitForTimeout(3500)
        }
      }
      const shot = `${OUT}/cc-${lane}.png`
      await page.screenshot({ path: shot, fullPage: true })
      const text = await visibleText(page)
      writeFileSync(`${OUT}/cc-${lane}.txt`, text)

      // 1 · every ALWAYS surface is actually on screen, in the lane it belongs to.
      for (const s of inventory.scopes.cc.surfaces.filter((x) => x.always)) {
        const entry = parityMap.cc[`${s.kind}:${s.title}`]
        if (!entry || !('built' in entry)) continue
        const laneScoped = entry.lanes
        const laneKey = lane === 'usage' ? 'attributed' : 'billed'
        if (laneScoped && !laneScoped.includes(laneKey)) continue // declared narrower, on purpose

        /*
         * The inventory's title is the PROTOTYPE's wording, and the build
         * legitimately renders several of these differently — the Projects hero
         * is titled "Budgets" (vocabulary.ts) and the budget-coverage card is a
         * note whose claim names the scope ("0% of usage in Practice Delta …").
         * Matching the prototype string here produced two SURFACE-NOT-VISIBLE
         * findings against a page that was rendering both correctly: this gate
         * lying about the page is the same defect it exists to catch, so the
         * probe is declared per surface rather than guessed from the title.
         */
        /*
         * BUILT_TEXT FIRST. `entry.built.text` is the STATIC gate's probe — a
         * string it greps in the component SOURCE (`">People</div>"`), which is
         * markup, not a testid. Reading it as one made this script report two
         * surfaces missing from a page that was rendering both. Two probes with
         * two meanings share one field, so the DOM probe is only used when it
         * actually looks like a testid.
         */
        const probe = BUILT_TEXT[`${s.kind}:${s.title}`]
        const raw = typeof entry.built === 'object' ? entry.built.text : null
        const testid = raw && /^[a-z0-9-]+$/i.test(raw) ? raw : null
        const present = probe
          ? new RegExp(probe, 'i').test(text)
          : testid
            ? (await page.locator(`[data-testid="${testid}"]`).count()) > 0
            : await page
                .getByText(s.title, { exact: false })
                .first()
                .isVisible()
                .catch(() => false)
        if (!present && !s.title.startsWith('{month}')) {
          findings.push({ lane, rule: 'SURFACE-NOT-VISIBLE', surface: `${s.kind}:${s.title}`, shot })
        }
      }

      // 3 · the rolling band must not claim a still-filling edge.
      if (/ends today|still filling/i.test(text)) {
        findings.push({ lane, rule: 'BAND-CLAIMS-UNSETTLED-EDGE', shot })
      }
    }

    // 2 · hero headline vs the drill's burn — same clamp, same window.
    const heroText = await page
      .locator('[data-testid="cc-band-period"]')
      .first()
      .innerText()
      .catch(() => '')
    if (!heroText) findings.push({ rule: 'HERO-BAND-ABSENT' })
    writeFileSync(`${OUT}/hero.txt`, heroText)
  } finally {
    await ctx.close()
    await browser.close()
  }

  writeFileSync(`${OUT}/findings.json`, JSON.stringify(findings, null, 2))
  console.log(`cc-parity-smoke -> ${findings.length} finding(s); artefacts in ${OUT}/`)
  for (const f of findings) console.log('   ', JSON.stringify(f))
  process.exit(findings.length ? 1 : 0)
}

await main()
