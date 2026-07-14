/*
 * MVP path — full end-to-end journey across all personas, exercising the
 * REAL pages + endpoints + ingestion pipeline (only identity = dev-mode
 * personas and the OTel source = fake-azure-monitor are simulated).
 *
 *   1. Admin creates a project with a $1,000 budget (/projects/new)
 *   2. Admin adds 3 members (lead Priya + Jason + Mei)
 *   3. Admin splits the budget individually — lead $600, others $200 each
 *   4/5. The lead developer's session is attributed (attest → emit spans →
 *        real azure-monitor-read joiner → attribution_record) = $42.00
 *   6. Budget-used is visible to every persona:
 *        - developer (lead): own bucket shows $42.00 of $600.00
 *        - manager: the project appears in the scoped By-project rollup
 *        - finance: the CoU breakdown shows the project + its spend
 *
 * The project's cost-owning unit is "Practice Echo" — the manager
 * persona (Anil) owns that subtree, so the project lands in his scoped
 * rollup. The lead is Priya (a different practice) — a deliberate
 * cross-team contribution, which the model allows.
 */
import { test, expect, type Page } from '@playwright/test'
import { baseUrl } from './helpers'
import { emitSessionForAssignment, resolveTeammateIds } from './journey-emit'

// Reporting cutover: this journey navigates the deleted /rollups and /finance pages mid-path.
// Skipped pending a rewrite against /reporting?scope=… (needs the browser E2E suite, not
// runnable in CI here). Tracked as a cutover follow-up.
test.beforeEach(() => {
  test.skip(true, 'reporting cutover — rewrite this spec against /reporting (see cutover PR)')
})

/*
 * Sign in via the real dev-login API (the same call the /login persona
 * buttons make) rather than the /login page — /login statically imports
 * useOidcAuth, which the OIDC module doesn't register in dev mode, so the
 * page 500s in dev. The journey itself never visits /login. The override
 * cookie set here is shared with page navigations via the browser context.
 */
async function devSignIn(page: Page, persona: 'developer' | 'manager' | 'admin' | 'finance') {
  const res = await page.request.post(`${baseUrl}/api/v1/auth/dev-login`, {
    data: { persona },
    headers: { origin: baseUrl, referer: `${baseUrl}/login` },
  })
  if (!res.ok()) {
    throw new Error(`dev-login(${persona}) failed: ${res.status()} ${await res.text()}`)
  }
}

const LEAD = 'demo-priya.iyer@example.com'
const MEMBER_2 = 'demo-jason.wu@example.com'
const MEMBER_3 = 'demo-mei.tanaka@example.com'

// Unique per run so a retry (or a re-run without reseed) can't 409 on the code.
const CODE = `ACME-${Date.now().toString(36).toUpperCase()}`
const NAME = 'Acme Pilot'
const COU_LABEL = 'Practice Echo'

function currentMonthRange(): { from: string; to: string } {
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) }
}

test('MVP path: create → members → per-dev split → attribute → visible to all personas', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const ids = await resolveTeammateIds([LEAD, MEMBER_2, MEMBER_3])
  const { from, to } = currentMonthRange()

  // ─── Steps 1–3 as ADMIN (create + assign + split) ───────────────────
  await devSignIn(page, 'admin')

  // 1) Create project + baseline budget.
  await page.goto(`${baseUrl}/projects/new`)
  await page.waitForLoadState('networkidle')
  await page.fill('[data-testid="new-project-code"]', CODE)
  await page.fill('[data-testid="new-project-name"]', NAME)
  await page.selectOption('[data-testid="new-project-type"]', 'billable')
  await page.selectOption('[data-testid="new-project-cou"]', { label: COU_LABEL })
  await page.fill('[data-testid="new-project-budget"]', '1000.00')
  await page.fill('[data-testid="new-project-from"]', from)
  await page.fill('[data-testid="new-project-to"]', to)
  await page.click('[data-testid="new-project-submit"]')

  // Lands on the allocation editor for the new baseline pool.
  await page.waitForURL(/\/allocations\/[0-9a-f-]{36}$/)

  // 2) Add the three members.
  for (const email of [LEAD, MEMBER_2, MEMBER_3]) {
    await page.fill('[data-testid="dev-add-search"]', email)
    const addBtn = page.locator(`[data-testid="dev-add-${ids[email]}"]`).first()
    await addBtn.waitFor({ state: 'visible' })
    await addBtn.click()
    // The chip (with remove-${id}) appears once the refresh lands.
    await page.locator(`[data-testid="remove-${ids[email]}"]`).waitFor({ state: 'visible' })
    await page.fill('[data-testid="dev-add-search"]', '')
  }

  // 3) Per-developer split: lead $600, others $200 each.
  await page.click('[data-testid="mode-per-dev-fixed"]')
  await page.locator(`[data-testid="cap-${ids[LEAD]}"]`).waitFor({ state: 'visible' })
  // Demonstrate the even-split helper first, then override individually.
  await page.click('[data-testid="split-evenly"]')
  await page.fill(`[data-testid="cap-${ids[LEAD]}"]`, '600.00')
  await page.fill(`[data-testid="cap-${ids[MEMBER_2]}"]`, '200.00')
  await page.fill(`[data-testid="cap-${ids[MEMBER_3]}"]`, '200.00')
  await page.click('[data-testid="save-split"]')
  await expect(page.locator('[data-testid="split-saved"]')).toBeVisible()

  // ─── Steps 4–5: attribute a real session for the lead developer ──────
  // attest → emit spans into fake-azure-monitor → real read-joiner.
  const emit = await emitSessionForAssignment({ teammateEmail: LEAD, projectCode: CODE })
  expect(emit.attributionRowsWritten).toBeGreaterThan(0)

  // ─── Step 6: budget-used visible to every persona ───────────────────

  // Developer (lead): their bucket shows spend against their $600 cap.
  await devSignIn(page, 'developer')
  await page.goto(`${baseUrl}/`)
  await page.waitForLoadState('networkidle')
  const bucket = page.locator(`[data-testid="usage-bucket-${CODE}"]`)
  await expect(bucket).toBeVisible()
  await expect(bucket).toContainText('600.00') // their individual cap
  await expect(bucket).toContainText('42.00') // attributed spend

  // Manager: the project appears in the scoped By-project rollup.
  await devSignIn(page, 'manager')
  await page.goto(`${baseUrl}/rollups`)
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: /By project/ }).click()
  const projectTable = page.locator('[data-testid="project-table"]')
  await expect(projectTable).toBeVisible()
  await expect(projectTable).toContainText(NAME)

  // Finance: the CoU breakdown shows the project + its spend.
  await devSignIn(page, 'finance')
  await page.goto(`${baseUrl}/finance`)
  await page.waitForLoadState('networkidle')
  const couTable = page.locator('[data-testid="cou-table"]')
  await expect(couTable).toContainText(COU_LABEL)
  await page.click('[data-testid="expand-echo"]')
  const breakdown = page.locator('[data-testid="breakdown-echo"]')
  await expect(breakdown).toBeVisible()
  await expect(breakdown).toContainText(NAME)
})
