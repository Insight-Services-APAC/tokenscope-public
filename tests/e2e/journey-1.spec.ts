/*
 * Playwright E2E — Journey 1 happy path (per docs/build/mvp-lite-epic.md §Epic 8 EVS).
 *
 * Sign in as each demo persona → land on the role's landing page and
 * assert the chrome is role-correct (nav set per NAV_BY_ROLE in
 * AppHeader.vue; Inbox lives in the bell, not the nav). Covers the five
 * login-grid personas incl. cc-owner (org-journey sprint).
 *
 * The real Claude-emits-OTel → reader-joins → attribution_record loop is
 * exercised by the integration test in tests/integration/azure/joiner.test.ts
 * (Epic 6); Playwright covers the human-facing slice.
 *
 * Requires:
 *   - DB up + migrated + seeded (`bash scripts/dev-stack.sh up && npm run
 *     db:migrate && SEED_RESET=true npm run db:seed`).
 *   - Nuxt dev on http://localhost:3450 (`npm run dev`).
 *   Both surfaced as test:e2e:setup in package.json.
 */
import { test, expect } from '@playwright/test'

// Reporting cutover: this spec asserts the now-deleted legacy pages (Team / Finance / CC)
// and their old persona landings/nav. Skipped pending a rewrite against /reporting?scope=…
// (needs the browser E2E suite, not runnable in CI here). Tracked as a cutover follow-up.
test.beforeEach(() => {
  test.skip(true, 'reporting cutover — rewrite this spec against /reporting (see cutover PR)')
})

const baseUrl = process.env.BASE_URL || 'http://localhost:3450'

/*
 * Nav sets mirror NAV_BY_ROLE in app/components/nav/AppHeader.vue
 * (consumption sprint): Inbox moved out of the nav into the bell;
 * every role gets "Home" first; Reporting replaced Rollups /
 * CoU rollup as the label.
 */
const PERSONAS = [
  {
    key: 'developer',
    expectedNav: ['Home', 'My projects', 'My usage'],
    expectedLanding: '/',
    // Epic 11 (MVP-Final) — page-head greeting per design-notes §Screen 2.
    expectedHeading: 'Hello ',
  },
  {
    key: 'manager',
    expectedNav: ['Home', 'Reporting'],
    expectedLanding: '/rollups',
    // Epic 12 (MVP-Final) — practice-scoped header per design-notes §Screen 3.
    expectedHeading: 'Practice Delta rollup',
  },
  {
    key: 'admin',
    expectedNav: ['Home', 'Reporting', 'Admin'],
    expectedLanding: '/admin',
    expectedHeading: 'Admin',
  },
  {
    key: 'finance',
    // global-finops gets the Admin link in nav (cross-region governance).
    expectedNav: ['Home', 'Reporting', 'Admin'],
    expectedLanding: '/finance',
    // Epic 14 (MVP-Final) — header per design-notes §Screen 6.
    expectedHeading: 'Month-end cross-charge',
  },
  {
    key: 'cc-owner',
    // J3 (org-journey sprint): Owen has the developer ROLE; the extra
    // "My cost centres" entry flows from his cou_owner relationship rows
    // (appended after the personal views — no Reporting/Admin to slot before).
    expectedNav: ['Home', 'My projects', 'My usage', 'My cost centres'],
    expectedLanding: '/cost-centres',
    expectedHeading: 'My cost centres',
  },
] as const

for (const persona of PERSONAS) {
  test(`${persona.key} lands on ${persona.expectedLanding} and sees role-correct nav`, async ({
    page,
  }) => {
    await page.goto(`${baseUrl}/login`)
    await page.waitForLoadState('networkidle')

    // Capture the dev-login response so test failures explain themselves
    // rather than just timing out on a stuck /login.
    const loginResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/auth/dev-login') && r.request().method() === 'POST',
    )
    await page.click(`[data-testid="persona-${persona.key}"]`)
    const resp = await loginResp
    expect(resp.status(), `dev-login HTTP ${resp.status()}: ${await resp.text()}`).toBe(200)

    await page.waitForURL(`${baseUrl}${persona.expectedLanding}`)

    await expect(page.locator('h1')).toContainText(persona.expectedHeading)
    // toHaveText retries — important for cc-owner, whose "My cost centres"
    // nav entry only appears after the /api/v1/me/cost-centres fetch lands.
    await expect(page.locator('header nav a')).toHaveText(Array.from(persona.expectedNav))
  })
}

test('inbox bell renders for an authenticated manager', async ({ page }) => {
  // Use Anil (manager). Seed inserts him as recipient of an over-budget
  // item, so the inbox bell *could* carry an unread count; the exact
  // count depends on E2E run ordering. Just assert the bell renders for
  // an authenticated user (the badge span is conditionally rendered, so
  // we don't assert on it).
  await page.goto(`${baseUrl}/login`)
  await page.waitForLoadState('networkidle')
  await page.click('[data-testid="persona-manager"]')
  await page.waitForURL(`${baseUrl}/rollups`)

  await expect(page.locator('[data-testid="inbox-bell"]')).toBeVisible()
})
