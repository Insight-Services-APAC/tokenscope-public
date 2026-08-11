/*
 * Shared E2E helpers. Sign-in flow lives here so individual specs don't
 * each copy a different version of it.
 */
import type { Page } from '@playwright/test'

export const baseUrl = process.env.BASE_URL || 'http://localhost:3450'

export type Persona = 'developer' | 'manager' | 'admin' | 'finance'

// Landings track shared/auth/roles.ts. Reporting cutover: the former Team/Finance
// pages collapsed into the /reporting scopes (the per-spec content assertions below
// still target the old pages — flagged for a follow-up rewrite against /reporting).
const LANDING_BY_PERSONA: Record<Persona, string> = {
  developer: '/',
  manager: '/reporting?scope=region',
  admin: '/admin',
  finance: '/reporting?scope=finance',
}

/*
 * Sign in via the /login persona button. Returns once the persona's
 * landing page is loaded.
 */
export async function signInAs(page: Page, persona: Persona): Promise<void> {
  await page.goto(`${baseUrl}/login`)
  await page.waitForLoadState('networkidle')
  await page.click(`[data-testid="persona-${persona}"]`)
  await page.waitForURL(`${baseUrl}${LANDING_BY_PERSONA[persona]}`)
}

/*
 * Switch persona via the AppHeader user menu. Faster than signing out
 * + back in, and exercises the production path.
 */
export async function switchPersonaViaMenu(page: Page, persona: Persona): Promise<void> {
  await page.click('[data-testid="role-badge"]')
  await page.click(`[data-testid="menu-switch-${persona}"]`)
  await page.waitForURL(`${baseUrl}${LANDING_BY_PERSONA[persona]}`)
}
