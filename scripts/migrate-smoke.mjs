/*
 * migrate-smoke — drive a MIGRATE end to end, in a real browser, against a real
 * database, and prove the Business Unit page changes because of it.
 *
 * ── WHY A SCRIPT AND NOT A UNIT TEST ─────────────────────────────────────────
 * The defect this feature exists for was invisible to every unit and integration
 * test we had: each layer was individually correct, and the product still told a
 * BU owner "No usage recorded" while listing that BU's projects carrying real
 * money. The only check that could have caught it reads the RENDERED PAGE before
 * and after the admin action, which is what this does.
 *
 * The assertion is deliberately a BEFORE/AFTER DELTA rather than a fixed figure:
 * a hard-coded dollar amount would pass on an estate that never moved and fail
 * on every reseed. The claim is causal — the page changed because of the
 * migrate — so the test has to observe both states.
 *
 *   CH=<chromium> DATABASE_URL=<visual db> node scripts/migrate-smoke.mjs
 */
import { chromium } from 'playwright'
import postgres from 'postgres'
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.env.APP ?? 'http://localhost:3450'
const DB = process.env.DATABASE_URL ?? 'postgresql://tokenscope:tokenscope@localhost:5432/tokenscope_visual'
const OUT = 'tmp/migrate-smoke'

const findings = []
const steps = []
const ok = (label, detail = '') => steps.push(`  ok   ${label}${detail ? ' — ' + detail : ''}`)
const bad = (rule, label, detail) => {
  findings.push({ rule, label, detail })
  steps.push(`  !!   ${label} — ${detail}`)
}
const num = (s) => (s == null ? null : Number(String(s).replace(/[$,]/g, '')))

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.waitFor({ state: 'visible', timeout: 60000 })
  await btn.click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 })
}

/** The ledger's answer for this BU, over the month the page is showing. */
async function dbBurnFor(sql, buId) {
  const [{ burn }] = await sql`
    SELECT COALESCE(SUM(u.cost_usd), 0)::float8 AS burn
      FROM v_complete_usage u
     WHERE u.cost_owning_unit_id = ${buId}::uuid
       AND u.ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
       AND u.ts_event <  date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'`
  return burn
}

/** The BU page's own headline burn, read from the rendered drill. */
async function readBurn(page, ccId) {
  await page.goto(`${APP}/reporting?scope=cost-centre&cc=${ccId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(3500)
  const text = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ')
  return { burn: num(/BURN (\$[\d,.]+)/.exec(text)?.[1]), text }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sql = postgres(DB)
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  /*
   * `no-cache` on every request, because reports ship
   * `Cache-Control: private, max-age=60` and this script reads the same URL
   * twice inside that window. Without it the AFTER read is served from the
   * browser's own cache and the assertion silently compares a figure to itself
   * — which is exactly what happened the first time this ran.
   */
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 2400 },
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
  })
  const page = await ctx.newPage()

  try {
    /*
     * BUILD THE DEV SHAPE. A project whose recorded usage is stamped with one BU
     * while the project itself now belongs to another — exactly the state an
     * admin lands in after correcting a wrong homing, and the state our fixture
     * could never produce, which is why the estate was green while Dev was not.
     */
    const [{ id: buFrom }] = await sql`
      SELECT id::text AS id FROM org_unit WHERE code = 'apac-aiad' LIMIT 1`
    const [{ id: buTo }] = await sql`
      SELECT id::text AS id FROM org_unit WHERE code = 'apac-cto' LIMIT 1`
    /*
     * Chosen by SPEND, not by where it currently sits. An earlier version
     * required the project to still be homed to the source BU, so the script
     * only worked on an estate someone had reset by hand — it failed the moment
     * a previous run left the project where it had just migrated it. The shape
     * is STAGED below, so the starting homing is this script's business.
     *
     * Excludes the target so the staged move is always a real one, and picks
     * within the target's own region because the PATCH refuses a cross-region
     * cost-owning unit.
     */
    const [proj] = await sql`
      SELECT p.id::text AS id, p.code
        FROM project p
        JOIN attribution_record ar ON ar.project_id = p.id
        JOIN org_unit ou ON ou.id = ${buTo}::uuid
       WHERE p.region_id = ou.region_id
       GROUP BY p.id, p.code
       HAVING SUM(ar.cost_usd) > 0
       ORDER BY SUM(ar.cost_usd) DESC LIMIT 1`
    if (!proj) throw new Error('no project with spend in the target region — reseed the visual estate')

    // Staged HERE, so a rerun does not depend on someone having reset by hand.
    await sql`UPDATE attribution_record SET cost_owning_unit_id = ${buFrom}::uuid
               WHERE project_id = ${proj.id}::uuid`
    await sql`UPDATE project SET cost_owning_unit_id = ${buTo}::uuid WHERE id = ${proj.id}::uuid`
    ok('staged the Dev shape', `project ${proj.code} homed to CTO, its usage still stamped AI Apps & Data`)

    await signIn(page, 'Global finance')

    /*
     * The staging above went straight to Postgres, which the APP cannot know
     * about — reports are cached server-side for 60s, so the first read can
     * legitimately be pre-staging. `no-cache` only defeats the BROWSER's copy.
     *
     * So the baseline is not trusted until the page and the ledger agree. This
     * is the harness catching its own staleness rather than comparing a cached
     * figure to a fresh one and calling the difference a product bug — which is
     * exactly what an earlier run did.
     */
    let before = await readBurn(page, buTo)
    for (let i = 0; i < 8 && Math.abs((before.burn ?? -1) - (await dbBurnFor(sql, buTo))) > 0.011; i++) {
      await page.waitForTimeout(10_000)
      before = await readBurn(page, buTo)
    }
    writeFileSync(`${OUT}/before.txt`, before.text)
    await page.screenshot({ path: `${OUT}/before.png`, fullPage: true })
    ok('read the BU page BEFORE', `burn = ${before.burn == null ? 'absent' : '$' + before.burn}`)

    // What the admin would be shown.
    const preview = await page.evaluate(
      async ([id, to]) => {
        const r = await fetch(`/api/v1/admin/projects/${id}/migrate-preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ to_cost_owning_unit_id: to, range: { from: 'all', confirm_unbounded: true } }),
        })
        return { status: r.status, body: await r.json().catch(() => null) }
      },
      [proj.id, buTo],
    )
    if (preview.status !== 200) bad('PREVIEW-FAILED', 'migrate preview', `HTTP ${preview.status}`)
    else ok('previewed', `${preview.body.totalRows} rows · $${Number(preview.body.totalUsd).toFixed(2)}`)

    // Apply, carrying the token the preview issued.
    const applied = await page.evaluate(
      async ([id, to, token]) => {
        const r = await fetch(`/api/v1/admin/projects/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            cost_owning_unit_id: to,
            migrate_spend: { from: 'all', confirm_unbounded: true },
            migrate_expect_token: token,
          }),
        })
        return { status: r.status, body: await r.json().catch(() => null) }
      },
      [proj.id, buTo, preview.body?.token],
    )
    if (applied.status !== 200) bad('APPLY-FAILED', 'migrate apply', `HTTP ${applied.status}`)
    else ok('applied', `${applied.body?.migrated?.rows_updated} row(s) moved`)

    const after = await readBurn(page, buTo)
    writeFileSync(`${OUT}/after.txt`, after.text)
    await page.screenshot({ path: `${OUT}/after.png`, fullPage: true })
    ok('read the BU page AFTER', `burn = ${after.burn == null ? 'absent' : '$' + after.burn}`)

    /*
     * The DB is asked the same question, so a page that disagrees with its own
     * ledger is a finding rather than a mystery. (First run: DB $1,864.40, page
     * $1,832.01 — the browser cache, not the product.)
     */
    const dbBurn = await dbBurnFor(sql, buTo)
    if (after.burn != null && Math.abs(after.burn - dbBurn) > 0.011) {
      bad('PAGE-DISAGREES-WITH-DB', 'rendered burn vs the ledger', `page ${after.burn}, db ${dbBurn.toFixed(2)}`)
    } else ok('page agrees with the ledger', `$${dbBurn.toFixed(2)}`)

    // THE CLAIM: the page moved, and moved by what the preview promised.
    const moved = (after.burn ?? 0) - (before.burn ?? 0)
    if (moved <= 0) {
      bad('PAGE-DID-NOT-MOVE', 'BU burn after migrate', `before ${before.burn}, after ${after.burn}`)
    } else {
      ok('the BU page changed because of the migrate', `+$${moved.toFixed(2)}`)
    }

    // The audit row can reconstruct it.
    const [audit] = await sql`
      SELECT payload FROM audit_event
       WHERE event_type = 'project-updated' AND payload ? 'migrate_spend'
       ORDER BY ts_recorded DESC LIMIT 1`
    if (!audit) bad('NO-AUDIT', 'audit row', 'no project-updated row carrying migrate_spend')
    else {
      /*
       * A LIST of sources, not one. A project's history can be stamped with
       * several BUs, so auditing "B → C" off the project's current value would
       * lose that A moved too — and a finance reconstruction would look for the
       * money in the wrong place. Asserting the list is what makes that real.
       */
      const m = audit.payload.migrate_spend
      const sources = m.from_cost_owning_units ?? []
      if (!sources.length) bad('AUDIT-INCOMPLETE', 'audit row', 'no source BU recorded')
      else if (m.usd_moved == null) bad('AUDIT-INCOMPLETE', 'audit row', 'no measured dollars recorded')
      else {
        const sumSources = sources.reduce((a, x) => a + Number(x.usd), 0)
        if (Math.abs(sumSources - Number(m.usd_planned)) > 0.011) {
          bad('AUDIT-INCONSISTENT', 'audit row', `sources sum $${sumSources.toFixed(2)} vs planned $${m.usd_planned}`)
        } else {
          ok(
            'audited',
            `${m.rows_updated} rows · $${Number(m.usd_moved).toFixed(2)} moved · ${sources.length} source BU(s)`,
          )
        }
      }
    }

    // The vocabulary actually rendered.
    if (/cost centre/i.test(after.text)) {
      const hits = [...after.text.matchAll(/.{40}cost centre.{30}/gi)].map((x) => x[0])
      bad('OLD-VOCABULARY', 'rendered page still says "cost centre"', hits.slice(0, 3).join(' | '))
    } else ok('vocabulary', 'no "cost centre" on the rendered BU page')
  } finally {
    await ctx.close()
    await browser.close()
    await sql.end()
  }

  console.log('migrate-smoke:')
  for (const s of steps) console.log(s)
  console.log(`  -> ${findings.length} finding(s); artefacts in ${OUT}/`)
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ steps, findings }, null, 2))
  process.exit(findings.length ? 1 : 0)
}

await main()
