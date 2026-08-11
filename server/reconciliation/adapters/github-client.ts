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
import { readRawPage, errorPageFrom, paramPairsOf, pathOf, type RawPage, type RawPageErr } from '../../utils/raw-page'
import type { GithubAppAuth } from './github-app-auth'
import { decodePem } from './github-app-auth'

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

/*
 * Pagination diagnostics for a listSeats() pull (S9). `listSeats()`'s plain
 * `GithubSeat[]` return makes a genuinely-small/empty roster INDISTINGUISHABLE from a
 * truncated one — three separate ways: the `seats` schema default([]) on a 200 with a
 * missing/renamed key, a short page ending pagination early, or the 100-page hard cap.
 * A caller that DELETEs based on the roster (the seat-convergence prune) needs these
 * flags to reason about whether "the roster came back empty/small" is trustworthy.
 */
export interface SeatsPullDiagnostics {
  seats: GithubSeat[]
  /** The 100-page (10,000-seat) hard cap was hit — pagination stopped because it ran
   *  out of page budget, not because the API signalled the end. */
  pagesCapped: boolean
  /** Pagination ended via a short page (fewer than per_page seats on a page). The
   *  NORMAL end-of-roster signal for a real pull — but indistinguishable at this layer
   *  from a short/empty page produced by a partial outage or an API-shape change. */
  shortPageBreak: boolean
}

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

/* GET /users/{login}. Both fields are self-asserted profile text and are null far more often
 * than not (a private profile has neither), so both are optional-and-nullable by design —
 * see getUserProfile for why this is a display hint and never an identity source. */
const UserProfileSchema = z
  .object({
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough()

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

/*
 * ── DECLARING A DIMENSION MUST NOT BE ABLE TO COST US THE MONEY (task #48) ───
 *
 * `getUserDailyCredits` parses each NDJSON line inside a try/catch that SKIPS
 * the line on failure. That is right for a corrupt line and catastrophic for a
 * shape surprise in a field we merely wanted to read: a `totals_by_cli` that
 * arrived as an array rather than an object would drop the WHOLE record, and
 * with it that user-day's `ai_credits_used`.
 *
 * So every field added below is `.optional()` (absence is ordinary — 47/200
 * records carry `totals_by_cli` at all) AND carries `.catch(undefined)`, which
 * makes a wrongly-shaped subtree degrade to "this dimension is absent" instead
 * of failing the record. A declaration buys types and validation; it must never
 * buy them with the figure the surface exists to deliver.
 * tests/unit/reconciliation/github-metrics-record-schema.test.ts pins that.
 */
const cliTokenUsage = z
  .object({
    prompt_tokens_sum: z.number().nullable().optional(),
    output_tokens_sum: z.number().nullable().optional(),
    avg_tokens_per_request: z.number().nullable().optional(),
  })
  .passthrough()

/*
 * One per-user record in the users-1-day NDJSON.
 *
 * FOUR FIELDS WERE DECLARED (user_login, user_id, day, ai_credits_used) while
 * ~90 more arrived and survived unread through .passthrough(). The 2026-08-02
 * wire capture is what made that visible
 * (docs/design/provider-wire-captures/) and #48 is declaring the ones the
 * transform actually consumes. Observed frequencies, from that capture:
 *
 *   ai_credits_used                                        100%, AT THE RECORD ROOT
 *   totals_by_model_feature[].model                        487/487 stored, 34/34 live
 *   totals_by_cli.token_usage.{prompt,output}_tokens_sum   47/200 stored — SPARSE
 *   loc_{added,deleted,suggested_to_add,suggested_to_delete}_sum   number, 100%
 *   code_{generation,acceptance}_activity_count                    number, 100%
 *   user_initiated_interaction_count                               number, 100%
 *   totals_by_language_model[].{model,language}            756/756 stored, 45/45 live
 *   totals_by_language_feature[]                           813 rows stored (language × feature)
 *
 * The ENGAGEMENT fields (developer-pages W0b, D7) — the LOC sums, the three
 * activity counts, and the two language arrays — are declared for the
 * self-depth engagement card's derived read
 * (server/usage/copilot-engagement.ts). The TRANSFORM still bands on
 * `totals_by_model_feature` only: a model's share of DELIBERATE user
 * interactions is the closest Copilot has to "how much work ran on this model"
 * and the language dimension answers a different question
 * (04-prototype-delta.md §5). Declaring the language arrays here does not
 * change that choice — it types what the engagement read consumes.
 *
 * WIRE-CHECK CAVEAT on the language-array ENTRY MEASURES (W0b's D1-style
 * check): the 2026-08-02 capture inventories `totals_by_language_model`
 * entries' `model`/`language` keys but NOT their entry-level numeric measures,
 * and no raw capture file exists to name one. The per-entry
 * `user_initiated_interaction_count` declared below is therefore a CANDIDATE
 * weighting measure, `.nullish()` like everything else: absence parses, and
 * the read side (copilot-engagement.ts) weights by it only when the wire
 * actually sends it, falling back per D9's ladder — never equal-splitting,
 * never fabricating weights.
 *
 * NOTE ON WHAT #48 DOES AND DOES NOT UNLOCK: these fields were ALREADY reaching
 * `reconciliation_record.raw` verbatim. Declaring them changes nothing at rest;
 * it gives the consumer a type and a validated shape instead of a cast.
 * Every declared field keeps the `.catch(undefined)` discipline of the header
 * above — a shape surprise degrades to "this dimension is absent" and can
 * never cost the record its `ai_credits_used`.
 */
/** One `totals_by_language_model` entry: the language × model dimension pair
 *  plus the candidate per-entry weighting measure (see the schema header). */
const languageModelEntry = z
  .object({
    model: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    user_initiated_interaction_count: z.number().nullish().catch(undefined),
  })
  .passthrough()

/** One `totals_by_language_feature` entry — D9's fallback weighting rung. */
const languageFeatureEntry = z
  .object({
    language: z.string().nullable().optional(),
    feature: z.string().nullable().optional(),
    user_initiated_interaction_count: z.number().nullish().catch(undefined),
  })
  .passthrough()

const UserMetricsRecordSchema = z
  .object({
    user_login: z.string().nullable().optional(),
    user_id: z.number().nullable().optional(),
    day: z.string().nullable().optional(),
    ai_credits_used: z.number().nullable().optional(),
    // ── Engagement scalars (W0b D7) — all nullish, no defaults, catch-guarded:
    // a wrongly-typed count degrades to absent, never fails the record (and a
    // consumer must render absence as absent, not zero — honest numbers).
    loc_added_sum: z.number().nullish().catch(undefined),
    loc_deleted_sum: z.number().nullish().catch(undefined),
    loc_suggested_to_add_sum: z.number().nullish().catch(undefined),
    loc_suggested_to_delete_sum: z.number().nullish().catch(undefined),
    code_generation_activity_count: z.number().nullish().catch(undefined),
    code_acceptance_activity_count: z.number().nullish().catch(undefined),
    user_initiated_interaction_count: z.number().nullish().catch(undefined),
    // The MODEL dimension, per user-day. `user_initiated_interaction_count` is
    // the activity measure; one model appears under several features, so a
    // consumer must SUM rather than take the first.
    totals_by_model_feature: z
      .array(
        z
          .object({
            model: z.string().nullable().optional(),
            feature: z.string().nullable().optional(),
            user_initiated_interaction_count: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
    // The LANGUAGE × MODEL dimension (W0b D7) — the engagement card's language
    // mix source, weighted per the schema-header caveat.
    totals_by_language_model: z.array(languageModelEntry).optional().catch(undefined),
    // The LANGUAGE × FEATURE dimension — D9's fallback weighting rung when the
    // language × model entries carry no numeric measure.
    totals_by_language_feature: z.array(languageFeatureEntry).optional().catch(undefined),
    // TOKENS, and only on the CLI surface. Day grain — there is no model
    // beneath this subtree, so tokens can never be attributed to a model from
    // here. Sparse: absence means "no CLI use that day", never "tokens lost".
    totals_by_cli: z
      .object({ token_usage: cliTokenUsage.nullable().optional() })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough()
type UserMetricsRecord = z.infer<typeof UserMetricsRecordSchema>

/* A per-user daily AI-credit consumption row, parsed from the metrics report. */
export interface UserDailyCredits {
  login: string
  credits: number
  raw: unknown
}

/**
 * Step 2 of the DIAGNOSTIC two-step read: what came back from the ONE signed
 * NDJSON file the probe downloaded. Every count here exists so the report can
 * state its bound instead of letting a partial read look exhaustive.
 */
export interface RawNdjsonRead {
  /** How many entries `download_links` carried. The probe follows only the first. */
  linksAvailable: number
  /** How many were downloaded. 1 on a successful read, 0 otherwise. Never more. */
  linksRead: number
  /** The line cap this read applied. */
  lineLimit: number
  /** Non-blank lines consumed, unparseable ones included. Never exceeds lineLimit. */
  linesRead: number
  /** True when the file held MORE non-blank lines than the cap — `records` is a PREFIX. */
  linesCapped: boolean
  /** Lines that were not JSON and were skipped. */
  linesUnparseable: number
  /** The parsed lines, with NO schema applied — the entire point of this accessor. */
  records: unknown[]
  /**
   * Set when the download itself failed; `records` is then empty. The signed link
   * is scrubbed out of this text, so it is safe to render (see the method).
   */
  error: RawPageErr | null
}

/** The DIAGNOSTIC two-step read of the users-1-day metrics report. */
export interface RawUserDailyCreditsPage {
  /** Path of the step-1 report request, for display. Never a download link. */
  path: string
  /** Query parameters of the step-1 request. Never a download link. */
  params: Array<[string, string]>
  /** Step 1's response, UNPARSED. */
  envelope: RawPage
  /** Step 2. null when step 1 failed — there was no link to follow. */
  ndjson: RawNdjsonRead | null
}

// GET /enterprises/{ent}/apps/installable_organizations page schema — verified against
// GitHub's documented "Installable Organization" shape ({id, login,
// accessible_repositories_url}); we consume only id/login (.passthrough tolerates the
// rest, incl. accessible_repositories_url, which coverage detection never needs).
const InstallableOrganizationSchema = z.object({ id: z.number(), login: z.string() }).passthrough()
const InstallableOrganizationsPageSchema = z.array(InstallableOrganizationSchema)

/** listInstallableOrganizations() result — see the method doc for the pagination contract. */
export interface InstallableOrganizationsResult {
  organizations: Array<{ id: number; login: string }>
  /** The 100-page (10,000-org) hard cap was hit — the list above is a PREFIX of the
   *  enterprise's orgs, not the whole census. Never treat this pull as authoritative
   *  for a completeness/denominator claim when true (coverage.ts). */
  pagesCapped: boolean
  /** Pagination ended via a short page — the NORMAL end-of-census signal. */
  shortPageBreak: boolean
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

  /*
   * PAT-mode client (the classic enterprise manage_billing PAT).
   *
   * HARDENED SEAM (S9): two call sites once flattened a `ResolvedCredential` to
   * `.value` and passed the GitHub App PRIVATE KEY here, which would have minted
   * `Authorization: Bearer <base64 PEM>` (a key transmitted as if it were a token).
   * Reuses github-app-auth.ts's OWN PEM parser (decodePem) rather than a second ad
   * hoc sniff — if the value round-trips through it (base64-decodes AND parses as a
   * private key), it is categorically not a PAT, so refuse construction rather than
   * silently building a client that would leak the key on the wire. The failure
   * message never includes the value itself, only that the shape was rejected.
   */
  static withPat(enterpriseSlug: string, pat: string, fetchOpts?: ResilientFetchOptions): GithubCopilotClient {
    let looksLikeAppKey = false
    try {
      decodePem(pat)
      looksLikeAppKey = true
    } catch {
      // Expected for a real PAT — decodePem's rejection IS the "not a PEM" signal.
    }
    if (looksLikeAppKey) {
      throw new Error(
        'GithubCopilotClient.withPat: the supplied value parses as a base64-encoded PEM private key, ' +
          'not a PAT. Pass the whole ResolvedCredential and branch on credential.kind (GithubCopilotClient.withApp ' +
          'for App mode) instead of flattening it to .value.',
      )
    }
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

  /*
   * Shared seats pagination loop — the SINGLE implementation both listSeats() (back-
   * compat surface for callers that only need the array) and listSeatsWithDiagnostics()
   * (S9: the seat-convergence prune needs to know whether the pull may have been
   * truncated) read from. `seats: z.array(SeatSchema).default([])` means a 200 whose
   * body is missing/renames the `seats` key parses to an EMPTY page with no error —
   * so an empty/short result from this loop is NOT proof the roster is actually
   * empty/small; see SeatsPullDiagnostics.
   */
  private async pullSeats(): Promise<SeatsPullDiagnostics> {
    const out: GithubSeat[] = []
    let shortPageBreak = false
    let pagesCapped = false
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
      if (body.seats.length < 100) {
        shortPageBreak = true
        break
      }
      if (page === 100) {
        // Consumed all 100 pages at a full 100 seats each — the hard cap was reached
        // without a natural end-of-roster signal. The enterprise may have MORE seats
        // beyond page 100 that were never fetched.
        pagesCapped = true
      }
    }
    return { seats: out, pagesCapped, shortPageBreak }
  }

  /** All Copilot seats in the enterprise (paginated). The lane authority (§4.2). */
  async listSeats(): Promise<GithubSeat[]> {
    return (await this.pullSeats()).seats
  }

  /*
   * Like listSeats(), but also surfaces pagination diagnostics (S9) so a caller that
   * DELETEs based on the roster (the Copilot seat-convergence prune in copilot-bill.ts)
   * can tell a truncated pull apart from a genuinely small/empty one — `listSeats()`'s
   * plain array return makes those indistinguishable. A separate method (not a changed
   * `listSeats()` signature) because github-identity.ts and github.ts also call
   * listSeats() and only need the array.
   */
  async listSeatsWithDiagnostics(): Promise<SeatsPullDiagnostics> {
    return this.pullSeats()
  }

  /*
   * AI-credit usage for one login on one UTC day. organization+user together is a
   * 400, so we never pass org — the license org comes from the seat roster. day is
   * REQUIRED here (verified daily-grain): the engine reconciles per periodDate.
   */
  /*
   * The per-login ai_credit/usage URL for one UTC day. Single source of truth for
   * getAiCreditUsage and the wire-shape probe, so the diagnostic cannot describe a
   * differently-shaped request than the one reconciliation issues.
   */
  private aiCreditUsageUrl(login: string, date: { year: number; month: number; day: number }): string {
    const qs = `user=${encodeURIComponent(login)}&year=${date.year}&month=${date.month}&day=${date.day}`
    return `${API_BASE}/enterprises/${this.enterpriseSlug}/settings/billing/ai_credit/usage?${qs}`
  }

  async getAiCreditUsage(login: string, date: { year: number; month: number; day: number }): Promise<GithubAiCreditUsage> {
    const res = await resilientFetch(
      this.aiCreditUsageUrl(login, date),
      { headers: this.headers() },
      this.fetchOpts,
    )
    if (!res.ok) this.fail('ai_credit/usage', res.status)
    return AiCreditUsageSchema.parse(await res.json())
  }

  /*
   * DIAGNOSTICS ONLY — ai_credit/usage for one login/day, UNPARSED.
   *
   * Feeds the wire-shape probe (server/diagnostics/). AiCreditUsageSchema defaults
   * six numeric fields and `usageItems`, so its parsed output reports keys the wire
   * may never have sent; the probe has to see the body first.
   *
   * PAT MODE ONLY, ASSERTED RATHER THAN ASSUMED. An App-mode client holds no PAT
   * (`withApp` passes ''), so `readRawPage` would have no credential to scrub out
   * of the error body and the "credentials removed" promise on that body would be
   * vacuous. The probe already declines to call this in App mode
   * (provider-wire-probe.ts reports 'not-configured' there, because the per-user
   * ai_credit endpoint is App-blocked), but that is a property of one caller, not
   * of this method — so the requirement is enforced here instead of depending on
   * a caller continuing to behave.
   *
   * The `user` param is returned unredacted here; the report redacts it.
   */
  async rawAiCreditUsagePage(
    login: string,
    date: { year: number; month: number; day: number },
  ): Promise<{ path: string; params: Array<[string, string]>; page: RawPage }> {
    if (this.appAuth || !this.pat) {
      throw createError({
        statusCode: 500,
        statusMessage: 'Internal Server Error',
        data: {
          type: 'https://tokenscope.example.com/errors/github-app-misconfig',
          title: 'Diagnostics method called on a client with no PAT',
          status: 500,
          detail:
            'rawAiCreditUsagePage is PAT-mode only: it returns a raw provider error body and can ' +
            'only promise to scrub a credential it actually holds.',
        },
      })
    }
    const url = this.aiCreditUsageUrl(login, date)
    const res = await resilientFetch(url, { headers: this.headers() }, this.fetchOpts)
    return {
      path: pathOf(url),
      params: paramPairsOf(url),
      page: await readRawPage(res, { secrets: [this.pat] }),
    }
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
    const res = await resilientFetch(this.userDailyCreditsUrl(day), { headers: this.appHeaders(token) }, this.fetchOpts)
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

  /** The users-1-day metrics-report URL. One builder for getUserDailyCredits and the
   *  probe below, so the diagnostic cannot describe a differently-shaped request than
   *  the one reconciliation issues (the aiCreditUsageUrl convention). */
  private userDailyCreditsUrl(day: string): string {
    return `${API_BASE}/enterprises/${encodeURIComponent(this.enterpriseSlug)}/copilot/metrics/reports/users-1-day?day=${encodeURIComponent(day)}`
  }

  /*
   * DIAGNOSTICS ONLY — the users-1-day report AND one of its NDJSON files, UNPARSED.
   *
   * Feeds the wire-shape probe (server/diagnostics/). getUserDailyCredits above
   * returns {login, credits} rows: MetricsReportSchema drops every envelope field it
   * does not declare, UserMetricsRecordSchema is passthrough but its output is thrown
   * away bar two fields, and `ai_credits_used` carries a `?? 0`. None of that can
   * answer "what does GitHub actually send", so this reads both bodies first.
   *
   * APP MODE ONLY — requireApp() throws for a PAT-mode client, like every other
   * App-mode method here.
   *
   * BOUNDED, and the bounds are RETURNED rather than applied silently: ONE report,
   * the FIRST of its download links, and at most `lineLimit` lines of that file. The
   * caller reports linksAvailable/linksRead/linesCapped so a partial read cannot be
   * mistaken for a census. The file is downloaded in full — the cap is on how many
   * lines are parsed and summarised, not on bytes transferred.
   *
   * WHAT THIS METHOD DOES AND DOES NOT PROMISE ABOUT THE SIGNED LINKS.
   * `download_links` entries are capability URLs — holding one IS access to the
   * per-user data — and they are handled in two different places, deliberately:
   *   - `envelope.body` is the report body VERBATIM, download_links included. That
   *     is the contract of every raw accessor here (readRawPage's header): a probe
   *     that pre-edited the body could not see what the provider actually sent, and
   *     an undeclared envelope key is half of what this surface exists to find. The
   *     body goes to the SHAPE SUMMARISER and nowhere else; withholding the values
   *     from the operator-facing report is wire-shape.ts's key denylist
   *     (CAPABILITY_KEY_SUBSTRINGS), which does it by key name and so does not
   *     depend on a link looking like a URL.
   *   - Everywhere this method CONSTRUCTS text, the link is a scrubbed secret: the
   *     download error body, and the network-throw path where the URL is known to
   *     ride along on the error (the same hazard getUserDailyCredits guards with a
   *     constant surface string). It is also absent from `path`/`params`, which
   *     describe step 1 only, and from `records`.
   * What IS returned from a failure is the provider's own scrubbed text, because a
   * classified reason hides the cause.
   */
  async rawUserDailyCreditsPage(day: string, opts: { lineLimit: number }): Promise<RawUserDailyCreditsPage> {
    const app = this.requireApp()
    const installationId = await app.enterpriseInstallationId(this.enterpriseSlug)
    if (installationId == null) this.fail('enterprises/{ent}/installation (no install)', 404)
    const token = await app.installationToken(installationId)
    const url = this.userDailyCreditsUrl(day)
    const res = await resilientFetch(url, { headers: this.appHeaders(token) }, this.fetchOpts)
    // The installation token is scrubbed from an error body for the same reason the
    // PAT is on the ai_credit accessor: this text is rendered to an operator.
    const envelope = await readRawPage(res, { secrets: [token] })
    const base = { path: pathOf(url), params: paramPairsOf(url), envelope }
    if (!envelope.ok) return { ...base, ndjson: null }

    const rawLinks = (envelope.body as { download_links?: unknown } | null)?.download_links
    const linksAvailable = Array.isArray(rawLinks) ? rawLinks.length : 0
    const read = (over: Partial<RawNdjsonRead>): RawUserDailyCreditsPage => ({
      ...base,
      ndjson: {
        linksAvailable,
        linksRead: 0,
        lineLimit: opts.lineLimit,
        linesRead: 0,
        linesCapped: false,
        linesUnparseable: 0,
        records: [],
        error: null,
        ...over,
      },
    })
    if (linksAvailable === 0) return read({})

    // The report is generated asynchronously and its links are signed, so a first
    // entry that is not an https URL is anomalous — never fetch it. The text says
    // what was wrong with it and deliberately does not quote it.
    const link = (rawLinks as unknown[])[0]
    if (typeof link !== 'string' || !link.startsWith('https://')) {
      return read({
        error: errorPageFrom(0, 'the first download_links entry is not an https:// string; it was not fetched.'),
      })
    }

    let dl: Response
    try {
      // Signed blob URL — send NO auth header (a bearer can break the pre-signed signature).
      dl = await resilientFetch(link, { headers: { 'User-Agent': 'tokenscope-reconciliation' } }, this.fetchOpts)
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      return read({ error: errorPageFrom(0, `signed-link download failed with no response :: ${detail}`, [link]) })
    }
    if (!dl.ok) {
      const body = await dl.text().catch(() => '<body could not be read>')
      return read({ error: errorPageFrom(dl.status, body, [link]) })
    }

    const text = await dl.text().catch(() => '')
    const records: unknown[] = []
    let linesRead = 0
    let linesUnparseable = 0
    let linesCapped = false
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (linesRead >= opts.lineLimit) {
        linesCapped = true
        break
      }
      linesRead += 1
      try {
        records.push(JSON.parse(line) as unknown)
      } catch {
        linesUnparseable += 1
      }
    }
    return read({ linksRead: 1, linesRead, linesCapped, linesUnparseable, records })
  }

  /*
   * Coverage detection (Workstream D, design §6): GET
   * /enterprises/{ent}/apps/installable_organizations — the enterprise's OWN org
   * census, "the organizations OWNED BY the enterprise" (GitHub's own description),
   * NOT merely orgs the App is not yet installed on. App mode ONLY: this endpoint
   * requires "Enterprise organization installations: read" on an ENTERPRISE
   * installation and has no PAT equivalent — requireApp() throws for a PAT-mode
   * client, exactly like the other App-only methods above.
   *
   * BOUNDED pagination mirrors pullSeats(): 100/page, a 100-page (10,000-org) HARD
   * CAP, using the SAME injectable fetchOpts (deadline/retry) as every other call on
   * this client. `pagesCapped` is surfaced, never swallowed — a capped pull is a
   * PREFIX of the enterprise's orgs, not the whole census, so the caller
   * (coverage-compute.ts) must not treat it as authoritative for an "N of M" claim
   * even though the pull itself succeeded (censusAvailable=true, capped=true).
   *
   * A non-OK response (401/403 = the permission is not granted; anything else =
   * transient/unknown) THROWS via fail() exactly like every other method here — this
   * client never itself decides granted/denied/unknown, so the classification stays
   * with the caller (matching the discover-orgs.post.ts / github-health.ts precedent
   * of pattern-matching the thrown createError's status, never re-implemented here).
   */
  async listInstallableOrganizations(): Promise<InstallableOrganizationsResult> {
    const app = this.requireApp()
    const installationId = await app.enterpriseInstallationId(this.enterpriseSlug)
    if (installationId == null) this.fail('enterprises/{ent}/installation (no install)', 404)
    const token = await app.installationToken(installationId)
    const out: Array<{ id: number; login: string }> = []
    let shortPageBreak = false
    let pagesCapped = false
    for (let page = 1; page <= 100; page++) {
      const res = await resilientFetch(
        `${API_BASE}/enterprises/${encodeURIComponent(this.enterpriseSlug)}/apps/installable_organizations?per_page=100&page=${page}`,
        { headers: this.appHeaders(token) },
        this.fetchOpts,
      )
      if (!res.ok) this.fail('enterprises/{ent}/apps/installable_organizations', res.status)
      const body = InstallableOrganizationsPageSchema.parse(await res.json())
      for (const o of body) out.push({ id: o.id, login: o.login })
      if (body.length < 100) {
        shortPageBreak = true
        break
      }
      if (page === 100) {
        // All 100 pages consumed at a full 100 orgs each — the hard cap was reached
        // with no natural end-of-census signal. The enterprise may own MORE orgs
        // beyond page 100 that were never fetched.
        pagesCapped = true
      }
    }
    return { organizations: out, pagesCapped, shortPageBreak }
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
   * GET /users/{login} — the PUBLIC profile (name + public email), for the "Unresolved Copilot
   * users" map picker only.
   *
   * SELF-ASSERTED, NEVER AN IDENTITY SOURCE. This is user-editable profile text, not a
   * provider attestation: anyone can set their profile email to a colleague's address. Binding
   * spend on it would be a claim-jacking vector, which is exactly why the identity resolver
   * reads SAML externalIdentities and nothing else. It exists here to spare an admin the
   * manual round-trip to github.com to find out who a login belongs to before mapping it — a
   * HINT for a human decision that the audit records. Callers must label it unverified.
   *
   * Both fields are frequently null (a private profile has neither), so consumers must degrade
   * rather than depend on it. Returns null when the profile cannot be read at all; a failure
   * here must never break the list it decorates.
   */
  async getUserProfile(login: string): Promise<{ name: string | null; email: string | null } | null> {
    let headers: Record<string, string>
    if (this.appAuth) {
      const installationId = await this.appAuth.enterpriseInstallationId(this.enterpriseSlug)
      if (installationId == null) return null
      headers = this.appHeaders(await this.appAuth.installationToken(installationId))
    } else {
      headers = this.headers()
    }
    const res = await resilientFetch(
      `${API_BASE}/users/${encodeURIComponent(login)}`,
      { headers },
      this.fetchOpts,
    )
    if (!res.ok) return null
    const parsed = UserProfileSchema.safeParse(await res.json())
    if (!parsed.success) return null
    return { name: parsed.data.name ?? null, email: parsed.data.email ?? null }
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
