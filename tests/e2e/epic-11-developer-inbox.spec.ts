/*
 * Epic 11 — Developer view + Inbox drawer end-to-end coverage.
 *
 * Per docs/build/mvp-final-epic.md §Epic 11 testing block:
 *   - developer lands → time-range toggle changes data → click
 *     Recent-sessions row → CSV export downloads.
 *   - Inbox: filter by category → click row → drawer opens → action
 *     button fires correct PATCH.
 *
 * Both flows run as the seeded developer persona (priya). The seed
 * enrichment in drizzle/seed.ts puts items in all 4 drawer-body
 * categories in priya's inbox so this spec doesn't need to switch
 * personas mid-test.
 */
import { test, expect } from '@playwright/test'

const baseUrl = process.env.BASE_URL || 'http://localhost:3450'

async function signInAsDeveloper(page) {
  await page.goto(`${baseUrl}/login`)
  await page.waitForLoadState('networkidle')
  await page.click('[data-testid="persona-developer"]')
  await page.waitForURL(`${baseUrl}/`)
}

test.describe('Developer view', () => {
  test('renders hero summary + period switch + project buckets + recent sessions + Export CSV button', async ({
    page,
  }) => {
    await signInAsDeveloper(page)

    await expect(page.locator('[data-testid="hero-summary"]')).toBeVisible()
    await expect(page.locator('[data-testid="hero-status"]')).toBeVisible()
    await expect(page.locator('[data-testid="project-bucket-list"]')).toBeVisible()
    await expect(page.locator('[data-testid="untagged-card"]')).toBeVisible()
    // Homepage redesign (consumption sprint): the inbox-preview card was
    // replaced by the Tagged-spend (spill) card; inbox access moved to
    // the bell + the "Alerts →" link on the buckets card.
    await expect(page.locator('[data-testid="spill-card"]')).toBeVisible()
    await expect(page.locator('[data-testid="recent-sessions"]')).toBeVisible()
    await expect(page.locator('[data-testid="export-csv"]')).toBeVisible()
  })

  test('period switcher renders all 4 options; non-MTD are disabled with a coming-soon tooltip', async ({
    page,
  }) => {
    await signInAsDeveloper(page)
    const mtd = page.getByRole('tab', { name: 'MTD' })
    const seven = page.getByRole('tab', { name: 'Last 7 days' })
    await expect(mtd).toBeVisible()
    await expect(mtd).toHaveAttribute('aria-selected', 'true')
    await expect(seven).toBeVisible()
    await expect(seven).toBeDisabled()
    // Tooltip copy was de-jargonised ("Epic 12" → plain "Coming soon").
    await expect(seven).toHaveAttribute('title', /Coming soon/)
  })

  test('Export CSV button triggers a download of the recent-sessions CSV', async ({ page }) => {
    await signInAsDeveloper(page)

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-testid="export-csv"]').click(),
    ])
    expect(download.suggestedFilename()).toMatch(/^tokenscope-recent-sessions-/)
  })
})

test.describe('Inbox drawer', () => {
  /*
   * Over-budget drawer coverage moved to convergence-data-parity.spec.ts
   * after the contributor-first dispatcher routing rule landed — over-
   * budget items now go to the contributor (anil/manager), NOT to all
   * CoU teammates including priya. The drawer flow itself, the Open
   * project link, the Add top-up navigation, and the
   * not-auto-resolved-on-add-top-up assertion are all in that file
   * against the manager persona where the item actually exists.
   */

  test('drawer routes velocity-warning to the velocity body and untagged-backlog to the untagged body', async ({
    page,
  }) => {
    await signInAsDeveloper(page)
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForLoadState('networkidle')

    // Filter to velocity.
    const respVel = page.waitForResponse(
      (r) => r.url().includes('category=velocity-warning') && r.request().method() === 'GET',
    )
    await page.click('[data-testid="filter-category-velocity-warning"]')
    await respVel
    const rowVel = page.locator('[data-testid^="inbox-row-"]').first()
    await rowVel.locator('button').first().click()
    await expect(page.locator('[data-testid="inbox-drawer"]')).toHaveAttribute(
      'data-variant',
      'velocity',
    )
    await page.locator('[data-testid="drawer-close"]').click()
    await expect(page.locator('[data-testid="inbox-drawer"]')).toHaveCount(0)

    // Filter to untagged.
    const respUnt = page.waitForResponse(
      (r) => r.url().includes('category=untagged-backlog') && r.request().method() === 'GET',
    )
    await page.click('[data-testid="filter-category-untagged-backlog"]')
    await respUnt
    const rowUnt = page.locator('[data-testid^="inbox-row-"]').first()
    await rowUnt.locator('button').first().click()
    await expect(page.locator('[data-testid="inbox-drawer"]')).toHaveAttribute(
      'data-variant',
      'untagged',
    )
  })
})
