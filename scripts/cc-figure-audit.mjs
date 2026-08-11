/*
 * cc-figure-audit — are the numbers on the cost-centre page the numbers in the
 * database?
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * Three checks already run against this page and NONE of them reads a value:
 *
 *   prototype-parity.test.ts   a surface is WIRED   (component tree)
 *   cc-parity-smoke.mjs        a surface is VISIBLE (presence + copy)
 *   coverage-walk.mjs          defect CLASSES       — "a clean walk means no
 *                              surface is lying, NOT that every number is right"
 *
 * The engine's arithmetic is covered by integration tests at the QUERY layer, so
 * what was never checked is the span between the query and the pixel: a figure
 * can be computed correctly and rendered against the wrong clamp, the wrong
 * window, or the wrong denominator, and every gate above stays green.
 *
 * So this one reads the rendered page, runs the SAME clamp and window straight
 * at Postgres, and compares. It is the only check here that can fail on a number.
 *
 *   CH=<chromium> DATABASE_URL=<visual db> node scripts/cc-figure-audit.mjs
 */
import { chromium } from 'playwright'
import postgres from 'postgres'
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.env.APP ?? 'http://localhost:3450'
const DB = process.env.DATABASE_URL ?? 'postgresql://tokenscope:tokenscope@postgres:5432/tokenscope_visual'
const OUT = 'tmp/cc-figure-audit'
/** Cent tolerance: the page rounds to 2dp, the query does not. */
const EPS = 0.011

const num = (s) => (s == null ? null : Number(String(s).replace(/[$,]/g, '')))

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.waitFor({ state: 'visible', timeout: 60000 })
  await btn.click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sql = postgres(DB)
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const findings = []
  const checked = []
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 2800 } })
  const page = await ctx.newPage()

  /*
   * Record a comparison so the run reports what it VERIFIED, not only what broke.
   *
   * `kind` is load-bearing and not decoration. A `db` check reads Postgres and
   * can therefore fail on a wrong number; a `self` check compares two figures the
   * PAGE rendered and can only catch the page disagreeing with itself. Proven by
   * mutation: clamping the query to a different centre reddened every `db` check
   * and left the `self` one green. Counting them together would let this script
   * claim eight verifications where it has seven.
   */
  const cmp = (label, rendered, expected, eps = EPS, kind = 'db') => {
    checked.push({ label, rendered, expected, kind })
    if (rendered == null) return findings.push({ rule: 'FIGURE-NOT-FOUND', label })
    if (Math.abs(rendered - expected) > eps) {
      findings.push({ rule: 'FIGURE-MISMATCH', label, rendered, expected, delta: +(rendered - expected).toFixed(6) })
    }
  }

  try {
    await signIn(page, 'CC owner')
    await page.goto(`${APP}/reporting?scope=cost-centre`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(4000)

    // The page resolves which centre it landed on; take it from the URL rather
    // than assuming, or the query below clamps to a different centre than the
    // figures were computed for — which is the exact class of bug this hunts.
    const ccId = new URL(page.url()).searchParams.get('cc')
    if (!ccId) throw new Error('no ?cc= on the landed URL — cannot clamp the query to the rendered centre')

    const text = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ')
    writeFileSync(`${OUT}/page.txt`, text)

    // The window the page states, parsed from its own band, so the SQL below is
    // bounded exactly as the figures were. "August 2026 ... day 6 of 31".
    const mMonth = /([A-Z][a-z]+ \d{4}) \$/.exec(text)
    const monthName = mMonth?.[1]
    if (!monthName) throw new Error('could not read the month band')
    const start = new Date(`${monthName} 1 UTC`)
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    const [from, to] = [start.toISOString(), end.toISOString()]

    // ── §A burn: the headline, the band total and the drill's BURN are one clamp
    const [{ burn }] = await sql`
      SELECT COALESCE(SUM(u.cost_usd), 0)::float8 AS burn
      FROM v_complete_usage u
      WHERE u.cost_owning_unit_id = ${ccId}::uuid
        AND u.ts_event >= ${from}::timestamptz AND u.ts_event < ${to}::timestamptz`
    cmp('band total (§A burn)', num(/([A-Z][a-z]+ \d{4}) (\$[\d,.]+)/.exec(text)?.[2]), burn)
    cmp('ATTRIBUTED USAGE tile', num(/ATTRIBUTED USAGE (\$[\d,.]+)/.exec(text)?.[1]), burn)
    cmp('BURN (drill)', num(/BURN (\$[\d,.]+)/.exec(text)?.[1]), burn)

    // ── Active people: teammates whose Σ cost_usd over this scope is POSITIVE.
    //    NOT "carried a row" — the engine's own definition (kpis.ts).
    const [{ people }] = await sql`
      SELECT COUNT(*)::int AS people FROM (
        SELECT u.teammate_id FROM v_complete_usage u
        WHERE u.cost_owning_unit_id = ${ccId}::uuid
          AND u.ts_event >= ${from}::timestamptz AND u.ts_event < ${to}::timestamptz
        GROUP BY u.teammate_id HAVING SUM(u.cost_usd) > 0) t`
    cmp('ACTIVE PEOPLE tile', num(/ACTIVE PEOPLE (\d+)/.exec(text)?.[1]), people, 0)

    // ── Budget coverage: the four segments PARTITION the headline. They are
    //    filter aggregates over the one scan that produced it, so they foot
    //    exactly — a fudge segment would be the defect.
    //
    //    Read from the DOM, NOT from innerText. This matched on the segment
    //    LABELS ("on a budget", "not on a project", …) and one of them is also
    //    ordinary English: the over-soft-cap note says "Over the cap, spend
    //    should be on a budget $143…", so on a centre that renders that note the
    //    match count came back 5 and the only check here that proves the four
    //    parts PARTITION the headline silently downgraded itself to NOT-FOUND.
    //    A loose gate does not fail — it stops looking, which is worse.
    //    `BudgetCoverageNote.vue` stamps `data-usd` on each of its four
    //    segments and never drops a zero one, so the DOM answers exactly.
    const segs = await page.$$eval('[data-testid^="budget-coverage-seg-"]', (els) =>
      els.map((e) => Number(e.getAttribute('data-usd'))),
    )
    if (segs.length === 4) cmp('budget-coverage segments Σ', segs.reduce((a, b) => a + b, 0), burn)
    else findings.push({ rule: 'FIGURE-NOT-FOUND', label: `budget-coverage segments (found ${segs.length}/4)` })

    // ── The People hero foots to the cost-centre burn (Reporting.md rule 11).
    //
    //    Off the DOM, because this was keyed to the footer's PROSE — "reconciles
    //    to headline (\$x) / (\$y)" — and the prose changed the same day the
    //    footer stopped borrowing the word "headline". The check did not fail;
    //    it stopped matching, the run reported one fewer verification, and only
    //    the count moved. Copy is not a selector.
    const cells = await page.$$eval(
      '[data-testid="cc-hero-people"] [data-testid="drivers-sumback"] td',
      (tds) => tds.map((td) => td.textContent.trim()),
    )
    // SELF-CONSISTENCY, not verification: both operands come off the page. It
    // catches the hero contradicting its own footer and nothing more.
    // The last cell renders as "/ $302.82" — the slash is part of the label.
    if (cells.length >= 3) cmp('People hero Σ == its base', num(cells.at(-2)), num(cells.at(-1).replace('/', '')), EPS, 'self')
    else findings.push({ rule: 'FIGURE-NOT-FOUND', label: `People hero sum-back (${cells.length} cells)` })

    // ── The rolling band is a DIFFERENT window and must not equal the month —
    //    the two frames are the thing the band's own note keeps apart.
    const mBand = /(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2}) rolling/.exec(text)
    if (mBand) {
      const [{ rolling }] = await sql`
        SELECT COALESCE(SUM(u.cost_usd), 0)::float8 AS rolling
        FROM v_complete_usage u
        WHERE u.cost_owning_unit_id = ${ccId}::uuid
          AND u.ts_event >= ${mBand[1]}::date AND u.ts_event < (${mBand[2]}::date + 1)`
      const peak = num(/Peak day: [\d-]+ · (\$[\d,.]+)/.exec(text)?.[1])
      const [{ maxday }] = await sql`
        SELECT COALESCE(MAX(d), 0)::float8 AS maxday FROM (
          SELECT SUM(u.cost_usd) AS d FROM v_complete_usage u
          WHERE u.cost_owning_unit_id = ${ccId}::uuid
            AND u.ts_event >= ${mBand[1]}::date AND u.ts_event < (${mBand[2]}::date + 1)
          GROUP BY date_trunc('day', u.ts_event)) x`
      if (peak != null) cmp('Spend trend peak day', peak, maxday)
      checked.push({ label: 'rolling-window Σ (context)', rendered: null, expected: rolling })
    }
  } finally {
    await ctx.close()
    await browser.close()
    await sql.end()
  }

  writeFileSync(`${OUT}/report.json`, JSON.stringify({ checked, findings }, null, 2))
  const dbChecks = checked.filter((c) => c.kind === 'db' && c.rendered != null)
  const selfChecks = checked.filter((c) => c.kind === 'self' && c.rendered != null)
  console.log(
    `cc-figure-audit -> ${dbChecks.length} figure(s) verified against the DATABASE, ` +
      `${selfChecks.length} self-consistency, ${findings.length} finding(s)`,
  )
  for (const c of dbChecks) console.log(`    db    ${c.label.padEnd(34)} page=${c.rendered}  db=${Number(c.expected).toFixed(2)}`)
  for (const c of selfChecks) console.log(`    self  ${c.label.padEnd(34)} ${c.rendered} vs ${c.expected}`)
  for (const f of findings) console.log('   !!', JSON.stringify(f))
  process.exit(findings.length ? 1 : 0)
}

await main()
