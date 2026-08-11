/*
 * Admin → Reconciliation → Providers — onboarding surface smoke.
 *
 * Light structural check (not data-parity): the Providers tab replaces the old
 * read-only Anthropic tab with two MANAGED tables (Enterprises + Orgs) and the
 * Add dialogs. We drive the admin to the tab and assert:
 *   - both managed tables render (empty-state or rows)
 *   - the two "+ Add" actions are present
 *   - the Add Org dialog opens with the anthropic Discover affordance, and
 *     switching to github swaps in the enterprise picker
 *   - the Add Enterprise dialog opens
 * Deeper CRUD + the discover happy/sad paths are pinned deterministically in
 * tests/unit/components/provider-onboarding-dialogs.test.ts and the backend
 * integration suite; this is the wired-together smoke.
 */
import { test, expect } from '@playwright/test'
import { baseUrl, signInAs } from './helpers'

test.describe('Admin reconciliation — providers onboarding', () => {
  test('Providers tab renders the two managed tables + Add affordances', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto(`${baseUrl}/admin/reconciliation`)
    await page.waitForLoadState('networkidle')

    await page.click('[data-testid="admin-recon-tab-providers"]')
    await expect(page.locator('[data-testid="admin-recon-providers"]')).toBeVisible()

    // Two managed tables (each renders either rows or an empty-state CTA).
    const enterprises = page.locator('[data-testid="admin-recon-ent-empty"], [data-testid^="admin-recon-ent-"]').first()
    const orgs = page.locator('[data-testid="admin-recon-org-empty"], [data-testid^="admin-recon-org-"]').first()
    await expect(enterprises).toBeVisible()
    await expect(orgs).toBeVisible()

    // Header Add actions.
    await expect(page.locator('[data-testid="admin-recon-add-enterprise"]')).toBeVisible()
    await expect(page.locator('[data-testid="admin-recon-add-org"]')).toBeVisible()

    // Coverage (Workstream D) — structural only, matching this spec's scope: the seed
    // fixture DOES include github provider enterprises with no coverage observation
    // persisted yet, so the banner renders in its "unknown" state. The contract under
    // test is NOT "the banner is hidden" but "no false N-of-M completeness claim is
    // ever printed" — assert the banner shows prose ("no completeness claim possible")
    // and never a bare ratio like "0 of 0" / "0/0". Deeper coverage-state rendering
    // (per-state badges, Recheck, live recompute) is pinned in the backend integration
    // suite (tests/integration/admin/github-coverage-routes.test.ts) against real
    // persisted data; this spec only proves the page wires the banner/columns without
    // erroring and without ever fabricating a denominator.
    const banner = page.locator('[data-testid="admin-recon-coverage-banner"]')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('no completeness claim possible')
    const bannerText = await banner.innerText()
    expect(bannerText).not.toMatch(/\b0\s*(of|\/)\s*0\b/i)
    // The Coverage column cell renders the same "no denominator" contract per-row.
    await expect(page.getByText('coverage unknown').first()).toBeVisible()
  })

  test('Add Org dialog: anthropic Discover affordance, github enterprise picker', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto(`${baseUrl}/admin/reconciliation`)
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="admin-recon-tab-providers"]')

    await page.click('[data-testid="admin-recon-add-org"]')
    await expect(page.locator('[data-testid="provider-org-dialog"]')).toBeVisible()

    // Anthropic (default) shows the Discover button + credential input.
    await expect(page.locator('[data-testid="po-discover"]')).toBeVisible()
    await expect(page.locator('[data-testid="po-cred"]')).toBeVisible()
    // Discover is disabled until a valid credential name is typed.
    await expect(page.locator('[data-testid="po-discover"]')).toBeDisabled()
    await page.fill('[data-testid="po-cred"]', 'smoke-admin-key')
    await expect(page.locator('[data-testid="po-discover"]')).toBeEnabled()

    // Switch to github → discover gone, enterprise picker present.
    await page.selectOption('[data-testid="po-provider"]', 'github')
    await expect(page.locator('[data-testid="po-discover"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="po-enterprise"]')).toBeVisible()
    await expect(page.locator('[data-testid="po-org-id-gh"]')).toBeVisible()

    await page.click('[data-testid="provider-org-cancel"]')
    await expect(page.locator('[data-testid="provider-org-dialog"]')).toHaveCount(0)
  })

  test('Add Enterprise dialog opens with the provider + slug fields', async ({ page }) => {
    await signInAs(page, 'admin')
    await page.goto(`${baseUrl}/admin/reconciliation`)
    await page.waitForLoadState('networkidle')
    await page.click('[data-testid="admin-recon-tab-providers"]')

    await page.click('[data-testid="admin-recon-add-enterprise"]')
    await expect(page.locator('[data-testid="provider-enterprise-dialog"]')).toBeVisible()
    await expect(page.locator('[data-testid="pe-provider"]')).toBeVisible()
    await expect(page.locator('[data-testid="pe-external-id"]')).toBeVisible()

    // A mixed-case github slug is rejected client-side (submit disabled).
    await page.fill('[data-testid="pe-external-id"]', 'Mixed-Case')
    await page.fill('[data-testid="pe-display-name"]', 'Smoke Ent')
    await expect(page.locator('[data-testid="pe-slug-warn"]')).toBeVisible()
    await expect(page.locator('[data-testid="pe-submit"]')).toBeDisabled()

    await page.click('[data-testid="provider-enterprise-cancel"]')
    await expect(page.locator('[data-testid="provider-enterprise-dialog"]')).toHaveCount(0)
  })
})
