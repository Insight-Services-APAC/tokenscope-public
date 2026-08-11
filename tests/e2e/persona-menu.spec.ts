/*
 * Persona menu + stale-session E2E.
 *
 * Header has a click-to-open menu in the top right (Convergence Epic
 * addition). The menu lets the user switch demo personas without
 * re-visiting /login, plus a Sign out item.
 *
 * Stale-session middleware (server/middleware/validate-session.ts):
 * when the cookie's teammateId no longer resolves to a real teammate
 * row (typically after SEED_RESET), all /api/v1/** requests except
 * dev-login + logout return 401 + clear the cookie. The global auth
 * middleware then redirects to /login on the next navigation.
 *
 * This spec exercises both paths.
 */
import { test, expect } from '@playwright/test'
import { baseUrl, signInAs, switchPersonaViaMenu } from './helpers'

test.describe('Persona menu', () => {
  test('menu opens, lists the 4 header personas + account + sign out', async ({ page }) => {
    await signInAs(page, 'manager')
    await page.click('[data-testid="role-badge"]')
    const menu = page.locator('[data-testid="user-menu"]')
    await expect(menu).toBeVisible()
    // Header DEV_PERSONAS is still the original 4 — the 5th login-grid
    // persona (cc-owner / Owen Cole) is NOT in the header menu today.
    await expect(menu.locator('[data-testid="menu-switch-developer"]')).toBeVisible()
    await expect(menu.locator('[data-testid="menu-switch-manager"]')).toBeVisible()
    await expect(menu.locator('[data-testid="menu-switch-admin"]')).toBeVisible()
    await expect(menu.locator('[data-testid="menu-switch-finance"]')).toBeVisible()
    await expect(menu.locator('[data-testid="menu-account"]')).toBeVisible()
    await expect(menu.locator('[data-testid="menu-sign-out"]')).toBeVisible()
    // Wave-V scoped the "Current" tag to impersonation sessions only
    // (AppHeader: v-if="isImpersonating && …"), so a plain dev-login
    // session shows no Current marker on any item.
    await expect(menu.locator('[data-testid="menu-switch-manager"]')).not.toContainText('Current')
  })

  test('switching persona via the menu navigates to that persona landing', async ({ page }) => {
    await signInAs(page, 'developer')
    await switchPersonaViaMenu(page, 'admin')
    // Admin lands on the Overview launcher (h1 "Overview").
    await expect(page.locator('h1')).toContainText('Overview')
    await switchPersonaViaMenu(page, 'finance')
    await expect(page.locator('h1')).toContainText('Reporting')
  })

  test('sign out clears the session and redirects to /login', async ({ page }) => {
    await signInAs(page, 'developer')
    await page.click('[data-testid="role-badge"]')
    await page.click('[data-testid="menu-sign-out"]')
    // logout() clears the sidecar session then navigates the browser to
    // /auth/entra/logout (OIDC provider logout). In dev mode the OIDC
    // module is disabled, so that route is auth-gated like any other and
    // we land on /login?next=/auth/entra/logout — match the /login PATH,
    // not the exact URL.
    await page.waitForURL(/\/login(\?|$)/)
    // /api/v1/auth/me should now report unauthenticated.
    const me = await page.request.get(`${baseUrl}/api/v1/auth/me`)
    const body = (await me.json()) as { authenticated: boolean }
    expect(body.authenticated).toBe(false)
  })

  test('visiting a protected route after sign-out redirects to /login?next=…', async ({ page }) => {
    await signInAs(page, 'developer')
    await page.click('[data-testid="role-badge"]')
    await page.click('[data-testid="menu-sign-out"]')
    await page.waitForURL(/\/login(\?|$)/)
    await page.goto(`${baseUrl}/inbox`)
    await page.waitForURL(/\/login\?next=/)
    expect(page.url()).toContain('next=')
  })

  test('Escape closes the menu', async ({ page }) => {
    await signInAs(page, 'manager')
    await page.click('[data-testid="role-badge"]')
    await expect(page.locator('[data-testid="user-menu"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="user-menu"]')).toHaveCount(0)
  })
})
