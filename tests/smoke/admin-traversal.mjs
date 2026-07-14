// Admin traversal smoke — logs in as the admin persona (Lena Park, seeded) and
// clicks through the restructured admin IA: hub tiles, Regions list + region
// detail (cost-centre tree + create dialog), Projects (edit dialog), Users
// (add-teammate directory picker against the MOCK directory). Asserts the key
// surfaces render and the dialogs open, console-error-free. Run against a dev
// server with NUXT_OIDC_AUTH_DEV_MODE=true + the seed loaded.
import { chromium } from 'playwright-chromium'

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3450'
const errors = []
let step = 'init'
let exitCode = 0

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

const must = async (sel, label) => {
  const el = await page.$(sel)
  if (!el || !(await el.isVisible())) throw new Error(`[${step}] missing/hidden: ${label} (${sel})`)
  return el
}
const count = async (sel) => (await page.$$(sel)).length

try {
  // ── login as the admin persona (Lena Park) ──
  step = 'login'
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' })
  await must('[data-testid="persona-admin"]', 'admin persona button')
  await page.click('[data-testid="persona-admin"]')
  await page.waitForURL((u) => u.toString().includes('/admin'), { timeout: 20000 })
  await page.waitForSelector('[data-testid="admin-hub"]', { timeout: 20000 })

  // ── hub: six tiles ──
  step = 'hub'
  for (const k of ['users', 'regions', 'projects', 'audit', 'settings', 'diagnostics']) {
    await must(`[data-testid="admin-tile-${k}"]`, `tile ${k}`)
  }

  // ── Regions list ──
  step = 'regions'
  await page.click('[data-testid="admin-tile-regions"]')
  await page.waitForURL((u) => u.toString().includes('/admin/regions'), { timeout: 15000 })
  await page.waitForSelector('[data-testid="regions-list"]', { timeout: 15000 })
  await must('[data-testid="regions-list"]', 'regions list')
  if ((await count('[data-testid^="region-manage-"]')) < 1) throw new Error('no regions to manage')
  // admin (not platform-admin) must NOT see the create-region button
  if (await page.$('[data-testid="region-create-open"]')) {
    throw new Error('region-create-open should be hidden for a region admin')
  }

  // ── Region detail: cost-centre tree + create dialog ──
  // A region admin can only open their OWN region (requireRegionScope 403s a
  // foreign one — correct RBAC). The regions list is region-unfiltered, so pick
  // the admin's home region from the session rather than the first row.
  step = 'region-detail'
  const me = await page.evaluate(() => fetch('/api/v1/auth/me').then((r) => r.json()))
  if (!me?.regionId) throw new Error('session has no regionId')
  await page.goto(`${baseUrl}/admin/regions/${me.regionId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('[data-testid="region-detail"]', { timeout: 15000 })
  await page.waitForSelector('[data-testid="panel-cost-centres"]', { timeout: 15000 })
  await must('[data-testid="panel-cost-centres"]', 'cost-centres panel')
  await must('[data-testid="cost-centre-create-open"]', 'create cost-centre button')
  if ((await count('[data-testid^="move-btn-"]')) < 1) throw new Error('no move (reparent) button on any cost centre')
  // open the create dialog, then cancel
  await page.click('[data-testid="cost-centre-create-open"]')
  await must('[data-testid="org-unit-dialog"]', 'org-unit dialog')
  await must('[data-testid="oud-name"]', 'org-unit name field')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="org-unit-dialog"]', { state: 'detached', timeout: 5000 })

  // ── Projects list + edit dialog ──
  step = 'projects'
  await page.goto(`${baseUrl}/admin/projects`, { waitUntil: 'networkidle' })
  await must('[data-testid="admin-projects"]', 'projects page')
  const projEdit = await page.$('[data-testid^="project-edit-"]')
  if (projEdit) {
    await projEdit.click()
    await must('[data-testid="project-edit-dialog"]', 'project edit dialog')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-testid="project-edit-dialog"]', { state: 'detached', timeout: 5000 })
  } else {
    console.warn('admin-traversal: no projects in region — skipped project-edit dialog')
  }

  // ── Users: add-teammate directory picker (mock directory) ──
  step = 'users'
  await page.goto(`${baseUrl}/admin/users`, { waitUntil: 'networkidle' })
  await must('[data-testid="admin-users"]', 'users page')
  await must('[data-testid="user-add-open"]', 'add-teammate button')
  await page.click('[data-testid="user-add-open"]')
  await must('[data-testid="add-teammate-dialog"]', 'add-teammate dialog')
  await must('[data-testid="at-search"]', 'directory search input')
  // type a query that the mock directory matches (e.g. "kumar" → Sasha Kumar)
  await page.fill('[data-testid="at-search"]', 'kumar')
  await page.waitForSelector('[data-testid^="at-result-"]', { timeout: 8000 })
  if ((await count('[data-testid^="at-result-"]')) < 1) throw new Error('no directory results for "kumar"')
  // pick a result → placement controls appear (don't submit — keep smoke idempotent)
  await page.click('[data-testid^="at-result-"]')
  await must('[data-testid="at-orgunit"]', 'placement org-unit select')
  await must('[data-testid="at-role"]', 'placement role select')
  await must('[data-testid="at-submit"]', 'provision submit')
  await page.keyboard.press('Escape')

  // ── Diagnostics: pipeline freshness panel ──
  step = 'diagnostics'
  await page.goto(`${baseUrl}/admin/diagnostics`, { waitUntil: 'networkidle' })
  await must('[data-testid="admin-diagnostics"]', 'diagnostics page')
  await must('[data-testid="admin-diag-pipeline"]', 'pipeline freshness card')
  await must('[data-testid="admin-diag-pipeline-badge"]', 'pipeline status badge')
  await must('[data-testid="admin-diag-last-usage"]', 'last-usage-seen stat')

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  console.warn('admin-traversal: PASS — hub, regions, region detail + cc dialog, projects + edit dialog, users + directory picker, diagnostics pipeline panel, no console errors')
} catch (err) {
  console.error('admin-traversal: FAIL —', err instanceof Error ? err.message : err)
  if (errors.length) console.error('console errors:\n  ' + errors.join('\n  '))
  exitCode = 1
} finally {
  await ctx.close()
  await browser.close()
  process.exit(exitCode)
}
