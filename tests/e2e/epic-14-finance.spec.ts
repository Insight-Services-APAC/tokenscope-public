/*
 * Epic 14 — Finance hi-fi + Login polish end-to-end coverage.
 *
 * Per docs/build/mvp-final-epic.md §Epic 14 testing block:
 *   - finance persona lands → filters to APAC + one CoU → table
 *     updates → expand row → breakdown shows → per-row CSV downloads
 *   - all 4 personas walk-through clean
 */
import { test, expect } from '@playwright/test'

// Reporting cutover: this spec targets the deleted /finance page (FinanceFilterBar, CoU
// table, OTel-coverage note). Skipped pending a rewrite against /reporting?scope=finance
// (needs the browser E2E suite, not runnable in CI here). Tracked as a cutover follow-up.
test.beforeEach(() => {
  test.skip(true, 'reporting cutover — rewrite this spec against /reporting (see cutover PR)')
})

const baseUrl = process.env.BASE_URL || 'http://localhost:3450'

async function signInAsFinance(page) {
  await page.goto(`${baseUrl}/login`)
  await page.waitForLoadState('networkidle')
  const loginResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/auth/dev-login') && r.request().method() === 'POST',
  )
  await page.click('[data-testid="persona-finance"]')
  await loginResp
  await page.waitForURL(`${baseUrl}/finance`)
}

test.describe('Finance per-CoU rollup', () => {
  test('renders the filter bar + 4 KPI tiles + OTel coverage note + CoU table', async ({
    page,
  }) => {
    await signInAsFinance(page)
    await expect(page.locator('[data-testid="finance-filter-bar"]')).toBeVisible()
    await expect(page.locator('[data-testid="finance-kpi-row"] > div')).toHaveCount(4)
    await expect(page.locator('[data-testid="otel-coverage-note"]')).toBeVisible()
    await expect(page.locator('[data-testid="cou-table"]')).toBeVisible()
  })

  test('region filter re-fetches /api/v1/rollups/finance with the new region', async ({
    page,
  }) => {
    await signInAsFinance(page)
    const refetch = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/rollups/finance') &&
        r.url().includes('region=apac') &&
        r.request().method() === 'GET',
    )
    await page.click('[data-testid="finance-region-apac"]')
    const resp = await refetch
    expect(resp.status()).toBe(200)
  })

  test('Custom period option is disabled with the tooltip', async ({ page }) => {
    await signInAsFinance(page)
    const custom = page.locator('[data-testid="finance-period-custom"]')
    await expect(custom).toBeDisabled()
    await expect(custom).toHaveAttribute('title', /Custom date range/)
  })

  test('expand row fires the breakdown fetch and renders the per-project sub-table', async ({
    page,
  }) => {
    await signInAsFinance(page)
    const breakdown = page.waitForResponse(
      (r) =>
        /\/api\/v1\/rollups\/finance\/[0-9a-f-]{36}\/breakdown/.test(r.url()) &&
        r.request().method() === 'GET',
    )
    const expandBtns = page.locator('[data-testid^="expand-"]')
    await expandBtns.first().click()
    const resp = await breakdown
    expect(resp.status()).toBe(200)
    const breakdownPanels = page.locator('[data-testid^="breakdown-"]')
    await expect(breakdownPanels.first()).toBeVisible()
  })

  test('per-row CSV button triggers a download', async ({ page }) => {
    await signInAsFinance(page)
    const csvBtns = page.locator('[data-testid^="csv-"]')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      csvBtns.first().click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^tokenscope-cou-/)
  })

  test('Export CSV / Excel page-level button triggers a download', async ({ page }) => {
    await signInAsFinance(page)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="finance-export"]').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^tokenscope-finance-/)
  })
})

test.describe('Login polish', () => {
  test('right-column sub-copy matches the hi-fi text', async ({ page }) => {
    await page.goto(`${baseUrl}/login`)
    await expect(page.getByText('TokenScope uses your Insight Microsoft account.')).toBeVisible()
  })
})
