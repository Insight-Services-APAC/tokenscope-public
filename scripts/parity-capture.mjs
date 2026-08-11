/*
 * Parity capture: render the built surfaces and the agreed prototypes side by
 * side, at every width and period state the gate covers.
 *
 * WHY THIS EXISTS. The reporting sprint passed 5,600 tests, three external
 * review rounds and a Copilot pass, and still shipped a page that did not match
 * the design the owner signed off. Every one of those gates compared the code
 * against itself. None of them could see the prototype. This is the gate that
 * can.
 *
 * Each prototype (docs/design/<sprint>/prototype.html) carries numbered `fix N`
 * notes that ARE the acceptance criteria. Capture the prototype and the app,
 * then read the images and compare — wording, order, what is shown, visual
 * language. Not pixels, and not colours: the prototype is dark, the product is
 * light. **The prototypes are BINDING on decisions and INDICATIVE on pixels** —
 * a layout delta is not a failure, a missing disclosure is.
 *
 *   node scripts/parity-capture.mjs region
 *   node scripts/parity-capture.mjs region cost-centres finance
 *   node scripts/parity-capture.mjs usage projects project
 *
 * ── WHAT D29 CHANGED, AND WHY ────────────────────────────────────────────────
 * The gate used to shoot ONE width (1600) at ONE moment (whenever it was run,
 * i.e. mid-month in practice). Two of the fix sprint's nine snags were invisible
 * to it for exactly that reason, and the owner found both on Dev:
 *
 *   S3 — the hero row becomes two-up below `xl`. Perfect at 1600.
 *   S4 — every hero spark is replaced by the words "not enough days yet" for the
 *        first six days of every month. Invisible on the 14th.
 *
 * So the matrix is now width × state: {1120, 1600} × {mid, d1}. `d1` is a REAL
 * day 1 — `?clock=` seeds the F1 request clock (`server/utils/clock-pin.ts`), so
 * the server resolves `today`, `settledThrough` and every window from the pinned
 * instant and the page is genuinely on the 1st. The matrix itself lives in
 * `scripts/parity-jobs.mjs` and is unit-tested (T29): a future "simplification"
 * back to one width or one state goes red in the suite instead of on Dev.
 *
 * ── WHY NOT playwright-cli ───────────────────────────────────────────────────
 * `@playwright/cli` ships an x86-64 Chrome and does not run on the aarch64 dev
 * boxes this project is developed on; it also keys sessions by NAME globally per
 * host, so two agents running the gate concurrently drove the SAME browser and
 * one read the other worktree's screenshots as its own (2026-08-03). This driver
 * uses `playwright-chromium` directly: one browser per process, no shared state,
 * and it runs on both architectures.
 *
 * ── THE TEAMMATE ARM NEEDS TWO THINGS, NOT ONE ───────────────────────────────
 *   1. A persona holding a reports grant (`PARITY_PERSONA` — the default,
 *      Global finance, holds one). Without it the page is a 403 card.
 *   2. An `?src=` scope frame (`PARITY_SRC`). A frameless drill DELIBERATELY
 *      renders a no-frame card and never fetches — a bare `teammate_id` is the
 *      thing the scope contract forbids — so settle() would wait out its timeout
 *      on a page that has no money on it by design.
 * It also needs a subject: `PARITY_TEAMMATE` (a seeded teammate uuid) has no
 * sane default, so the arm says so and skips rather than shooting a 400.
 *
 * Requires: dev stack up, `npm run dev` on :3450 with NUXT_OIDC_AUTH_DEV_MODE=true
 * and a migrated database.
 */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { join, resolve, extname, normalize } from 'node:path'
import { chromium } from 'playwright-chromium'
import { buildJobs, DEFAULT_STATES, DEFAULT_WIDTHS } from './parity-jobs.mjs'

const OUT = process.env.PARITY_OUT ?? '/tmp/parity'
const APP = process.env.APP_BASE ?? 'http://localhost:3450'
const PROTO_PORT = Number(process.env.PROTO_PORT ?? 8899)
const PROTO2_PORT = Number(process.env.PROTO2_PORT ?? 8898)
const PERSONA = process.env.PARITY_PERSONA ?? 'Global finance'
const TIMEOUT_S = Number(process.env.PARITY_TIMEOUT ?? 60)

const nums = (v, fallback) =>
  v ? v.split(/[\s,]+/).filter(Boolean).map(Number) : fallback
const words = (v, fallback) => (v ? v.split(/[\s,]+/).filter(Boolean) : fallback)

const scopes = process.argv.slice(2)
const SCOPES = scopes.length ? scopes : ['region', 'cost-centres', 'finance']

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }

/**
 * A read-only static server for one prototype directory — unless something is
 * already serving that port, in which case reuse it. Concurrent runs (and the
 * long-lived `python3 -m http.server` this script used to leave behind) would
 * otherwise crash the whole capture on EADDRINUSE.
 */
async function serveDirIfFree(dir, port) {
  const alive = await fetch(`http://localhost:${port}/prototype.html`, {
    signal: AbortSignal.timeout(2000),
  })
    .then((r) => r.ok)
    .catch(() => false)
  return alive ? null : serveDir(dir, port)
}

/** A read-only static server for one prototype directory. */
function serveDir(dir, port) {
  const root = resolve(dir)
  const server = createServer(async (req, res) => {
    // Contain the path inside `root`: this serves a design directory, not a disk.
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
    const file = join(root, rel === '/' ? 'prototype.html' : rel)
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    try {
      await stat(file)
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      createReadStream(file).pipe(res)
    } catch {
      res.writeHead(404).end()
    }
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

/*
 * Wait until the report has actually RENDERED, not merely navigated.
 *
 * With realistic data volume the region endpoint takes ~15s on its first load.
 * Screenshotting straight after `goto` captures the skeleton, and the gate then
 * compares a loading state against the prototype and reports parity failures
 * that are really just timing. Thin seed data hid this completely.
 *
 * `data-testid="report-skeleton"` (ReportSkeleton.vue) is the honest signal:
 * gone AND some rendered money on the page means the body is real.
 */
async function settle(page) {
  for (let i = 0; i < TIMEOUT_S; i++) {
    const ready = await page
      .evaluate(
        () =>
          !document.querySelector('[data-testid="report-skeleton"]') &&
          /\$[0-9]/.test(document.body.innerText),
      )
      .catch(() => false)
    if (ready) return true
    await page.waitForTimeout(1000)
  }
  return false
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const servers = [
    await serveDirIfFree('docs/design/reporting-consolidation', PROTO_PORT),
    await serveDirIfFree('docs/design/developer-pages-consolidation', PROTO2_PORT),
  ].filter(Boolean)

  const browser = await chromium.launch({ args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
  const page = await context.newPage()

  /*
   * `today` is read ONCE, here, at the process boundary — the same discipline
   * the product itself follows. `buildJobs` takes it as an argument and never
   * asks the clock anything.
   */
  const today = new Date().toISOString().slice(0, 10)

  const jobs = buildJobs({
    scopes: SCOPES,
    today,
    appBase: APP,
    protoBase: `http://localhost:${PROTO_PORT}`,
    proto2Base: `http://localhost:${PROTO2_PORT}`,
    widths: nums(process.env.PARITY_WIDTHS, DEFAULT_WIDTHS),
    states: words(process.env.PARITY_STATES, DEFAULT_STATES),
    projectCode: process.env.PARITY_PROJECT ?? 'tokenscope-public',
    teammateId: process.env.PARITY_TEAMMATE || undefined,
    drillSrc: process.env.PARITY_SRC ?? 'across',
    protoViewer: process.env.PARITY_PROTO_VIEWER || undefined,
    clockMid: process.env.PARITY_CLOCK_MID || undefined,
  })

  /*
   * Dev-mode login exposes persona buttons; pick one that can see whole-company.
   *
   * IT VERIFIES, rather than clicking and hoping. A failed sign-in leaves every
   * subsequent shot as a full-page picture of the login screen — the gate then
   * "runs" and files eight images of nothing, which is worse than not running at
   * all. (Observed 2026-08-05: a weak NUXT_SESSION_SECRET 500'd dev-login and
   * the whole matrix came back as the sign-in page.) Waiting for the persona
   * button rather than probing immediately also matters: after
   * `domcontentloaded` the app has not hydrated, so a `count()` races the render.
   */
  await page.goto(`${APP}/reporting`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const persona = page.locator(`text=Sign in as ${PERSONA}`).first()
  const needsLogin = await persona
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (needsLogin) {
    /*
     * Wait for HYDRATION, not just for the element. `waitFor` resolves as soon
     * as the button is in the DOM — which, server-rendered, it is before Vue has
     * attached any handler. Clicking then does nothing at all: no request, no
     * error, and the whole matrix comes back as the login page.
     */
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(1500)
    await persona.click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 }).catch(() => {})
  }
  if (/\/login/.test(page.url())) {
    console.error(
      `  !! sign-in as "${PERSONA}" did not take — every app shot would be the login page.\n` +
        '     Check the dev server: NUXT_OIDC_AUTH_DEV_MODE=true and a high-entropy\n' +
        '     NUXT_SESSION_SECRET (openssl rand -base64 48).',
    )
    await browser.close()
    for (const s of servers) s.close()
    process.exit(1)
  }

  let failures = 0
  for (const job of jobs) {
    if (job.skipped) {
      console.warn(`  !! ${job.file} skipped — ${job.skipped}`)
      continue
    }
    await page.setViewportSize({ width: job.width, height: 1200 })
    await page.goto(job.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
    if (job.settle) {
      const ok = await settle(page)
      if (!ok) {
        failures++
        console.warn(`  !! ${job.file} still loading after ${TIMEOUT_S}s — may be a skeleton`)
      }
    }
    await page.screenshot({ path: join(OUT, job.file), fullPage: true })
    console.log(`  ${join(OUT, job.file)}`)
  }

  await browser.close()
  for (const s of servers) s.close()
  if (failures) console.warn(`\n${failures} shot(s) may not have settled — read them before trusting.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
