/*
 * placement-ux-walk — capture the admin placement flow as a person meets it.
 *
 * ── WHY THIS IS NOT placement-smoke ──────────────────────────────────────────
 * `placement-smoke.mjs` answers "does it work". This answers "can somebody tell
 * what just happened to eleven thousand dollars" — which is a different
 * question, and the one the product failed on Dev. It captures every state of
 * the flow as a screenshot plus its rendered text, so the copy can be read and
 * judged rather than pattern-matched.
 *
 * It asserts nothing except the two things a reviewer cannot see in a still:
 * that no state renders placeholder garbage, and that every interactive control
 * is reachable. Everything else is for human (or model) eyes.
 *
 *   CH=<chromium> DATABASE_URL=<visual db> node scripts/placement-ux-walk.mjs
 */
import { chromium } from 'playwright'
import postgres from 'postgres'
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.env.APP ?? 'http://localhost:3450'
const DB = process.env.DATABASE_URL ?? 'postgresql://tokenscope:tokenscope@localhost:5432/tokenscope_visual'
const OUT = 'tmp/placement-ux'

const notes = []
const problems = []
const shot = async (page, name, text) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  writeFileSync(`${OUT}/${name}.txt`, text)
  notes.push(`  ${name}`)
}
const flag = (what, detail) => problems.push(`  !! ${what} — ${detail}`)

/** Placeholder garbage a person should never be shown. */
const GARBAGE = /Invalid Date|NaN|undefined|null|\[object Object\]|\{\{/

async function readable(page, name, scope) {
  const el = scope ? page.locator(scope) : page.locator('body')
  const text = (await el.innerText()).replace(/\s+/g, ' ').trim()
  if (GARBAGE.test(text)) flag(name, `renders garbage: ${GARBAGE.exec(text)?.[0]}`)
  await shot(page, name, text)
  return text
}

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await page.getByText(`Sign in as ${persona}`, { exact: false }).first().click({ timeout: 30000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sql = postgres(DB)
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
  })
  const page = await ctx.newPage()

  try {
    const [{ id: buFrom }] = await sql`SELECT id::text AS id FROM org_unit WHERE code = 'apac-aiad' LIMIT 1`
    const [{ id: buTo }] = await sql`SELECT id::text AS id FROM org_unit WHERE code = 'apac-cto' LIMIT 1`
    const [subject] = await sql`
      SELECT t.id::text AS id, t.email, t.region_id::text AS region_id
        FROM teammate t JOIN attribution_record ar ON ar.teammate_id = t.id
        JOIN org_unit ou ON ou.id = ${buTo}::uuid
       WHERE t.region_id = ou.region_id AND t.is_active
       GROUP BY t.id, t.email, t.region_id
       HAVING SUM(ar.cost_usd) > 0 ORDER BY SUM(ar.cost_usd) DESC LIMIT 1`

    // The owner's Dev shape: the person sits on the target, their history does not.
    await sql`UPDATE teammate SET org_unit_id = ${buTo}::uuid WHERE id = ${subject.id}::uuid`
    await sql`UPDATE attribution_record SET org_unit_id = ${buFrom}::uuid WHERE teammate_id = ${subject.id}::uuid`

    await signIn(page, 'Global finance')

    // ── 1. The table ─────────────────────────────────────────────────────────
    await page.goto(`${APP}/admin/users`, { waitUntil: 'commit', timeout: 90000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(3000)
    if (page.url().includes('/login')) throw new Error('bounced to /login — sign-in did not stick')
    const rp = page.locator('[data-testid="admin-users-region-view"]')
    if (await rp.count()) {
      await rp.selectOption(subject.region_id).catch(() => {})
      await page.waitForTimeout(1500)
    }
    await page.locator('[data-testid="admin-users-search"]').waitFor({ timeout: 30000 })
    await page.locator('[data-testid="admin-users-search"]').fill(subject.email)
    await page.waitForTimeout(2000)
    await readable(page, '01-users-table')

    // ── 2. Same-unit: is the repair reachable, and does it say so? ───────────
    // Its own control: a <select> emits no `change` for the option already
    // selected, so `selectOption(current)` tests an event no browser fires.
    const repair = page.locator(`[data-testid="user-repair-history-${subject.id}"]`)
    if (!(await repair.count())) flag('same-unit', 'no Repair history control on the row')
    await repair.click().catch(() => {})
    await page.waitForTimeout(900)
    const dlg = '[data-testid="place-teammate-dialog"]'
    if (!(await page.locator(dlg).count())) {
      flag('same-unit', 'selecting the current unit opened nothing — the repair is unreachable')
    } else {
      await readable(page, '02-dialog-same-unit', dlg)
      await page.locator('[data-testid="pt-move-history"]').check()
      await page.waitForTimeout(400)
      await readable(page, '03-dialog-history-ticked', dlg)
      await page.locator('[data-testid="pt-check"]').click()
      await page.waitForTimeout(2500)
      await readable(page, '04-dialog-checked', dlg)
      await page.locator('[data-testid="pt-confirm"]').click()
      await page.waitForTimeout(3000)
      if (!(await page.locator('[data-testid="move-receipt"]').count())) {
        flag('receipt', 'a correction that moved money left nothing to read')
      } else {
        await readable(page, '05-receipt', '[data-testid="move-receipt"]')
      }
    }

    // ── 3. A real move, with a span that spans two BUs ───────────────────────
    await page.locator('[data-testid="move-receipt-close"]').click().catch(() => {})
    /*
     * THREE sources, so the collapse warning is actually reachable: recent on
     * the target, older on buFrom, oldest on a third unit. Staging two and then
     * choosing one of them as the destination leaves a single non-destination
     * source and no warning — which the walk then captured as if it were the
     * warning state.
     */
    const [{ id: buThird }] = await sql`
      SELECT id::text AS id FROM org_unit
       WHERE region_id = ${subject.region_id}::uuid AND is_cost_owning_unit
         AND id NOT IN (${buFrom}::uuid, ${buTo}::uuid) LIMIT 1`
    await sql`UPDATE attribution_record SET org_unit_id = ${buFrom}::uuid
               WHERE teammate_id = ${subject.id}::uuid
                 AND ts_event < (now() - interval '10 days')`
    await sql`UPDATE attribution_record SET org_unit_id = ${buThird}::uuid
               WHERE teammate_id = ${subject.id}::uuid
                 AND ts_event < (now() - interval '30 days')`
    await page.reload({ waitUntil: 'commit' }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)
    const rp2 = page.locator('[data-testid="admin-users-region-view"]')
    if (await rp2.count()) {
      await rp2.selectOption(subject.region_id).catch(() => {})
      await page.waitForTimeout(1500)
    }
    await page.locator('[data-testid="admin-users-search"]').waitFor({ timeout: 30000 })
    await page.locator('[data-testid="admin-users-search"]').fill(subject.email)
    await page.waitForTimeout(2500)
    const sel2 = page.locator(`[data-testid="user-orgunit-${subject.id}"]`).first()
    await sel2.selectOption(buFrom).catch(() => {})
    await page.waitForTimeout(900)
    if (!(await page.locator(dlg).count())) {
      flag('real move', 'selecting a DIFFERENT unit opened no dialog')
    } else {
      await readable(page, '06-dialog-real-move', dlg)
      await page.locator('[data-testid="pt-move-history"]').check()
      await page.locator('[data-testid="pt-check"]').click()
      await page.waitForTimeout(2500)
      await readable(page, '07-dialog-span-warning', dlg)
      // The state this step exists to capture. Silence here means the walk was
      // photographing something else and calling it the warning.
      if (!(await page.locator('[data-testid="pt-span-warning"]').count())) {
        flag('span warning', 'staged three source BUs and no collapse warning rendered')
      }
      await page.locator('[data-testid="pt-cancel"]').click()
      await page.waitForTimeout(600)
    }

    // ── 4. Bulk place, both under and over the history cap ───────────────────
    await page.goto(`${APP}/admin/regions/${subject.region_id}?tab=teammates`, { waitUntil: 'commit', timeout: 90000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)
    await readable(page, '08-region-teammates')
    const boxes = page.locator('tbody input[type="checkbox"]')
    const n = await boxes.count()
    if (!n) {
      flag('bulk', 'no selectable rows on the teammates tab — the bulk path cannot be walked')
    } else {
      for (let i = 0; i < Math.min(3, n); i++) await boxes.nth(i).check().catch(() => {})
      await page.waitForTimeout(600)
      const bulkBtn = page.locator('[data-testid="teammates-bulk-place-open"]')
      if (!(await bulkBtn.count())) {
        flag('bulk', 'selecting rows offered no Place control')
      } else {
        await bulkBtn.click().catch(() => {})
        await page.waitForTimeout(1200)
        if (!(await page.locator('[data-testid="bulk-place-dialog"]').count())) {
          flag('bulk', 'the place button opened no dialog')
        } else {
          const bt = await readable(page, '09-bulk-dialog', '[data-testid="bulk-place-dialog"]')
          // The history option must be OFFERED here — the bulk door is the one
          // that matters when finance finds hundreds mis-placed, and it shipped
          // server-only once already.
          if (!/Also move everything these/.test(bt)) {
            flag('bulk', 'the bulk dialog offers no way to bring recorded usage across')
          }
        }
      }
    }

    // ── 5. The snapshot card ─────────────────────────────────────────────────
    await page.goto(`${APP}/admin/policies/provider-governance`, { waitUntil: 'commit', timeout: 90000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)
    if (await page.locator('[data-testid="finance-period-card"]').count()) {
      await readable(page, '10-snapshot-card', '[data-testid="finance-period-card"]')
    } else flag('snapshot card', 'did not render')
  } catch (e) {
    flag('the walk', String(e).split('\n')[0])
    await page.screenshot({ path: `${OUT}/threw.png`, fullPage: true }).catch(() => {})
  } finally {
    await ctx.close()
    await browser.close()
    await sql.end()
  }

  console.log('placement-ux-walk — states captured:')
  for (const n of notes) console.log(n)
  if (problems.length) {
    console.log('problems:')
    for (const p of problems) console.log(p)
  }
  console.log(`  -> ${problems.length} problem(s); artefacts in ${OUT}/`)
  process.exit(problems.length ? 1 : 0)
}

await main()
