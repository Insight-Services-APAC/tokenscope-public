/*
 * coverage-walk — walk every page as every persona and assert defect CLASSES.
 *
 * WHAT IT ACTUALLY ASSERTS, stated precisely because the earlier version of this
 * header did not: every rule below is a regex over the rendered text of a page,
 * plus a nearly-blank check. It catches a surface that LIES (an absent lane
 * reported as absent spend, a $0.00 that means "no data", a vendor split that is
 * 100% "Other"). Those are the defects that reached Dev three releases running,
 * so this is the gate that matters most — but they are CLASSES, not figures.
 *
 * IT DOES NOT COMPARE FIGURES, and the header used to claim it did. (The ESTATE
 * now checks its own: coverage-estate.ts asserts that the joiner wrote what it
 * was handed, per priced persona. That is a different gate at a different layer
 * — it says nothing about what any page renders.)
 * `tmp/coverage-expect.json` is read and passed through into findings.json, and
 * nothing compares it to the screen: a headline rendering $999 where $12.34 was
 * expected passes clean today. The reason is structural, not an oversight —
 * `coverage-estate.ts` keys its expectations to the `@coverage.local` personas
 * it emitted for, while this walk signs in as the UI personas (Developer, CC
 * owner, …). The two sets do not intersect, so there is nothing to compare
 * until the walk can assume a coverage persona's identity.
 *
 * That is the next piece of work on this harness. Until it lands, treat a clean
 * walk as "no surface is lying", NEVER as "every number is right".
 *
 * PROBE ON CONDITIONS, NEVER ON ONE PHRASING. The context-card defect has at
 * least two faces — "No Anthropic spend in this window" and "$25.30 not banded
 * — before collection began". A probe written for the first missed the second
 * twice on 2026-08-06. Every check below matches a CLASS of wording.
 *
 * Usage:  npm run coverage:walk         (dev server on :3450, estate built)
 * Env:    APP_BASE, PARITY_OUT, CH (chromium path; arm64-safe, see
 *         docs/development/coverage-loop.md)
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'

const APP = process.env.APP_BASE ?? 'http://localhost:3450'
const OUT = process.env.PARITY_OUT ?? 'tmp/coverage-walk'
const EXPECT = 'tmp/coverage-expect.json'

const PAGES = [
  ['home', '/'],
  ['usage', '/usage'],
  ['projects', '/projects'],
  ['region', '/reporting'],
  ['cost-centres', '/reporting?scope=cost-centre'],
  ['finance', '/reporting?scope=finance'],
]

/*
 * Each rule is a CLASS of defect with a one-line reason, so a failure reads as a
 * claim about the product rather than a diff of pixels. `where` narrows a rule
 * Adding a rule is how a newly-found defect class becomes permanently guarded.
 */
const RULES = [
  /*
   * ── THE RECONCILIATION CLASSES ──────────────────────────────────────────────
   * Added once the estate could finally produce them. Every persona used to be
   * single-lane, so none of the shapes below could occur locally and none of
   * these rules could ever have fired.
   */
  {
    /*
     * §A LEGITIMATELY EXCEEDING §B is a documented, correct state — a personal
     * subscription emitting through an enrolled instance (shared/reports/
     * types.ts:131). It must never be presented as an error, a loss, or a
     * negative that needs explaining away. `otel-over` is the persona that
     * produces it; before it existed this could not be checked at all.
     */
    id: 'OVER-EMISSION-AS-ERROR',
    why: 'OTel above the API bill is a real state, not a fault — never phrase it as an error',
    test: (t) => /(negative|invalid|impossible|error).{0,40}(delta|reconcil|attribut)/i.test(t)
      || /(delta|variance).{0,30}(cannot be|should not be) (negative|below)/i.test(t),
  },
  {
    /*
     * A day the provider billed for and we observed nothing on is the ROLLOUT
     * GAP and the JOINER's dead zone. Rendering it as "no spend" loses money
     * that is definitely real — the API is the bill. `lifecycle-joiner` and
     * `lifecycle-lapsed` each carry three such days.
     */
    id: 'API-ONLY-DAY-AS-NO-SPEND',
    why: 'a day with provider spend but no telemetry must not read as a day with no spend',
    /*
     * The negative lookahead is load-bearing. Without it this matched inside
     * "No spend in this period CARRIES A MODEL NAME" — a true sentence whose
     * subject is the model dimension, not the spend — and reported three
     * findings against copy that was already correct. Same trap as
     * LANE-ABSENCE-CALLED-SPEND-ABSENCE below, caught the same way: read what
     * matched before believing it.
     */
    test: (t) => /no (usage|spend|activity) (recorded|in this|for this) (window|period|month)(?!\s+carries)/i.test(t)
      && /provider-recorded day/i.test(t),
  },
  {
    /*
     * One human with two disclosed logins must roll up to ONE person. A total
     * that counts both identities is the failure this persona exists to expose;
     * so is a page that presents the second identity as a separate teammate.
     */
    id: 'IDENTITY-PRESENTED-AS-TWO-PEOPLE',
    why: 'a second disclosed identity is the same person — never a second row in a per-person total',
    test: (t) => /cov\.dual\.personal@gmail\.com/i.test(t),
  },
  {
    id: 'ABSENCE-AS-ZERO',
    why: 'a missing lane or dimension must never render as $0.00 / "no spend"',
    test: (t) => /\$0\.00\s*(per lane|cache|input|output)/i.test(t),
  },
  {
    /*
     * THE FALSE CLAIM ONLY. Naming an unbanded remainder INSIDE a populated card
     * ("$25.30 not banded") is honest and must not trip this rule — an earlier
     * version matched it and reported 5 findings that were correct behaviour,
     * which would have sent me to fix a card that was already telling the truth.
     * What is forbidden is denying the SPEND because a DIMENSION is missing.
     */
    id: 'LANE-ABSENCE-CALLED-SPEND-ABSENCE',
    why: 'an absent DIMENSION must not be reported as absent SPEND',
    test: (t) => /no (anthropic|claude|provider|copilot) spend/i.test(t),
  },
  {
    /*
     * Honest but useless: a card whose every dollar is remainder has delivered
     * none of what its title promises. Not a correctness bug — a UX gap — so it
     * is reported separately and should never be conflated with the lie above.
     */
    id: 'CARD-ALL-REMAINDER',
    why: 'a band card where 100% is unbanded delivers nothing its title promises',
    test: (t) => /not banded/i.test(t) && !/0–200k|200k\+|standard window/i.test(t),
  },
  /*
   * WITHDRAWN as a defect rule, kept as a note. Investigated 2026-08-06: the
   * copy is TRUE. `v_complete_usage` for the walked personas carries modelled
   * rows in May–July and exactly one unmodelled row ($25.30) in August, the
   * window the walk views. Region ranks five models because it aggregates a
   * whole region across months, not because /usage is dropping a dimension.
   *
   * Left here deliberately: it is a UX question worth an owner's eye — a card
   * that is empty for the current month while months of modelled history sit
   * behind it may want to say WHICH window is bare — but it is not the app
   * misreporting, and turning it into a fix would have been a fix to nothing.
   */
  {
    id: 'NOTE-MODEL-AXIS-EMPTY-THIS-WINDOW',
    why: 'INFO only — true copy; the window genuinely has no modelled rows',
    test: (t) => /no spend in this period carries a model name/i.test(t),
    info: true,
  },
  {
    id: 'ZERO-SESSIONS-BUT-FULL-SURFACE',
    why: 'a card must not report 0 sessions beside a 100% surface mix',
    test: (t) => /\b0 sessions\b/i.test(t) && /100%/.test(t),
  },
  {
    id: 'VENDOR-ALL-OTHER',
    why: 'a vendor split of 100% "Other" means the classifier failed, not the data',
    test: (t) => /other\s+\$[\d,.]+\s*·\s*100%/i.test(t),
  },
  {
    /*
     * The Dev report's second half: "hard to tell as I don't know WHAT cost
     * centre I'm looking at". An empty state is the one screen with no figure
     * to orient on, so a deictic ("this cost centre") plus a promise that money
     * will "appear here" tells the reader neither where they are nor why it is
     * bare. Matches the CLASS — any unnamed subject with a wait-and-see sub.
     *
     * PROMISSORY means a PROMISE, so the verb has to be there. A bare
     * `/appear here/` also matched the opposite of the defect: the active-users
     * chart explains its own scope with "…so other surfaces' spend does not
     * appear here", which names its subject and gives the reason — the rule
     * fired on three personas for copy that is exemplary. A gate that reddens
     * on good writing gets its findings waved through, and then it is not a
     * gate. Bounded to the same sentence, and negations do not match.
     */
    id: 'EMPTY-STATE-UNNAMED-OR-PROMISSORY',
    why: 'an empty state must name its subject and say WHY, not promise arrival',
    test: (t) =>
      /\bthis cost centre and month yet\b/i.test(t) ||
      /\b(?:will|'ll|shall|should|soon)\b[^.!?]{0,40}\b(?:appear|show up|land) here\b/i.test(t) ||
      /\bcheck back\b/i.test(t),
  },
  {
    id: 'SPARK-FLOOR-TEXT',
    why: 'the month spark must span the month, never say "not enough days yet"',
    test: (t) => /not enough days yet/i.test(t),
  },
]

async function signIn(page, persona) {
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const btn = page.getByText(`Sign in as ${persona}`, { exact: false }).first()
  await btn.waitFor({ state: 'visible', timeout: 60000 })
  await btn.click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90000 })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(`${OUT}/text`, { recursive: true })
  const expect = existsSync(EXPECT) ? JSON.parse(readFileSync(EXPECT, 'utf8')) : { expectations: [] }
  const personas = process.env.PERSONAS?.split(',') ?? ['Developer', 'CC owner', 'Region admin', 'Global finance', 'Manager']
  const browser = await chromium.launch({
    executablePath: process.env.CH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const findings = []

  for (const persona of personas) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 2400 } })
    const page = await ctx.newPage()
    try {
      await signIn(page, persona)
    } catch (e) {
      findings.push({ persona, page: 'LOGIN', rule: 'SIGN-IN-FAILED', detail: String(e).slice(0, 90) })
      await ctx.close()
      continue
    }
    for (const [name, path] of PAGES) {
      const slug = `${persona.replace(/\s+/g, '-').toLowerCase()}__${name}`
      try {
        await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
        await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {})
        await page.waitForTimeout(2600)
        await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true })
        const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
        /*
         * PERSIST THE EVIDENCE. The rules assert over this string, but only the
         * verdict was ever written out — so a clean walk could not be audited,
         * and neither could a finding: nobody could see what the rule actually
         * read. Five real defects on these same pages were found by eye, by a
         * human reading the rendered text the walk had already had in hand and
         * thrown away. Screenshots are not a substitute; they are not greppable.
         */
        writeFileSync(`${OUT}/text/${slug}.txt`, text)
        for (const r of RULES) {
          if (r.test(text)) findings.push({ persona, page: name, rule: r.id, why: r.why, shot: `${slug}.png` })
        }
        // A page that renders almost nothing is a finding in itself: an empty
        // state can be correct, but a blank surface never is.
        if (text.length < 400) {
          findings.push({ persona, page: name, rule: 'NEARLY-BLANK', why: `only ${text.length} chars rendered`, shot: `${slug}.png` })
        }
      } catch (e) {
        findings.push({ persona, page: name, rule: 'PAGE-ERROR', detail: String(e).slice(0, 90) })
      }
    }
    await ctx.close()
  }
  await browser.close()

  writeFileSync(`${OUT}/findings.json`, JSON.stringify({ findings, expectations: expect.expectations }, null, 1))
  const byRule = new Map()
  for (const f of findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1)
  console.warn(`coverage-walk: ${personas.length} personas x ${PAGES.length} pages -> ${findings.length} findings`)
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    const why = RULES.find((r) => r.id === rule)?.why ?? ''
    console.warn(`  ${String(n).padStart(3)}  ${rule.padEnd(34)} ${why}`)
  }
  console.warn(`  shots + findings.json + text/ (what the rules read) -> ${OUT}/`)
  // Non-zero so CI or a human loop can gate on it.
  // INFO rules never fail the run — only defects do.
  const defects = findings.filter((f) => !RULES.find((r) => r.id === f.rule)?.info)
  console.warn(`  ${defects.length} defect(s), ${findings.length - defects.length} informational`)
  process.exitCode = defects.length ? 1 : 0
}

void main()
