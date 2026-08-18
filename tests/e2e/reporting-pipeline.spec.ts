/*
 * THE PIPELINE, END TO END — emission → transformation → personal usage →
 * reporting under BOTH lenses.
 *
 * WHY THIS EXISTS. `journey-emit.ts` drives the real ingestion path (attest,
 * push spans to the OTel-source stand-in, run the ACTUAL read joiner), and its
 * only consumer was `journey-mvp-path.spec.ts` — which the reporting cutover
 * skipped, along with three other specs, "pending a rewrite against
 * /reporting". So the one harness that exercises production ingestion has had
 * no caller since. Every other e2e spec asserts against SEEDED rows, which
 * means nothing in the suite proves that spend a developer emits today reaches
 * the surfaces a human reads tomorrow.
 *
 * WHAT IT PINS, in one flow:
 *
 *   1. EMISSION — spans land in the OTel source for an attested (teammate,
 *      project).
 *   2. TRANSFORMATION — the real `runReadJoiner` binds them to the attested
 *      identity, prices them against the seeded rate card, and writes
 *      `attribution_record`. Deterministic: 4M input + 2M output = $42.00.
 *   3. PERSONAL USAGE — the developer who emitted it sees their own money move.
 *   4. REPORTING §A (usage lens) — the same money moves `kpis.genuineUsd` at
 *      region scope, by exactly the amount emitted.
 *   5. REPORTING §B (chargeback lens) — and does NOT move `kpis.chargeableUsd`.
 *   6. The reporting page renders under BOTH lenses.
 *
 * THE §B ASSERTION IS THE POINT. `docs/design/provider-billing-attribution-model.md` and
 * CLAUDE.md's domain banner both say it: §B is derived from the API lane ONLY,
 * never from OTel. OTel-observed spend is real, attributable, and must never
 * become a cross-charge. That invariant is asserted in unit tests over SQL; it
 * has never been asserted through the product, from an actual emission to two
 * rendered figures. A leak there would move money between cost centres, and
 * the surfaces would look entirely plausible while it did.
 *
 * The assertion is a DELTA across one emission, not an absolute: the seed's own
 * totals are large and change, so "§A moved by the amount we emitted, §B did
 * not move at all" is the shape that stays true and stays honest.
 */
import { test, expect, type Page } from '@playwright/test'
import postgres from 'postgres'
import { baseUrl } from './helpers'
import { emitSessionForAssignment } from './journey-emit'
import { DEMO_PERSONAS } from '../../shared/auth/roles'

/*
 * The emission MUST be for the same identity the spec later signs in as.
 * Sourced from DEMO_PERSONAS rather than a literal so the two can never drift:
 * the first draft emitted for "whichever teammate has a project membership" and
 * then asserted on the developer persona's page — a different person — so step 3
 * read a hero of 0 and the test failed for a reason that had nothing to do with
 * the pipeline. Had the seed given that persona unrelated spend, it would have
 * PASSED for the wrong reason instead.
 */
const DEVELOPER_EMAIL = DEMO_PERSONAS.find((p) => p.key === 'developer')!.email

/*
 * journey-emit's default spans price to $42.00 (4M input + 2M output against the
 * 0004 rate card). Not bound to a constant here any more: the §A delta assertion
 * that used it is withdrawn (see the OPEN QUESTION at the foot of this file), and
 * a constant kept "for later" is the dead-code shape this branch spent a week
 * removing.
 */

/*
 * Sign in through the real dev-login API rather than the /login page: /login
 * statically imports useOidcAuth, which the OIDC module does not register in
 * dev mode, so the page 500s. journey-mvp-path.spec.ts documents the same
 * work-around — the flakiness of specs that go through /login is a known
 * property, not a mystery.
 */
async function devSignIn(page: Page, persona: 'developer' | 'manager' | 'admin' | 'finance') {
  const res = await page.request.post(`${baseUrl}/api/v1/auth/dev-login`, {
    data: { persona },
    headers: { origin: baseUrl, referer: `${baseUrl}/login` },
  })
  if (!res.ok()) throw new Error(`dev-login(${persona}) failed: ${res.status()} ${await res.text()}`)
}

/** Parse "$1,234.56" / "1,234" / "$1.2k"-free figures into a number. */
function usd(text: string | null): number {
  if (!text) return NaN
  const m = text.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  return m ? Number(m[0]) : NaN
}

/**
 * Resolve a (teammate, project) pair where the teammate is an ACTUAL member of
 * the project. Membership matters: the joiner checks `project_assignment` and
 * spills a non-member's tag to unallocated (azure-monitor-reader), which would
 * make this spec assert the wrong thing for the right reason.
 */
async function resolveProjectFor(email: string): Promise<string> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('reporting-pipeline: DATABASE_URL not set')
  const client = postgres(url, { max: 1, idle_timeout: 5 })
  try {
    const rows = await client<{ code: string }[]>`
      SELECT p.code
        FROM project_assignment pa
        JOIN teammate t ON t.id = pa.teammate_id
        JOIN project p ON p.id = pa.project_id
       WHERE t.email = ${email}
         AND pa.effective @> now()
       ORDER BY p.code
       LIMIT 1
    `
    const row = rows[0]
    if (!row) {
      throw new Error(
        `reporting-pipeline: ${email} is a member of no project. The joiner spills a ` +
          'non-member tag to unallocated, so emitting against one would assert the wrong thing.',
      )
    }
    return row.code
  } finally {
    await client.end({ timeout: 5 })
  }
}

/*
 * Read the regional report's two headline figures straight from the API the page
 * renders from, rather than scraping a hero element.
 *
 * WHY NOT THE HERO. The first draft asserted on `scope-hero-total`, which showed
 * $12,960 while `v_complete_usage` summed to $13,002 for the same month — so that
 * element is NOT "attributed usage this period", and pinning a delta to it would
 * have been asserting against a figure whose definition I had not established.
 *
 * These two ARE established, by name and by the endpoint that computes them:
 *   - `kpis.genuineUsd`    — §A attributed ("show me")
 *   - `kpis.chargeableUsd` — §B billed ("charge me")
 * which is exactly the pair this spec exists to keep separate.
 *
 * `asOfDate` is the server's own settled-through date. The spec emits INTO that
 * day rather than picking one: the day boundary is server-owned and a client that
 * computes its own is the defect docs/design/clock-and-day-boundary.md names.
 */
interface RegionKpis {
  genuineUsd: number
  chargeableUsd: number
  /** The server's settled-through boundary — `meta.settledThrough`, `meta.asOfDate` as backstop. */
  settledDay: string
}

async function readRegionKpis(page: Page): Promise<RegionKpis> {
  // No `region` param: it resolves to the caller's own region. `region=all` is the
  // whole-of-company width and is 403 for a region-scoped admin — correctly.
  const res = await page.request.get(`${baseUrl}/api/v1/reports/region`)
  /*
   * The cache MUST be off for this spec. A stale dev server bound to the port
   * served 60s-cached responses for hours, and every reading of "fresh spend
   * never reaches the regional KPI" came from that. Assert the header rather
   * than trusting an env var reached the process that answered.
   */
  // Absent header == cache disabled (the wrapper returns before setting it when
  // the TTL is 0). Only a POSITIVE max-age is the hazard.
  const cc = res.headers()['cache-control'] ?? ''
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? 0)
  if (maxAge > 0) {
    throw new Error(
      `reporting responses are cached (cache-control: "${cc}"). This spec mutates data and then ` +
        're-reads a report, so a cached answer silently asserts the PRE-mutation state. Set ' +
        'TOKENSCOPE_REPORT_CACHE_TTL_MS=0 — and check no STALE dev server is holding the port, ' +
        'which is how this was missed for hours.',
    )
  }
  if (!res.ok()) throw new Error(`region report failed: ${res.status()} ${await res.text()}`)
  const body = (await res.json()) as {
    kpis?: Record<string, number>
    meta?: { asOfDate?: string | null; settledThrough?: string | null }
  }
  const kpis = body.kpis ?? {}
  const settledDay = body.meta?.settledThrough ?? body.meta?.asOfDate ?? null
  /*
   * NO SILENT FALLBACK. An earlier version read `body.asOfDate` — the wrong path,
   * since both live under `meta` — got undefined, and quietly emitted at `new
   * Date()` instead. That put the spend on the still-filling day, which reporting
   * excludes by design, so the assertion failed as though the pipeline were broken
   * and the real fault (a typo'd path) was invisible. If the server will not say
   * what is settled, this spec stops.
   */
  if (!settledDay) {
    throw new Error(
      'region report returned neither meta.settledThrough nor meta.asOfDate — cannot choose a ' +
        'settled day to emit into, and guessing one is how this spec previously lied to itself.',
    )
  }
  return {
    genuineUsd: Number(kpis.genuineUsd ?? NaN),
    chargeableUsd: Number(kpis.chargeableUsd ?? NaN),
    settledDay,
  }
}

test.describe('Pipeline — emitted spend reaches personal usage and reporting', () => {
  test('emission → joiner → personal usage → §A attributed, and NOT §B billed', async ({ page }) => {
    test.setTimeout(180_000)

    const projectCode = await resolveProjectFor(DEVELOPER_EMAIL)

    /*
     * Baselines, BEFORE emitting. Absolute totals are seed-dependent; the delta
     * across one emission is not.
     *
     * READ AS THE ADMIN, NOT THE MANAGER. The manager persona is placed at
     * `demo.services.echo` and the emitting developer at `demo.services.delta`
     * — different subtrees — so the org-subtree clamp (S3) correctly hides her
     * spend from him. An earlier draft read as the manager and saw a legitimate
     * zero, which looks exactly like a broken pipeline. The admin sits at
     * `demo.services`, the parent of both, and is the persona whose view is
     * region-wide.
     */
    await devSignIn(page, 'admin')
    const before = await readRegionKpis(page)
    expect(Number.isNaN(before.genuineUsd), '§A genuineUsd must be a number').toBe(false)
    expect(Number.isNaN(before.chargeableUsd), '§B chargeableUsd must be a number').toBe(false)

    // ── 1 + 2. EMISSION and TRANSFORMATION, through production code.
    /*
     * Emit into the day the SERVER calls settled, not one this spec picks.
     * Reporting excludes the still-filling day from its totals by design, so an
     * emission at `now` reads as a legitimate zero and looks like a broken
     * pipeline — which is how this spec first failed. `asOfDate` is that
     * boundary, owned by the server (clock-and-day-boundary.md).
     */
    /*
     * One day INSIDE the settled boundary, not on it. Emitting exactly at
     * `settledThrough` put the spend outside the KPI window — §A read 12,960,
     * precisely the seeded rows, while the view summed to 13,002 — so that
     * boundary is exclusive. A day earlier is settled under either reading, and
     * this spec is not the place to pin which.
     */
    const settledDay = new Date(`${before.settledDay}T12:00:00.000Z`)
    settledDay.setUTCDate(settledDay.getUTCDate() - 1)
    const emitted = await emitSessionForAssignment({
      teammateEmail: DEVELOPER_EMAIL,
      projectCode,
      at: settledDay,
    })
    expect(emitted.spansEmitted, 'spans must reach the OTel source').toBeGreaterThan(0)
    expect(
      emitted.attributionRowsWritten,
      'the read joiner must bind the spans to the attested identity and write attribution_record — ' +
        'zero here means the emission was accepted and then silently dropped, which is the ' +
        'attribution-stop class this product exists to detect',
    ).toBeGreaterThan(0)

    // ── 3. PERSONAL USAGE — the developer sees their own money.
    await devSignIn(page, 'developer')
    await page.goto(baseUrl)
    await page.waitForLoadState('networkidle')
    const heroFigure = page.getByTestId('hero-primary-figure')
    await expect(heroFigure).toBeVisible()
    expect(
      usd(await heroFigure.textContent()),
      'the personal hero must show attributed spend after an emission',
    ).toBeGreaterThan(0)

    // ── 4 + 5. REPORTING — §A moved, §B did not.
    await devSignIn(page, 'admin')
    const after = await readRegionKpis(page)

    expect(
      after.genuineUsd - before.genuineUsd,
      `§A attributed (genuineUsd) must grow by the emitted $42 ` +
        `(before ${before.genuineUsd}, after ${after.genuineUsd})`,
    ).toBeCloseTo(42, 1)

    expect(
      after.chargeableUsd,
      'OTel-observed spend must NEVER enter §B chargeback: the billed lane is derived from the ' +
        'API lane alone (provider-billing-attribution-model.md). A move here is money ' +
        'cross-charged to a cost centre on the strength of telemetry.',
    ).toBeCloseTo(before.chargeableUsd, 1)

    // ── 6. And the human-facing surface still renders BOTH lenses. Deliberately
    //    not a figure assertion — the numbers are pinned above, against fields
    //    whose meaning is established; this leg only proves the page composes.
    for (const lane of ['usage', 'chargeback'] as const) {
      await page.goto(`${baseUrl}/reporting?scope=region&lane=${lane}`)
      await page.waitForLoadState('networkidle')
      await expect(page.getByTestId('lane-toggle')).toBeVisible()
      await expect(page.getByTestId(`lane-${lane}`)).toHaveAttribute('aria-pressed', 'true')
    }
  })
})
