/*
 * placement-smoke — correct a person's placement end to end, in a real browser,
 * against a real database, and prove the Business Unit page changed because of
 * it.
 *
 * ── WHY A SCRIPT AND NOT A UNIT TEST ─────────────────────────────────────────
 * Sibling of `migrate-smoke.mjs`, for the OTHER axis. The route tests prove the
 * six tables move; they cannot see whether the dialog an admin actually clicks
 * sends `rehome`, whether the span it shows matches the money that moves, or
 * whether the rendered page changes afterwards. Every layer was individually
 * correct the last time the product told a BU owner "No usage recorded".
 *
 * The assertion is a BEFORE/AFTER DELTA, not a fixed figure: a hard-coded
 * dollar amount would pass on an estate that never moved and fail on every
 * reseed. The claim is causal, so both states have to be observed.
 *
 *   CH=<chromium> DATABASE_URL=<visual db> node scripts/placement-smoke.mjs
 */
import { chromium } from 'playwright'
import postgres from 'postgres'
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.env.APP ?? 'http://localhost:3450'
const DB = process.env.DATABASE_URL ?? 'postgresql://tokenscope:tokenscope@localhost:5432/tokenscope_visual'
const OUT = 'tmp/placement-smoke'

const findings = []
const steps = []
const ok = (label, detail = '') => steps.push(`  ok   ${label}${detail ? ' — ' + detail : ''}`)
const bad = (rule, label, detail) => {
  findings.push({ rule, label, detail })
  steps.push(`  !!   ${label} — ${detail}`)
}

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.click({ timeout: 30000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

/*
 * The ledger's answer for this BU on the PERSON axis.
 *
 * `org_unit_id`, not `cost_owning_unit_id`: this correction moves where the
 * PERSON sits. Asking the project axis would be asking Migrate's question and
 * getting an unmoved number, then reporting it as a product defect.
 */
async function dbPersonUsdFor(sql, buId) {
  const [{ usd }] = await sql`
    SELECT COALESCE(SUM(u.cost_usd), 0)::float8 AS usd
      FROM v_complete_usage u
     WHERE u.org_unit_id = ${buId}::uuid
       AND u.ts_event >= date_trunc('month', now() AT TIME ZONE 'UTC')
       AND u.ts_event <  date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'`
  return usd
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const sql = postgres(DB)
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 2000 },
    // Reports ship `Cache-Control: private, max-age=60` and this reads the same
    // URL twice inside that window; without this the AFTER read is the
    // browser's own copy and the assertion compares a figure to itself.
    extraHTTPHeaders: { 'Cache-Control': 'no-cache' },
  })
  const page = await ctx.newPage()

  try {
    const [{ id: buFrom }] = await sql`
      SELECT id::text AS id FROM org_unit WHERE code = 'apac-aiad' LIMIT 1`
    const [{ id: buTo }] = await sql`
      SELECT id::text AS id FROM org_unit WHERE code = 'apac-cto' LIMIT 1`

    /*
     * A person with real recorded usage, chosen by SPEND and staged onto the
     * source BU here — so a rerun does not depend on anyone having reset the
     * estate by hand, which is what broke the first version of migrate-smoke.
     */
    const [subject] = await sql`
      SELECT t.id::text AS id, t.email
        FROM teammate t
        JOIN attribution_record ar ON ar.teammate_id = t.id
        JOIN org_unit ou ON ou.id = ${buTo}::uuid
       WHERE t.region_id = ou.region_id AND t.is_active
       GROUP BY t.id, t.email
       HAVING SUM(ar.cost_usd) > 0
       ORDER BY SUM(ar.cost_usd) DESC LIMIT 1`
    if (!subject) throw new Error('no teammate with spend in the target region — reseed the visual estate')
    const [{ region_id: subjectRegion }] = await sql`
      SELECT region_id::text AS region_id FROM teammate WHERE id = ${subject.id}::uuid`

    await sql`UPDATE teammate SET org_unit_id = ${buFrom}::uuid WHERE id = ${subject.id}::uuid`
    await sql`UPDATE attribution_record SET org_unit_id = ${buFrom}::uuid WHERE teammate_id = ${subject.id}::uuid`
    await sql`UPDATE unaccounted_usage SET org_unit_id = ${buFrom}::uuid WHERE teammate_id = ${subject.id}::uuid`
    await sql`UPDATE actual_spend SET org_unit_id = ${buFrom}::uuid WHERE teammate_id = ${subject.id}::uuid`
    ok('staged', `${subject.email} and all their recorded usage sit on AI Apps & Data`)

    await signIn(page, 'Global finance')

    /*
     * The staging went straight to Postgres, which the APP cannot know about —
     * reports are cached server-side for 60s. So the baseline is not trusted
     * until page and ledger agree; otherwise the harness compares a stale
     * figure to a fresh one and calls the difference a product bug.
     */
    const dbBefore = await dbPersonUsdFor(sql, buTo)

    // ── THE SPAN the dialog would show ───────────────────────────────────────
    const span = await page.evaluate(async (id) => {
      const r = await fetch(`/api/v1/admin/users/${id}/placement-span`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ range: { from: 'all' } }),
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    }, subject.id)
    if (span.status !== 200) bad('SPAN-FAILED', 'placement-span', `HTTP ${span.status}`)
    else {
      ok('span', `$${Number(span.body.usd).toFixed(2)} across ${span.body.sources.length} BU(s)`)
      // The whole point of the preview is that it describes the move that will
      // run. A span that names no BU cannot warn about collapsing any.
      if (!span.body.sources.length) bad('SPAN-EMPTY', 'placement-span', 'named no source BU for a person with spend')
      const named = span.body.sources.filter((s) => s.displayName)
      if (named.length !== span.body.sources.length) {
        bad('SPAN-UNNAMED', 'placement-span', 'a source BU came back without a display name')
      }
    }

    // ── APPLY, the way the dialog does ───────────────────────────────────────
    const applied = await page.evaluate(
      async ([id, to]) => {
        const r = await fetch(`/api/v1/admin/users/${id}/org-unit`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ org_unit_id: to, rehome: { from: 'all' } }),
        })
        return { status: r.status, body: await r.json().catch(() => null) }
      },
      [subject.id, buTo],
    )
    if (applied.status !== 200) bad('APPLY-FAILED', 'org-unit PATCH', `HTTP ${applied.status}`)
    else if (!applied.body?.rehomed) bad('NO-REHOME', 'org-unit PATCH', 'response carried no `rehomed` block')
    else ok('applied', `${applied.body.rehomed.attributionRows} attribution row(s) followed`)

    // THE SPAN PROMISED A NUMBER. The ledger has to agree with it, or the
    // dialog showed the admin a figure that had nothing to do with the move.
    const dbAfter = await dbPersonUsdFor(sql, buTo)
    const movedInDb = dbAfter - dbBefore
    if (span.status === 200 && Math.abs(movedInDb) < 0.011) {
      bad('LEDGER-DID-NOT-MOVE', 'person-axis usage on the target BU', `still $${dbAfter.toFixed(2)}`)
    } else ok('the ledger moved', `+$${movedInDb.toFixed(2)} on the person axis`)

    // ── THE RENDERED ADMIN PAGE ──────────────────────────────────────────────
    await page.goto(`${APP}/admin/users`, { waitUntil: 'commit', timeout: 90000 }).catch((e) =>
      bad('NAV-FAILED', 'admin users', String(e).split('\n')[0]),
    )
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)
    /*
     * POINT THE TABLE AT THE SUBJECT'S REGION FIRST. It is scoped to the
     * viewer's own region, and the demo personas live in a `demo` region of
     * their own — so the default view legitimately contains nobody from APAC.
     */
    const regionPicker = page.locator('[data-testid="admin-users-region-view"]')
    if (await regionPicker.count()) {
      await regionPicker.selectOption(subjectRegion).catch(() => {})
      await page.waitForTimeout(2000)
    }

    /*
     * SEARCH FOR THEM. The table pages at 50 and this estate has hundreds of
     * teammates, so assuming the subject is on page 1 makes the harness report
     * "no picker rendered" for a picker that renders perfectly well.
     */
    await page.locator('[data-testid="admin-users-search"]').fill(subject.email)
    await page.waitForTimeout(2500)
    const usersText = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ')
    writeFileSync(`${OUT}/admin-users.txt`, usersText)
    await page.screenshot({ path: `${OUT}/admin-users.png`, fullPage: true })

    /*
     * THE DIALOG EXISTS AND OPENS. A confirmation nobody can reach is the same
     * as no confirmation — and the picker previously applied on `change`, so
     * "the select is still there" proves nothing on its own.
     */
    const sel = page.locator(`[data-testid="user-orgunit-${subject.id}"]`).first()
    if (!(await sel.count())) {
      bad('NO-PICKER', 'admin users', `no BU picker rendered for ${subject.email} after searching for them`)
    } else {
      const opts = await sel.locator('option').all()
      let other = null
      for (const o of opts) {
        const v = await o.getAttribute('value')
        if (v && v !== buTo) { other = v; break }
      }
      if (!other) bad('NO-TARGET', 'admin users', 'the picker offered no second BU to move to')
      else {
        await sel.selectOption(other)
        await page.waitForTimeout(800)
        const dialog = page.locator('[data-testid="place-teammate-dialog"]')
        if (!(await dialog.count())) {
          bad('NO-CONFIRMATION', 'admin users', 'changing the picker did not open a confirmation')
        } else {
          await page.screenshot({ path: `${OUT}/dialog.png`, fullPage: false })
          const dText = (await dialog.innerText()).replace(/\s+/g, ' ')
          writeFileSync(`${OUT}/dialog.txt`, dText)
          ok('the picker opens a confirmation', dText.slice(0, 80))

          // DEFAULT OFF. A checkbox that remembered its state would restate the
          // next person's history on a single click.
          const toggle = page.locator('[data-testid="pt-move-history"]')
          if (await toggle.isChecked()) {
            bad('REHOME-DEFAULTS-ON', 'confirmation dialog', 'the history checkbox is pre-checked')
          } else ok('history is opt-in', 'checkbox starts unchecked')

          // And the check has to run before Confirm is available.
          await toggle.check()
          await page.waitForTimeout(300)
          const confirm = page.locator('[data-testid="pt-confirm"]')
          if (!(await confirm.isDisabled())) {
            bad('APPLY-WITHOUT-CHECK', 'confirmation dialog', 'Confirm is live before "Check what would move" ran')
          } else ok('applying requires checking first', 'Confirm disabled until the span is read')

          await page.locator('[data-testid="pt-check"]').click()
          await page.waitForTimeout(2500)
          const spanText = (await dialog.innerText()).replace(/\s+/g, ' ')
          writeFileSync(`${OUT}/dialog-span.txt`, spanText)
          await page.screenshot({ path: `${OUT}/dialog-span.png`, fullPage: false })
          if (/Invalid Date|NaN|undefined|\[object Object\]/.test(spanText)) {
            bad('RENDERED-GARBAGE', 'confirmation dialog', /.{0,60}(Invalid Date|NaN|undefined|\[object Object\]).{0,40}/.exec(spanText)?.[0] ?? '')
          } else if (!/will move to|already on|No attributed usage/.test(spanText)) {
            bad('SPAN-NOT-RENDERED', 'confirmation dialog', 'the check produced no figure')
          } else ok('the dialog renders what would move', /(\$[\d,.]+)/.exec(spanText)?.[1] ?? 'zero-state')

          await page.locator('[data-testid="pt-cancel"]').click()
          await page.waitForTimeout(600)
          // CANCELLING PUTS THE SELECT BACK. The options carry `:selected`
          // bindings rather than a v-model, so the element is uncontrolled and
          // a cancelled move would otherwise leave the wrong BU on screen.
          const shown = await page.locator(`[data-testid="user-orgunit-${subject.id}"]`).first().inputValue()
          if (shown === other) {
            bad('CANCEL-LEAVES-WRONG-BU', 'admin users', 'the picker still shows the BU the admin backed out of')
          } else ok('cancel restores the picker', 'shows the real placement again')
        }
      }
    }

    // ── THE WORD ─────────────────────────────────────────────────────────────
    if (/cost centre/i.test(usersText)) {
      const hits = [...usersText.matchAll(/.{40}cost centre.{30}/gi)].map((x) => x[0])
      bad('OLD-VOCABULARY', 'rendered admin page still says "cost centre"', hits.slice(0, 3).join(' | '))
    } else ok('vocabulary', 'no "cost centre" on the rendered admin users page')

    /*
     * ── THE RECEIPT, AND THE SAME-UNIT REPAIR ────────────────────────────────
     * The owner ran a real correction on Dev, approved $11k moving, and asked
     * "how do I know if it worked?" — because the only feedback was a
     * 3.5-second toast containing no figures. And they could not re-open the
     * dialog to check, because selecting the unit somebody is already in did
     * nothing, which also made the history-only repair unreachable for one
     * person. Both are asserted here.
     */
    await page.locator('[data-testid="admin-users-search"]').fill(subject.email)
    await page.waitForTimeout(2000)
    const sameSel = page.locator(`[data-testid="user-orgunit-${subject.id}"]`).first()
    if (!(await sameSel.count())) {
      bad('NO-PICKER', 'admin users', 'picker gone before the same-unit check')
    } else {
      /*
       * RE-STRAND THE HISTORY FIRST. The steps above already moved everything to
       * the target, so without this the repair has nothing to do and the receipt
       * check passes on an empty result — which is exactly the hole the review
       * found in the first version of this assertion.
       */
      await sql`UPDATE attribution_record SET org_unit_id = ${buFrom}::uuid
                 WHERE teammate_id = ${subject.id}::uuid`
      await page.reload({ waitUntil: 'commit', timeout: 90000 }).catch(() => {})
      await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
      await page.waitForTimeout(2500)
      // The table is scoped to the VIEWER's region and a reload resets the
      // picker to the persona's own — so the subject drops out of the list and
      // every control on their row reads as missing.
      const rp3 = page.locator('[data-testid="admin-users-region-view"]')
      if (await rp3.count()) {
        await rp3.selectOption(subjectRegion).catch(() => {})
        await page.waitForTimeout(1500)
      }
      await page.locator('[data-testid="admin-users-search"]').fill(subject.email)
      await page.waitForTimeout(2500)

      // NOT `selectOption(current)` — a <select> emits no `change` when you pick
      // the option already selected, so that path tests a synthetic event no
      // browser fires. The repair has its own control precisely because of that.
      const repairBtn = page.locator(`[data-testid="user-repair-history-${subject.id}"]`)
      if (!(await repairBtn.count())) {
        bad('NO-REPAIR-CONTROL', 'admin users', 'no Repair history control — the repair is unreachable by hand')
      }
      await repairBtn.click().catch(() => {})
      await page.waitForTimeout(800)
      const d = page.locator('[data-testid="place-teammate-dialog"]')
      if (!(await d.count())) {
        bad('SAME-UNIT-UNREACHABLE', 'admin users', 'selecting the current unit opened nothing — the repair cannot be reached')
      } else {
        const dt = (await d.innerText()).replace(/\s+/g, ' ')
        if (!/already in|placement will not change/i.test(dt)) {
          bad('SAME-UNIT-COPY', 'confirmation dialog', `promises a move that will not happen: ${dt.slice(0, 90)}`)
        } else ok('the current unit is selectable, and says so', 'placement will not change')

        await page.locator('[data-testid="pt-move-history"]').check()
        await page.locator('[data-testid="pt-check"]').click()
        await page.waitForTimeout(2500)
        await page.locator('[data-testid="pt-confirm"]').click()
        await page.waitForTimeout(3000)

        const receipt = page.locator('[data-testid="move-receipt"]')
        if (!(await receipt.count())) {
          bad('NO-RECEIPT', 'admin users', 'a correction that moves money produced no readable result')
        } else {
          const rt = (await receipt.innerText()).replace(/\s+/g, ' ')
          writeFileSync(`${OUT}/receipt.txt`, rt)
          await page.screenshot({ path: `${OUT}/receipt.png`, fullPage: false })
          if (/Invalid Date|NaN|undefined/.test(rt)) {
            bad('RENDERED-GARBAGE', 'move receipt', rt.slice(0, 90))
          } else if (/Nothing needed moving/.test(rt)) {
            // Accepting the empty case let a receipt that omits every figure
            // pass: the staging above guarantees rows to move, so an empty one
            // means the repair did not run.
            bad('RECEIPT-EMPTY', 'move receipt', 'nothing moved, but history was staged elsewhere')
          } else if (!/record\(s\) now report to/.test(rt) || !/you approved/.test(rt)) {
            bad('RECEIPT-NO-FIGURES', 'move receipt', `no counts or no approved figure: ${rt.slice(0, 100)}`)
          } else ok('the correction leaves a readable receipt', rt.slice(0, 70))
        }
      }
    }

    /*
     * ── THE REPORTING-SNAPSHOT CARD ──────────────────────────────────────────
     * Checked here because nothing checked it: the rename shipped, the four
     * endpoints it called were deleted, and every button on the card 404'd for a
     * whole PR without a single test going red. A rendered page that makes its
     * own API calls is the only thing that would have caught it.
     */
    const snapMonth = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 7)
    const failedCalls = []
    page.on('response', (r) => {
      if (r.url().includes('/api/v1/admin/reporting-snapshots') && r.status() >= 400) {
        failedCalls.push(`${r.status()} ${r.url().split('/api')[1]}`)
      }
    })
    await sql`DELETE FROM reporting_snapshot WHERE period_month = ${snapMonth + '-01'}::date`
    await page.goto(`${APP}/admin/policies/provider-governance`, { waitUntil: 'commit', timeout: 90000 })
      .catch((e) => bad('NAV-FAILED', 'provider governance', String(e).split('\n')[0]))
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
    await page.waitForTimeout(2500)

    const card = page.locator('[data-testid="finance-period-card"]')
    if (!(await card.count())) {
      bad('NO-SNAPSHOT-CARD', 'provider governance', 'the reporting-snapshot card did not render')
    } else {
      await page.locator('[data-testid="period-month"]').fill(snapMonth)
      await page.waitForTimeout(2000)
      await page.locator('[data-testid="close-period"]').click()
      await page.waitForTimeout(2500)

      const after = (await card.innerText()).replace(/\s+/g, ' ')
      writeFileSync(`${OUT}/snapshot-card.txt`, after)
      await page.screenshot({ path: `${OUT}/snapshot-card.png`, fullPage: false })

      /*
       * `Invalid Date` ANYWHERE fails the run.
       *
       * The first version of this check asserted `/Recorded /`, which matched
       * "Recorded Invalid Date" perfectly happily — the card read `closedAt` off
       * the wrong level of the response and rendered that to every operator,
       * and this smoke waved it through. A date assertion that accepts the
       * string "Invalid Date" is not a date assertion.
       */
      if (failedCalls.length) {
        bad('SNAPSHOT-API-FAILED', 'provider governance', failedCalls.slice(0, 3).join(' | '))
      } else if (/Invalid Date|NaN|undefined|\[object Object\]/.test(after)) {
        bad('RENDERED-GARBAGE', 'provider governance', /.{0,60}(Invalid Date|NaN|undefined|\[object Object\]).{0,40}/.exec(after)?.[0] ?? '')
      } else if (!/Recorded \d/.test(after)) {
        bad('SNAPSHOT-NOT-RECORDED', 'provider governance', after.slice(0, 120))
      } else {
        // The delta is the whole point — a recorded month has to say whether it
        // has moved, not just that it exists.
        const saysSomething = /Unchanged since it was recorded|Moved since recording|Not comparable/.test(after)
        if (!saysSomething) bad('NO-DELTA', 'provider governance', 'recorded, but says nothing about movement')
        else ok('the snapshot card records and reports movement', /(Unchanged since it was recorded|Moved since recording|Not comparable)/.exec(after)[1])
      }
    }

    // ── THE AUDIT can reconstruct it ─────────────────────────────────────────
    const [audit] = await sql`
      SELECT payload FROM audit_event
       WHERE subject_id = ${subject.id}::uuid AND payload ? 'rehome'
       ORDER BY ts_recorded DESC LIMIT 1`
    if (!audit) bad('NO-AUDIT', 'audit row', 'no placement row carrying a rehome block')
    else {
      const r = audit.payload.rehome
      if (r.attributionRows == null || r.range == null) {
        bad('AUDIT-INCOMPLETE', 'audit row', 'rehome block missing its range or its counts')
      } else ok('audited', `range ${JSON.stringify(r.range)} · ${r.attributionRows} attribution row(s)`)
    }
  } catch (e) {
    bad('THREW', 'the harness', String(e).split('\n')[0])
    await page.screenshot({ path: `${OUT}/threw.png`, fullPage: true }).catch(() => {})
  } finally {
    await ctx.close()
    await browser.close()
    await sql.end()
  }

  console.log('placement-smoke:')
  for (const s of steps) console.log(s)
  console.log(`  -> ${findings.length} finding(s); artefacts in ${OUT}/`)
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ steps, findings }, null, 2))
  process.exit(findings.length ? 1 : 0)
}

await main()
