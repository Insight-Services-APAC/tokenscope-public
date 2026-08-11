/*
 * marketing-shots — capture the public-site screenshots from the SYNTHETIC
 * visual estate (never production: the public mirror is forward-only and the
 * leak gate scans text, not pixels — a real-data screenshot can never be
 * unpublished).
 *
 * Prereqs — the full estate recipe (every step matters; the demo cards read
 * DERIVED lanes, so data must arrive through the ingestion path, never by
 * direct insert):
 *
 *   createdb tokenscope_visual
 *   export DATABASE_URL=postgresql://…/tokenscope_visual
 *   npx tsx drizzle/migrate.ts && SEED_FORCE=1 npx tsx drizzle/seed.ts
 *   SEED_FORCE=1 npm run db:seed:reporting-fixture
 *   PORT=8099 node tools/fake-azure-monitor/server.js &
 *   NUXT_AZURE_MONITOR_ENDPOINT=http://localhost:8099 npx tsx scripts/coverage-estate.ts
 *   # marketing-estate config (the fixture wipes the seed's allocations):
 *   #  - give CSL-AII current+previous month allocations (~$1600/$1450) so the
 *   #    developer budget card agrees with the recent-spend strip;
 *   #  - add the Manager persona to FX-CPR so the membership-shaped project
 *   #    page renders the 15-person team.
 *   # then serve:
 *   NUXT_SESSION_SECRET=$(openssl rand -base64 48) NUXT_OIDC_AUTH_DEV_MODE=true \
 *     NUXT_ALLOW_PERSONA_OVERRIDE=true PORT=3450 bash scripts/dev.sh
 *
 * Usage: CH=<chromium path> node scripts/marketing-shots.mjs
 * Env:   APP_BASE (default http://localhost:3450), SHOTS_OUT (default
 *        tmp/marketing-shots), CH (chromium executable; arm64-safe).
 *
 * Output: <SHOTS_OUT>/<name>.png at 1600×900 @2x, above-the-fold framing.
 */
import { chromium } from 'playwright'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'

const APP = process.env.APP_BASE ?? 'http://localhost:3450'
const OUT = process.env.SHOTS_OUT ?? 'tmp/marketing-shots'

/*
 * One entry per public-site shot: which persona's view, which page, and which
 * testid must be present before the shutter — a shot of a spinner is worse
 * than no shot. `settleMs` lets charts finish their first paint.
 */
const SHOTS = [
  { name: 'developer-dashboard', persona: 'Developer', path: '/', waitFor: '#__nuxt', settleMs: 2500 },
  { name: 'my-usage', persona: 'Developer', path: '/usage', waitFor: '#__nuxt', settleMs: 2500 },
  // PROJECT_CODE picks the page; default is the estate's most-staffed project
  // so the contribution table shows a real team. The product project page is
  // MEMBERSHIP-shaped (a non-member gets an empty body), so the persona must
  // be a member — the estate setup adds the Manager persona to that project.
  { name: 'project', persona: 'Manager', path: `/projects/${process.env.PROJECT_CODE ?? 'FX-CPR'}`, waitFor: '#__nuxt', settleMs: 3500 },
  { name: 'reports-region', persona: 'Global finance', path: '/reporting', waitFor: '#__nuxt', settleMs: 3500 },
  { name: 'reports-finance', persona: 'Global finance', path: '/reporting?scope=finance', waitFor: '#__nuxt', settleMs: 3500 },
  { name: 'admin', persona: 'Region admin', path: '/admin', waitFor: '#__nuxt', settleMs: 2000 },
]

async function signIn(page, persona) {
  // networkidle + a beat: clicking before Vue hydration attaches the handler
  // is a silent no-op and the page never leaves /login.
  await page.goto(`${APP}/login`, { waitUntil: 'networkidle', timeout: 90000 })
  await page.waitForTimeout(600)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.click({ timeout: 15000 })
  // Dev-login must NAVIGATE AWAY from /login — waiting on networkidle alone
  // let a failed sign-in fall through and the login page get shot as content.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 })
}

const main = async () => {
  // ONLY=name,name re-shoots a subset without disturbing approved siblings.
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null
  const shots = only ? SHOTS.filter((s) => only.has(s.name)) : SHOTS
  mkdirSync(OUT, { recursive: true })
  // Stale shots from a failed run must not masquerade as this run's output —
  // but a subset run only owns its own names.
  for (const f of readdirSync(OUT)) {
    if (!f.endsWith('.png')) continue
    if (!only || only.has(f.replace(/\.png$/, ''))) rmSync(`${OUT}/${f}`)
  }
  const browser = await chromium.launch({
    executablePath: process.env.CH || undefined,
  })
  const failures = []
  for (const shot of shots) {
    let lastErr = null
    // Two attempts: the dev server compiles routes on first hit, and a cold
    // route can starve the first attempt's waits.
    for (let attempt = 1; attempt <= 2; attempt++) {
    const ctx = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 2,
    })
    const page = await ctx.newPage()
    try {
      await signIn(page, shot.persona)
      await page.goto(`${APP}${shot.path}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
      if (shot.clickFirst) {
        await page.waitForSelector(shot.clickFirst, { timeout: 30000 })
        await page.click(shot.clickFirst)
      }
      await page.waitForSelector(shot.waitFor, { timeout: 30000 })
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(shot.settleMs)
      if (new URL(page.url()).pathname.startsWith('/login')) {
        throw new Error('bounced to /login — session not established; refusing to shoot the login page')
      }
      await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: false })
      console.log(`ok  ${shot.name}  (${shot.persona} · ${shot.path})`)
      lastErr = null
    } catch (e) {
      lastErr = e
    } finally {
      await ctx.close()
    }
    if (!lastErr) break
    }
    if (lastErr) {
      failures.push({ name: shot.name, error: String(lastErr).slice(0, 200) })
      console.error(`FAIL ${shot.name}: ${String(lastErr).slice(0, 200)}`)
    }
  }
  await browser.close()
  if (failures.length) process.exit(1)
  console.log(`\n${shots.length} shots in ${OUT}`)
}

main()
