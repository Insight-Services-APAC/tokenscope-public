// Smoke — app boots; /login renders; unauthed / redirects to /login.
//
// Per docs/build/mvp-lite-epic.md §Constraints (smoke tier): static,
// assertion-poor. Full chrome rendering moves to Epic 8 Playwright E2E
// where the dev-login + DB are wired into the suite.
//
// The "all 4 personas can reach their landing without console errors"
// check (Epic 11 testing block) lives in the E2E suite at
// tests/e2e/journey-1.spec.ts — smoke stays cheap and DB-free.
import { chromium } from 'playwright-chromium'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3450'

let exitCode = 0
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()

try {
  // /login itself renders without auth.
  const loginResp = await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' })
  if (!loginResp || !loginResp.ok()) {
    throw new Error(`GET /login returned status ${loginResp?.status() ?? 'no response'}`)
  }
  await assertVisible(page, '[data-testid="persona-developer"]', 'developer persona button')
  await assertVisible(page, '[data-testid="persona-manager"]', 'manager persona button')
  await assertVisible(page, '[data-testid="persona-admin"]', 'admin persona button')
  await assertVisible(page, '[data-testid="persona-finance"]', 'finance persona button')

  // Unauthed visit to / lands on /login (global middleware redirect).
  const rootResp = await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  if (!rootResp) throw new Error('GET / returned no response')
  if (!page.url().includes('/login')) {
    throw new Error(`Expected redirect to /login from unauthed /, got ${page.url()}`)
  }

  // /api/v1/auth/me responds {authenticated: false} with no cookie.
  const meResp = await page.request.get(`${baseUrl}/api/v1/auth/me`)
  if (!meResp.ok()) {
    throw new Error(`GET /api/v1/auth/me returned status ${meResp.status()}`)
  }
  const meBody = await meResp.json()
  if (meBody.authenticated !== false) {
    throw new Error(`Expected authenticated:false, got ${JSON.stringify(meBody)}`)
  }

  console.warn('smoke: login + redirect + me OK')
} catch (err) {
  console.error('smoke: FAIL —', err instanceof Error ? err.message : err)
  exitCode = 1
} finally {
  await context.close()
  await browser.close()
  process.exit(exitCode)
}

async function assertVisible(page, selector, label) {
  const el = await page.$(selector)
  if (!el) throw new Error(`Element "${label}" (${selector}) not in DOM`)
  const isVisible = await el.isVisible()
  if (!isVisible) throw new Error(`Element "${label}" (${selector}) not visible`)
}
