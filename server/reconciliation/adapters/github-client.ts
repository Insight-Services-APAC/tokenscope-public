/*
 * GitHub Copilot enterprise client — the HTTP/Zod layer shared by the Copilot
 * billing adapter (github.ts) and the identity resolver (github-identity.ts).
 *
 * Bound to ONE enterprise + its manage_billing PAT (the GitHub credential grain
 * is the enterprise; a single PAT reads every child org — §3.2). All three
 * surfaces below were verified against a live partner-demo PAT on 2026-06-08:
 *   - seats         GET /enterprises/{ent}/copilot/billing/seats   (X-GitHub-Api-Version 2026-03-10)
 *   - ai_credit     GET /enterprises/{ent}/settings/billing/ai_credit/usage?user=&year=&month=&day=
 *   - SAML identity GraphQL organization(login).samlIdentityProvider.externalIdentities
 *
 * Verified wire facts baked in here (so they cannot silently drift):
 *   - seat.organization is an OBJECT -> `.login` is the license org (NOT a string).
 *   - ai_credit/usage rejects organization+user together (400) -> query per-login.
 *   - usage item.unitType === 'ai-credits', pricePerUnit === 0.01; key on grossQuantity.
 *   - SAML nameId is the SSO email (email-shaped for the whole roster); emails[].primary
 *     is never set, so nameId is the reliable bridge.
 */
import { z } from 'zod'
import { createError } from 'h3'
import { resilientFetch, type ResilientFetchOptions } from '../../utils/resilient-fetch'
import type { GithubAppAuth } from './github-app-auth'

const API_BASE = 'https://api.github.com'
const SEATS_API_VERSION = '2026-03-10' // public preview — pin (§15.5)
const REST_API_VERSION = '2022-11-28'
// App-mode org/enterprise endpoints: pin to the version verified against the
// App-permission docs on 2026-06-30 (the org ai_credit/usage, org copilot seats, and
// enterprise consumed-licenses surfaces). Matches the SEATS pin convention above.
const APP_API_VERSION = '2026-03-10'

// ── Response schemas (only the fields we consume; .passthrough so the verbatim
//    payload is still available for ReconciledLine.raw) ───────────────────────
const SeatSchema = z
  .object({
    assignee: z.object({ login: z.string() }).passthrough(),
    // The license org ("managed by"). An object on the wire; we read .login.
    // Null is tolerated (org-less seat) -> the adapter falls back to assigning_team.
    organization: z.object({ login: z.string() }).passthrough().nullable().optional(),
    assigning_team: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).nullable().optional(),
    plan_type: z.string().nullable().optional(),
  })
  .passthrough()
export type GithubSeat = z.infer<typeof SeatSchema>

const SeatsPageSchema = z.object({
  total_seats: z.number().optional(),
  seats: z.array(SeatSchema).default([]),
})

const UsageItemSchema = z
  .object({
    product: z.string().optional(),
    sku: z.string().optional(),
    model: z.string().optional(),
    unitType: z.string().optional(),
    pricePerUnit: z.number().optional(),
    grossQuantity: z.number().default(0),
    grossAmount: z.number().default(0),
    discountQuantity: z.number().default(0),
    discountAmount: z.number().default(0),
    netQuantity: z.number().default(0),
    netAmount: z.number().default(0),
  })
  .passthrough()
export type GithubUsageItem = z.infer<typeof UsageItemSchema>

const AiCreditUsageSchema = z.object({
  timePeriod: z.record(z.string(), z.number()).optional(),
  usageItems: z.array(UsageItemSchema).default([]),
})
export type GithubAiCreditUsage = z.infer<typeof AiCreditUsageSchema>

// ── Enterprise billing usage report (the enhanced-billing platform aggregate) ──
// GET /enterprises/{ent}/settings/billing/usage?year=&month= → the POOLED per-(org, sku, day)
// bill (canonical §B: "1 call"). Distinct wire shape from ai_credit/usage: `quantity`
// (not grossQuantity), `netAmount`/`discountAmount`, and an `organizationName` dimension.
// .passthrough keeps the verbatim item for copilot_pool_bill.raw_payload.
//
// [ASSUMPTION — bill-report shape] Modelled from GitHub's enhanced-billing usage report
// documented shape; NOT re-verified against a live enterprise here (the copilot-pool-bill
// worker categorises SKUs defensively + .passthrough tolerates extra fields). The three
// canonical §B cost lines: "Copilot Enterprise" SKU net = license; AI-Credits/Cloud-Agent net
// = pooled overage; `discountAmount` on the AI-credit lines = the `included` pool allowance.
//
// FAIL-LOUD on the NET money field (MEDIUM-1a): `netAmount` carries NO `.default` — it is the
// authoritative chargeback figure (license/overage NET). If the (unverified-live) report
// OMITS or RENAMES it, we MUST throw here, not coerce to a silent $0: a defaulted 0 would sail
// past the worker's unsettled check and book a confident $0 for the whole enterprise with no
// alert. An absent net field instead throws → the worker's per-(enterprise, month) try/catch
// isolates the month (like any pull failure). The genuinely-optional CONTEXT fields
// (grossAmount / discountAmount / quantity / pricePerUnit) keep their benign defaults — their
// absence does not fabricate a chargeable figure.
const BillingUsageItemSchema = z
  .object({
    date: z.string().nullable().optional(),
    product: z.string().nullable().optional(),
    sku: z.string().nullable().optional(),
    quantity: z.number().default(0),
    unitType: z.string().nullable().optional(),
    pricePerUnit: z.number().default(0),
    grossAmount: z.number().default(0),
    discountAmount: z.number().default(0),
    netAmount: z.number(), // NO .default — an ABSENT/renamed net field MUST throw (fail-loud).
    organizationName: z.string().nullable().optional(),
    repositoryName: z.string().nullable().optional(),
  })
  .passthrough()
export type GithubBillingUsageItem = z.infer<typeof BillingUsageItemSchema>

// Exported for the worker test: a fixture with an absent net field must be shown to THROW at
// this boundary (the fail-loud contract above), reproducing the real client's parse.
export const BillingUsageReportSchema = z.object({
  usageItems: z.array(BillingUsageItemSchema).default([]),
})
export type GithubBillingUsageReport = z.infer<typeof BillingUsageReportSchema>

const ExternalIdentitySchema = z.object({
  samlIdentity: z
    .object({
      nameId: z.string().nullable().optional(),
      emails: z.array(z.object({ value: z.string(), primary: z.boolean().nullable().optional() })).nullable().optional(),
    })
    .nullable()
    .optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
})
export type GithubExternalIdentity = z.infer<typeof ExternalIdentitySchema>

const ExternalIdentitiesGqlSchema = z.object({
  data: z
    .object({
      organization: z
        .object({
          samlIdentityProvider: z
            .object({
              externalIdentities: z.object({
                pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
                nodes: z.array(ExternalIdentitySchema),
              }),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
})

/** A SAML directory entry: github login -> SSO email (from nameId). */
export interface SamlIdentity {
  login: string
  ssoEmail: string
}

// ── App-mode response schemas ────────────────────────────────────────────────
// GET /enterprises/{ent}/consumed-licenses — the App-mode identity source (App
// "Enterprise administration" read). It returns github_com_login -> github_com_saml_name_id
// for the WHOLE enterprise in one paginated call (no per-org SSO dance). Verified
// against the App-permission docs on 2026-06-30.
const ConsumedLicenseUserSchema = z
  .object({
    github_com_login: z.string().nullable().optional(),
    github_com_saml_name_id: z.string().nullable().optional(),
  })
  .passthrough()

const ConsumedLicensesPageSchema = z.object({
  total_seats_consumed: z.number().optional(),
  // The field carrying the per-user rows; some payloads key it 'users'.
  users: z.array(ConsumedLicenseUserSchema).default([]),
})

/*
 * A consumed-license identity row: github login -> SSO email (the SAML name id).
 * SHAPE-COMPATIBLE with SamlIdentity on purpose so the App identity path reuses the
 * exact login -> ssoEmail -> teammate bridge the SAML path uses. github_com_saml_name_id
 * IS the SSO email/UPN (email-shaped roster-wide), identical to the SAML nameId.
 */
export interface ConsumedLicenseIdentity {
  login: string
  ssoEmail: string
}

// GET .../copilot/metrics/reports/users-1-day?day= -> signed NDJSON download URLs + the
// report day. The per-user records live in the downloaded NDJSON (opaque to the OpenAPI
// schema). Enterprise Copilot metrics: READ.
const MetricsReportSchema = z.object({
  download_links: z.array(z.string()).default([]),
  report_day: z.string().optional(),
})

// One per-user record in the users-1-day NDJSON. We consume only the identity (user_login)
// + ai_credits_used (gross per-user daily AI-credit CONSUMPTION); .passthrough keeps the
// engagement fields for ReconciledLine.raw. Verified live 2026-06-30 (53 users, the field
// present on the record alongside user_login/day/ai_adoption_phase).
const UserMetricsRecordSchema = z
  .object({
    user_login: z.string().nullable().optional(),
    user_id: z.number().nullable().optional(),
    day: z.string().nullable().optional(),
    ai_credits_used: z.number().nullable().optional(),
  })
  .passthrough()
type UserMetricsRecord = z.infer<typeof UserMetricsRecordSchema>

/* A per-user daily AI-credit consumption row, parsed from the metrics report. */
export interface UserDailyCredits {
  login: string
  credits: number
  raw: unknown
}

export class GithubCopilotClient {
  /*
   * Two construction modes — BOTH back-compat-safe:
   *   - PAT mode (today's default): `pat` is the classic enterprise manage_billing PAT.
   *     The existing enterprise methods (getAiCreditUsage / listSeats / listSamlIdentities)
   *     use it verbatim — their signatures + behaviour are UNCHANGED (requirement 1).
   *   - App mode: `appAuth` (a GithubAppAuth) is supplied INSTEAD of a PAT. The NEW
   *     App-mode methods (getUserDailyCredits / consumedLicenses) authenticate per-
   *     installation via it (enterprise-grain, read-only). The legacy PAT methods are
   *     NEVER called in App mode (the adapter branches at the seam by credential.kind).
   *
   * Constructed via the two factory statics below so callers can't pass both auth modes.
   */
  private constructor(
    private readonly enterpriseSlug: string,
    private readonly pat: string,
    private readonly appAuth?: GithubAppAuth,
    /** Optional per-request budget (timeout/retries) threaded into every resilientFetch
     *  call. Undefined = resilientFetch's defaults, so the reconciliation workers (which
     *  pass nothing) are byte-identical. The admin health probe passes a TIGHT budget
     *  (short timeout, 0 retries) so a black-holed call fails fast with a genuine
     *  transport error and a 429 surfaces immediately — no retry sleeps to race. */
    private readonly fetchOpts?: ResilientFetchOptions,
  ) {}

  /** PAT-mode client (the classic enterprise manage_billing PAT). */
  static withPat(enterpriseSlug: string, pat: string, fetchOpts?: ResilientFetchOptions): GithubCopilotClient {
    return new GithubCopilotClient(enterpriseSlug, pat, undefined, fetchOpts)
  }

  /** App-mode client (per-installation tokens via GithubAppAuth; no PAT). */
  static withApp(enterpriseSlug: string, appAuth: GithubAppAuth, fetchOpts?: ResilientFetchOptions): GithubCopilotClient {
    return new GithubCopilotClient(enterpriseSlug, '', appAuth, fetchOpts)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': REST_API_VERSION,
      'User-Agent': 'tokenscope-reconciliation',
      ...extra,
    }
  }

  /** Headers for an installation-token-authenticated App-mode request. */
  private appHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      // Verified against the App-permission docs on 2026-06-30.
      'X-GitHub-Api-Version': APP_API_VERSION,
      'User-Agent': 'tokenscope-reconciliation',
      ...extra,
    }
  }

  /** The bound GithubAppAuth (App mode only); throws if a method is called without it. */
  private requireApp(): GithubAppAuth {
    if (!this.appAuth) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        data: {
          type: 'https://tokenscope.example.com/errors/github-app-misconfig',
          title: 'App-mode method called on a PAT-mode client',
          status: 500,
          detail: 'GithubCopilotClient App-mode method requires an App credential',
        },
      })
    }
    return this.appAuth
  }

  // Never leak the PAT/App key/token in the thrown message — only the surface, status,
  // and (optionally) the GitHub error-message body (the worker logs the scope separately).
  private fail(surface: string, status: number, bodySnippet?: string): never {
    throw createError({
      statusCode: 502,
      statusMessage: 'Bad Gateway',
      data: {
        type: 'https://tokenscope.example.com/errors/github-upstream',
        title: 'GitHub API call failed',
        status: 502,
        detail: `${surface} returned HTTP ${status}${bodySnippet ? ` :: ${bodySnippet}` : ''}`,
      },
    })
  }

  /** All Copilot seats in the enterprise (paginated). The lane authority (§4.2). */
  async listSeats(): Promise<GithubSeat[]> {
    const out: GithubSeat[] = []
    for (let page = 1; page <= 100; page++) {
      // resilientFetch (ING-7): timeout + backoff honouring retry-after — GitHub
      // secondary rate limits are a certainty at seats×days serial calls per tick.
      const res = await resilientFetch(
        `${API_BASE}/enterprises/${this.enterpriseSlug}/copilot/billing/seats?per_page=100&page=${page}`,
        { headers: this.headers({ 'X-GitHub-Api-Version': SEATS_API_VERSION }) },
        this.fetchOpts,
      )
      if (!res.ok) this.fail('seats', res.status)
      const body = SeatsPageSchema.parse(await res.json())
      out.push(...body.seats)
      if (body.seats.length < 100) break
    }
    return out
  }

  /*
   * AI-credit usage for one login on one UTC day. organization+user together is a
   * 400, so we never pass org — the license org comes from the seat roster. day is
   * REQUIRED here (verified daily-grain): the engine reconciles per periodDate.
   */
  async getAiCreditUsage(login: string, date: { year: number; month: number; day: number }): Promise<GithubAiCreditUsage> {
    const qs = `user=${encodeURIComponent(login)}&year=${date.year}&month=${date.month}&day=${date.day}`
    const res = await resilientFetch(
      `${API_BASE}/enterprises/${this.enterpriseSlug}/settings/billing/ai_credit/usage?${qs}`,
      { headers: this.headers() },
      this.fetchOpts,
    )
    if (!res.ok) this.fail('ai_credit/usage', res.status)
    return AiCreditUsageSchema.parse(await res.json())
  }

  /*
   * AI-credit usage for one login over a whole MONTH (day omitted → the month total).
   * The Copilot BILL needs the month-cumulative per-USER usage (the allowance is
   * per-user), so the bill writer reads this ONE call per login rather than summing
   * per-day rows out of the reconciliation DELTA ledger (which drops corroborated
   * 'matched' days — see ADR-0010 / copilot-bill.ts). Same endpoint; day omitted.
   */
  async getAiCreditUsageMonth(login: string, year: number, month: number): Promise<GithubAiCreditUsage> {
    const qs = `user=${encodeURIComponent(login)}&year=${year}&month=${month}`
    const res = await resilientFetch(
      `${API_BASE}/enterprises/${this.enterpriseSlug}/settings/billing/ai_credit/usage?${qs}`,
      { headers: this.headers() },
      this.fetchOpts,
    )
    if (!res.ok) this.fail('ai_credit/usage(month)', res.status)
    return AiCreditUsageSchema.parse(await res.json())
  }

  /*
   * The enterprise POOLED billing usage report for one month (canonical §B "1 call"):
   * GET /enterprises/{ent}/settings/billing/usage?year=&month= → usageItems[] per (org, sku,
   * day). The copilot-pool-bill worker READS the net lines from this (never recomputes). Works
   * in BOTH auth modes:
   *   - PAT mode (today's default): the enterprise manage_billing PAT reads it directly.
   *   - App mode: via the ENTERPRISE installation token (Enterprise administration / billing
   *     read). [ASSUMPTION] the App-mode reachability of this billing endpoint is NOT verified
   *     against a live App here (per-user ai_credit billing is App-blocked; the AGGREGATE
   *     billing report is a distinct enterprise-admin surface) — the worker isolates a failing
   *     enterprise (never a green zero) so an unreachable App path surfaces as a skip, not a
   *     silent $0. See docs/design/provider-billing-attribution-model.md §B.
   */
  async getEnterpriseBillingUsage(year: number, month: number): Promise<GithubBillingUsageReport> {
    const url = `${API_BASE}/enterprises/${encodeURIComponent(this.enterpriseSlug)}/settings/billing/usage?year=${year}&month=${month}`
    let headers: Record<string, string>
    if (this.appAuth) {
      const app = this.requireApp()
      const installationId = await app.enterpriseInstallationId(this.enterpriseSlug)
      if (installationId == null) this.fail('enterprises/{ent}/installation (no install)', 404)
      const token = await app.installationToken(installationId)
      headers = this.appHeaders(token)
    } else {
      headers = this.headers()
    }
    const res = await resilientFetch(url, { headers }, this.fetchOpts)
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
      this.fail('enterprises/{ent}/settings/billing/usage', res.status, body)
    }
    return BillingUsageReportSchema.parse(await res.json())
  }

  /*
   * SAML externalIdentities for ONE org (login -> SSO email). SSO is configured per
   * org (Azure AD), so this is queried per license org, not at the enterprise level.
   *
   * AUTH is mode-aware — the GraphQL query + parsing are IDENTICAL in both modes; only the
   * credential (and one skip case) differ:
   *   - App mode (this.appAuth set): authenticate with THAT ORG's installation token
   *     (App permission `organization_administration: read`). App-not-installed-on-this-org
   *     (orgInstallationId → null on 404 / suspended) is a CLEAN skip ([]), NOT an error — SSO
   *     is configured per org and the App need not be installed on every license org. This is
   *     the App-mode identity bridge (replacing the disproven enterprise `consumed-licenses`
   *     path, which is App-blocked for installation tokens).
   *   - PAT mode (default): the enterprise PAT (must carry read:org AND be SSO-authorised for
   *     that org).
   * On FORBIDDEN/INSUFFICIENT_SCOPES (a real permission/SSO error — either mode) it throws so
   * the caller can degrade that org to carry-forward rather than silently dropping the roster.
   */
  async listSamlIdentities(orgLogin: string): Promise<SamlIdentity[]> {
    const query = `query($o:String!,$c:String){organization(login:$o){samlIdentityProvider{externalIdentities(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{samlIdentity{nameId emails{value primary}} user{login}}}}}}`
    // Derive the GraphQL headers once (they don't change across pages). App mode resolves the
    // org's installation token; App-not-installed-on-this-org is a clean skip (return []).
    let gqlHeaders: Record<string, string>
    if (this.appAuth) {
      const installationId = await this.appAuth.orgInstallationId(orgLogin)
      if (installationId == null) return [] // App not installed/suspended on this org → skip cleanly
      const token = await this.appAuth.installationToken(installationId)
      gqlHeaders = this.appHeaders(token, { 'Content-Type': 'application/json' })
    } else {
      gqlHeaders = this.headers({ 'Content-Type': 'application/json' })
    }
    const out: SamlIdentity[] = []
    let cursor: string | null = null
    for (let page = 1; page <= 100; page++) {
      // Safe to retry: a GraphQL query is read-only despite the POST verb.
      const res = await resilientFetch(`${API_BASE}/graphql`, {
        method: 'POST',
        headers: gqlHeaders,
        body: JSON.stringify({ query, variables: { o: orgLogin, c: cursor } }),
      }, this.fetchOpts)
      if (!res.ok) this.fail('graphql externalIdentities', res.status)
      const parsed = ExternalIdentitiesGqlSchema.parse(await res.json())
      if (parsed.errors?.length) {
        // INSUFFICIENT_SCOPES / FORBIDDEN (PAT not SSO-authorised for this org).
        throw createError({
          statusCode: 502,
          statusMessage: 'Bad Gateway',
          data: {
            type: 'https://tokenscope.example.com/errors/github-saml',
            title: 'SAML externalIdentities unavailable',
            status: 502,
            detail: parsed.errors.map((e) => e.type ?? 'error').join(','),
          },
        })
      }
      const ei = parsed.data?.organization?.samlIdentityProvider?.externalIdentities
      if (!ei) break // SSO not configured at this org (samlIdentityProvider null)
      for (const node of ei.nodes) {
        const login = node.user?.login
        // nameId is the reliable SSO email (email-shaped roster-wide); emails[] is a
        // fallback in case a future entry lacks it.
        const email = node.samlIdentity?.nameId ?? node.samlIdentity?.emails?.[0]?.value
        if (login && email) out.push({ login, ssoEmail: email })
      }
      if (!ei.pageInfo.hasNextPage) break
      cursor = ei.pageInfo.endCursor
    }
    return out
  }

  // ── App-mode methods (NEW; never overload the live PAT methods) ──
  //
  // App mode is ENTERPRISE-grain + READ-ONLY: identity via consumed-licenses (Enterprise
  // people read) and per-user usage via the Copilot metrics report (Enterprise Copilot
  // metrics read). Neither needs a PAT, an org-Administration permission, nor the mutate-
  // capable manage_billing scope — the IT-acceptable least-privilege posture. Each call
  // resolves the ENTERPRISE installation id, exchanges it for an installation token, and
  // pins X-GitHub-Api-Version: 2026-03-10.
  //
  // Per-user BILLING (ai_credit/usage?user=) is NOT reachable by ANY App token on
  // enterprise-owned orgs (confirmed live 2026-06-30: org-token filter-403, enterprise-token
  // not-accessible, enterprise endpoint App-disabled). App mode therefore reads CONSUMPTION
  // from the metrics report — "the same AI credits consumption data used in the usage-based
  // billing API" (2026-06-19 changelog), priced at the flat $0.01/credit rate downstream.
  // See docs/design/github-pat-to-github-app-transition.md.

  /*
   * Per-user AI-credit CONSUMPTION for one UTC day, for the whole enterprise in one report:
   * GET /enterprises/{ent}/copilot/metrics/reports/users-1-day?day=YYYY-MM-DD (Enterprise
   * Copilot metrics: READ, via the ENTERPRISE installation token) -> {download_links,
   * report_day}; each signed link is an NDJSON file of per-user records carrying user_login
   * + ai_credits_used (verified live 2026-06-30). Returns one row per login that carries a
   * usable login; ai_credits_used defaults to 0 when absent. App not installed on the
   * enterprise -> the adapter carries the day forward (404 -> fail()). An unparseable NDJSON
   * line is skipped, never the whole report.
   */
  async getUserDailyCredits(day: string): Promise<UserDailyCredits[]> {
    const app = this.requireApp()
    const installationId = await app.enterpriseInstallationId(this.enterpriseSlug)
    if (installationId == null) this.fail('enterprises/{ent}/installation (no install)', 404)
    const token = await app.installationToken(installationId)
    const res = await resilientFetch(
      `${API_BASE}/enterprises/${encodeURIComponent(this.enterpriseSlug)}/copilot/metrics/reports/users-1-day?day=${encodeURIComponent(day)}`,
      { headers: this.appHeaders(token) },
      this.fetchOpts,
    )
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
      this.fail('enterprises/{ent}/copilot/metrics/reports/users-1-day', res.status, body)
    }
    const report = MetricsReportSchema.parse(await res.json())
    // The report is generated ASYNCHRONOUSLY: a 200 with NO download_links means the day's
    // report is not ready yet → a RETRYABLE gap (carry forward), NOT an authoritative zero
    // that silently books nothing for the whole enterprise-day.
    if (report.download_links.length === 0) {
      this.fail('copilot metrics users-1-day (report not ready — no download_links)', res.status)
    }
    // Anti-mis-dating: book ONLY when GitHub's report_day matches the requested day. A
    // divergent report_day (stale / boundary lag) would attribute credits to the wrong
    // periodDate; carry the day forward instead of mis-dating it.
    if (report.report_day && report.report_day !== day) {
      this.fail(`copilot metrics users-1-day (report_day ${report.report_day} != requested ${day})`, res.status)
    }
    const out: UserDailyCredits[] = []
    for (const link of report.download_links) {
      // Defence in depth: the report is signed, so a non-HTTPS download link is anomalous —
      // never fetch it (carry the day forward).
      if (!link.startsWith('https://')) this.fail('copilot metrics report download (non-HTTPS link)', 0)
      // Signed blob URL — send NO auth header (the bearer can break the pre-signed signature).
      let dl: Response
      try {
        dl = await resilientFetch(link, { headers: { 'User-Agent': 'tokenscope-reconciliation' } }, this.fetchOpts)
      } catch {
        // A network-layer throw carries the signed URL in its `cause`; re-raise through fail()
        // with a CONSTANT surface so the URL can never reach a worker log.
        this.fail('copilot metrics report download (network)', 0)
      }
      if (!dl.ok) this.fail('copilot metrics report download', dl.status)
      for (const raw of (await dl.text()).split('\n')) {
        const line = raw.trim()
        if (!line) continue
        let parsed: UserMetricsRecord
        try {
          parsed = UserMetricsRecordSchema.parse(JSON.parse(line))
        } catch {
          continue // skip one non-conforming NDJSON line, never the whole report
        }
        const login = parsed.user_login
        if (!login) continue
        out.push({ login, credits: parsed.ai_credits_used ?? 0, raw: parsed })
      }
    }
    return out
  }

  /*
   * Per-org Copilot SEAT-HOLDERS for ONE license org (App mode only): GET
   * /orgs/{org}/copilot/billing/seats (via THAT org's installation token). Returns
   * { login, org } for each seat, restricting which logins we BIND / bill-provision to
   * ACTUAL seat-holders (ADR-0010 rule 1 — the bill is proof), so App mode does NOT
   * provision every SSO org member, only billed users. Paginated. App-not-installed-on-this-org
   * (orgInstallationId → null) is a clean skip ([]), not an error. Never leaks the token.
   */
  async listOrgCopilotSeats(orgLogin: string): Promise<{ login: string; org: string }[]> {
    const app = this.requireApp()
    const installationId = await app.orgInstallationId(orgLogin)
    if (installationId == null) return [] // App not installed/suspended on this org → no seats
    const token = await app.installationToken(installationId)
    const out: { login: string; org: string }[] = []
    for (let page = 1; page <= 100; page++) {
      const res = await resilientFetch(
        `${API_BASE}/orgs/${encodeURIComponent(orgLogin)}/copilot/billing/seats?per_page=100&page=${page}`,
        { headers: this.appHeaders(token, { 'X-GitHub-Api-Version': SEATS_API_VERSION }) },
        this.fetchOpts,
      )
      if (!res.ok) this.fail('orgs/{org}/copilot/billing/seats', res.status)
      const body = SeatsPageSchema.parse(await res.json())
      for (const seat of body.seats) out.push({ login: seat.assignee.login, org: orgLogin })
      if (body.seats.length < 100) break
    }
    return out
  }

  /*
   * Enterprise identity in ONE call: GET /enterprises/{ent}/consumed-licenses (Enterprise
   * administration read, via the ENTERPRISE installation token). Returns github_com_login ->
   * github_com_saml_name_id (the SSO email) for the whole enterprise.
   *
   * RETAINED but NO LONGER WIRED into the identity resolver: this enterprise endpoint is
   * App-BLOCKED for installation tokens (401/403 "Resource not accessible by integration"),
   * so App-mode identity now bridges per-org via listSamlIdentities (organization_administration
   * read) instead — mirroring PAT mode. Kept for reference / a possible future PAT-of-App
   * path. Paginated. Skips rows missing either field (carry-forward).
   */
  async consumedLicenses(): Promise<ConsumedLicenseIdentity[]> {
    const app = this.requireApp()
    const installationId = await app.enterpriseInstallationId(this.enterpriseSlug)
    if (installationId == null) {
      // App not installed (or suspended) on the enterprise → no identity bridge; the
      // resolver degrades the enterprise to carry-forward rather than dropping the roster.
      this.fail('enterprises/{ent}/installation (no install)', 404)
    }
    const token = await app.installationToken(installationId)
    const out: ConsumedLicenseIdentity[] = []
    for (let page = 1; page <= 100; page++) {
      const res = await resilientFetch(
        `${API_BASE}/enterprises/${encodeURIComponent(this.enterpriseSlug)}/consumed-licenses?per_page=100&page=${page}`,
        { headers: this.appHeaders(token) },
        this.fetchOpts,
      )
      if (!res.ok) this.fail('enterprises/{ent}/consumed-licenses', res.status)
      const body = ConsumedLicensesPageSchema.parse(await res.json())
      for (const u of body.users) {
        const login = u.github_com_login
        const ssoEmail = u.github_com_saml_name_id
        if (login && ssoEmail) out.push({ login, ssoEmail })
      }
      // The endpoint paginates by Link header / page; we stop when a page is short.
      if (body.users.length < 100) break
    }
    return out
  }
}
