/*
 * Entra directory client — the people-picker behind admin teammate
 * provisioning.
 *
 * The `tokenattribution-dev` app registration already holds Microsoft Graph
 * `User.Read.All` (Application, admin-consented for Insight) and is the SAME
 * confidential client that runs OIDC sign-in. So we mint an APP-ONLY Graph
 * token via the client-credentials grant using the OIDC client id/secret that
 * Bicep already wires into the container — no new secret, no new consent.
 *
 * App-only (client-credentials) is correct here: a people-picker reads the
 * whole directory, not "the signed-in user's view", and runs server-side on
 * an admin request. The Graph token never reaches the browser.
 *
 * Modes (NUXT_GRAPH_DIRECTORY_MODE):
 *   - 'graph' → real: client-credentials token + Graph /users query. Needs the
 *               OIDC client id/secret/token-url present (sandbox/prod).
 *   - else    → deterministic MOCK directory (local dev + tests, off-Azure).
 *               Mirrors the obo.ts mock seam so the full provision flow runs
 *               without Entra.
 *
 * Security: callers MUST treat the directory as the source of truth for a
 * teammate's identity. The provision endpoint re-resolves the picked oid via
 * getDirectoryUserByOid() rather than trusting the client-supplied email /
 * display name (which would be spoofable).
 */
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default'

function graphBaseUrl(): string {
  return process.env.NUXT_GRAPH_BASE_URL?.replace(/\/$/, '') ?? 'https://graph.microsoft.com/v1.0'
}

// Read mode at call time (not module load) so tests can flip it per-case —
// same pattern as obo.ts / jit-teammate.ts.
function isRealGraph(): boolean {
  return process.env.NUXT_GRAPH_DIRECTORY_MODE === 'graph'
}

export interface DirectoryUser {
  oid: string
  email: string
  displayName: string
  // Identity PROVENANCE (issue #121): `email` collapses mail??upn, which erases
  // the distinction consumers need for same-human decisions. Entra guarantees
  // uniqueness per-namespace (UPNs among UPNs, proxy addresses among proxy
  // addresses) but NOT across them — user A's UPN may equal user B's mail. So
  // "same mailbox = same human" reasoning must compare TRUE mail to TRUE mail,
  // never the collapsed field. Both normalized lowercase; mail is null when the
  // account has no mail attribute.
  mail: string | null
  upn: string | null
  department: string | null
  jobTitle: string | null
  // Geo/entity attributes for configurable region derivation (mig 0089). Any of
  // these can drive a region rule (shared/placement/region-attributes.ts); which
  // one is region-correlated is tenant-specific (companyName at Insight).
  companyName: string | null
  country: string | null
  officeLocation: string | null
  state: string | null
  // J4: Entra employeeOrgData — the finance-side placement hints. Soft
  // dependency: whether the tenant POPULATES these is unverified (see
  // docs/design/entra-auto-placement.md), so they are suggestion-grade,
  // surfaced in the people-picker, never used for automatic placement.
  costCenter: string | null
  division: string | null
}

// ── App-only token cache (one shared token; app-level, like obo.ts) ──
const REFRESH_SKEW_MS = 5 * 60 * 1000
let cached: { token: string; expiresAtMs: number } | null = null
let inFlight: Promise<{ token: string; expiresAtMs: number }> | null = null

/** Test seam — reset the token cache. */
export function _resetGraphTokenCache(): void {
  cached = null
  inFlight = null
}

function jwtExpMs(token: string): number | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

async function mintGraphToken(): Promise<{ token: string; expiresAtMs: number }> {
  const clientId = process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID
  const clientSecret = process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_SECRET
  const tokenUrl = process.env.NUXT_OIDC_PROVIDERS_ENTRA_TOKEN_URL
  if (!clientId || !clientSecret || !tokenUrl) {
    throw new Error(
      'Graph directory in real mode needs NUXT_OIDC_PROVIDERS_ENTRA_{CLIENT_ID,CLIENT_SECRET,TOKEN_URL}.',
    )
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: GRAPH_SCOPE,
    grant_type: 'client_credentials',
  })
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    // Don't leak the response body (may echo client_id); surface status only.
    throw new Error(`Graph client-credentials token mint failed (${res.status}).`)
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!json.access_token) throw new Error('Graph token response had no access_token.')
  const expFromJwt = jwtExpMs(json.access_token)
  const expiresAtMs =
    expFromJwt ?? Date.now() + (json.expires_in ?? 3600) * 1000
  return { token: json.access_token, expiresAtMs }
}

async function getGraphToken(): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > now) return cached.token
  // Single-flight: collapse concurrent cold-start mints onto one request.
  if (!inFlight) {
    inFlight = mintGraphToken().finally(() => {
      inFlight = null
    })
  }
  cached = await inFlight
  return cached.token
}

async function graphGet<T>(path: string, search: URLSearchParams, advanced = false): Promise<T> {
  const token = await getGraphToken()
  const url = `${graphBaseUrl()}${path}?${search.toString()}`
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  // $search / $count on /users are advanced queries → ConsistencyLevel: eventual.
  if (advanced) headers['ConsistencyLevel'] = 'eventual'
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`Graph request failed (${res.status}) for ${path}.`)
  return (await res.json()) as T
}

interface GraphUser {
  id: string
  displayName: string | null
  mail: string | null
  userPrincipalName: string | null
  department: string | null
  jobTitle: string | null
  // Geo/entity attributes for region derivation — all standard v1.0 `User`
  // properties under the existing User.Read.All (no new scope).
  companyName: string | null
  country: string | null
  officeLocation: string | null
  state: string | null
  employeeOrgData?: { costCenter: string | null; division: string | null } | null
}

// The 4 geo/entity attributes ride the base select — they are standard, widely
// populated User props (unlike employeeOrgData). Per-field $select degradation
// (drop only an offending field vs the all-or-nothing latch below) is a noted
// fast-follow; risk is low because these are base User properties.
const SELECT_BASE =
  'id,displayName,mail,userPrincipalName,department,jobTitle,companyName,country,officeLocation,state'
// employeeOrgData (costCenter/division) rides User.Read.All on v1.0, but
// tenant population is unverified — and a tenant policy could reject the
// property in $select. Degrade once per process rather than failing the
// picker (see orgDataUnavailable below).
const SELECT_EXT = `${SELECT_BASE},employeeOrgData`
let orgDataUnavailable = false

/** Test seam — reset the employeeOrgData degradation latch. */
export function _resetOrgDataLatch(): void {
  orgDataUnavailable = false
}

function activeSelect(): string {
  return orgDataUnavailable ? SELECT_BASE : SELECT_EXT
}

function toDirectoryUser(u: GraphUser): DirectoryUser {
  return {
    oid: u.id,
    // mail can be null for some accounts; UPN is the durable fallback.
    email: (u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
    mail: u.mail?.toLowerCase() ?? null,
    upn: u.userPrincipalName?.toLowerCase() ?? null,
    displayName: u.displayName ?? u.mail ?? u.userPrincipalName ?? u.id,
    department: u.department ?? null,
    jobTitle: u.jobTitle ?? null,
    companyName: u.companyName ?? null,
    country: u.country ?? null,
    officeLocation: u.officeLocation ?? null,
    state: u.state ?? null,
    costCenter: u.employeeOrgData?.costCenter ?? null,
    division: u.employeeOrgData?.division ?? null,
  }
}

// ── Mock directory (local dev + tests) ──────────────────────────────────
// A small deterministic roster so the picker + provision flow run off-Azure.
// Distinct from the 4 demo login personas so it's obvious these come from
// "the directory", not the seed.
//
// `userPrincipalName` mirrors the real Graph field so the #EXT# guest guard
// (searchDirectory / getDirectoryUserByMailOrUpn / getDirectoryUserByOid) is
// exercised in mock mode too — a B2B guest must be un-pickable everywhere.
type MockDirectoryUser = DirectoryUser & { userPrincipalName: string }
const MOCK_DIRECTORY: MockDirectoryUser[] = [
  { oid: 'dir-oid-0001', email: 'sasha.kumar@example.com', mail: 'sasha.kumar@example.com', upn: 'sasha.kumar@example.com', userPrincipalName: 'sasha.kumar@example.com', displayName: 'Sasha Kumar', department: 'APAC Digital', jobTitle: 'Senior Engineer', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  { oid: 'dir-oid-0002', email: 'tom.becker@example.com', mail: 'tom.becker@example.com', upn: 'tom.becker@example.com', userPrincipalName: 'tom.becker@example.com', displayName: 'Tom Becker', department: 'EMEA Data & AI', jobTitle: 'Engineer', companyName: 'Insight United Kingdom', country: 'United Kingdom', officeLocation: 'UK-London', state: null, costCenter: 'CC-2210 Data EMEA', division: 'Services' },
  { oid: 'dir-oid-0003', email: 'mei.lin@example.com', mail: 'mei.lin@example.com', upn: 'mei.lin@example.com', userPrincipalName: 'mei.lin@example.com', displayName: 'Mei Lin', department: 'APAC Digital', jobTitle: 'Practice Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  { oid: 'dir-oid-0004', email: 'carlos.ferreira@example.com', mail: 'carlos.ferreira@example.com', upn: 'carlos.ferreira@example.com', userPrincipalName: 'carlos.ferreira@example.com', displayName: 'Carlos Ferreira', department: 'US Cloud', jobTitle: 'Architect', companyName: 'Insight USA', country: 'United States', officeLocation: 'US-Chicago', state: null, costCenter: null, division: null },
  { oid: 'dir-oid-0005', email: 'nadia.haddad@example.com', mail: 'nadia.haddad@example.com', upn: 'nadia.haddad@example.com', userPrincipalName: 'nadia.haddad@example.com', displayName: 'Nadia Haddad', department: 'EMEA Data & AI', jobTitle: 'Engineering Manager', companyName: 'Insight United Kingdom', country: 'United Kingdom', officeLocation: 'UK-London', state: null, costCenter: 'CC-2210 Data EMEA', division: 'Services' },
  { oid: 'dir-oid-0006', email: 'james.oconnor@example.com', mail: 'james.oconnor@example.com', upn: 'james.oconnor@example.com', userPrincipalName: 'james.oconnor@example.com', displayName: "James O'Connor", department: 'APAC Digital', jobTitle: 'Engineer', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4310 Digital APAC', division: 'Services' },
  // DUAL-IDENTITY PAIR (issue #121, the Rob O'Connor shape): one human with a
  // standard `@example.com` account (dir-oid-0007) AND a privileged/CLD account
  // (dir-oid-0007-cld) whose UPN is on the tenant `*.onmicrosoft.com` domain.
  // The CLD account is NOT spend-bearing; the directory-exclusion policy
  // (mig 0083) is what keeps it un-pickable — when an admin configures a pattern
  // like `*@contoso.onmicrosoft.com`. Out of the box (no patterns) BOTH
  // are pickable (fail-open). Exercised by the exclusion tests.
  { oid: 'dir-oid-0007', email: 'rio.tanaka@example.com', mail: 'rio.tanaka@example.com', upn: 'rio.tanaka@example.com', userPrincipalName: 'rio.tanaka@example.com', displayName: 'Rio Tanaka', department: 'APAC Cyber Security', jobTitle: 'Security Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4520 Cyber APAC', division: 'Services' },
  { oid: 'dir-oid-0007-cld', email: 'rtanaka-cld@contoso.onmicrosoft.com', mail: null, upn: 'rtanaka-cld@contoso.onmicrosoft.com', userPrincipalName: 'rtanaka-cld@contoso.onmicrosoft.com', displayName: 'Rio Tanaka (CLD)', department: 'APAC Cyber Security', jobTitle: 'Security Lead', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: 'CC-4520 Cyber APAC', division: 'Services' },
  // A genuinely cloud-only real user whose ONLY identity is on the onmicrosoft
  // domain (no `@example.com` twin). Proves the portable default is EMPTY: with
  // no exclusion pattern configured this user stays pickable; a blanket
  // `*@*.onmicrosoft.com` default would wrongly exclude them (why we don't ship one).
  { oid: 'dir-oid-0008', email: 'kai.wong@contoso.onmicrosoft.com', mail: null, upn: 'kwong@contoso.onmicrosoft.com', userPrincipalName: 'kwong@contoso.onmicrosoft.com', displayName: 'Kai Wong', department: 'APAC Digital', jobTitle: 'Consultant', companyName: 'Insight Australia', country: 'Australia', officeLocation: 'AU-Sydney', state: null, costCenter: null, division: null },
  // A B2B GUEST (partner/client/vendor invited into the tenant): #EXT# UPN.
  // Must NEVER be pickable/provisionable as a teammate.
  { oid: 'dir-oid-9001', email: 'partner@vendor.example', mail: 'partner@vendor.example', upn: 'partner_vendor.example#ext#@contoso.onmicrosoft.com', userPrincipalName: 'partner_vendor.example#EXT#@contoso.onmicrosoft.com', displayName: 'Partner Guest', department: null, jobTitle: null, companyName: null, country: null, officeLocation: null, state: null, costCenter: null, division: null },
]

const isGuestUpn = (upn: string | null | undefined): boolean => (upn ?? '').toUpperCase().includes('#EXT#')

function mockSearch(query: string, limit: number): DirectoryUser[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return MOCK_DIRECTORY.filter(
    (u) => !isGuestUpn(u.userPrincipalName) && (u.displayName.toLowerCase().includes(q) || u.email.includes(q)),
  ).slice(0, limit)
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Search the directory by name or email. Returns up to `limit` matches.
 * Empty/blank query → []. The query is treated as a free-text prefix/substring;
 * in real mode it drives Graph $search over displayName + mail.
 */
export async function searchDirectory(query: string, limit = 15): Promise<DirectoryUser[]> {
  const q = query.trim()
  if (!q) return []
  if (!isRealGraph()) return mockSearch(q, limit)

  // $search wants quoted phrases; strip embedded quotes so we can't break out
  // of the search expression.
  const safe = q.replace(/"/g, '')
  const mkParams = () =>
    new URLSearchParams({
      $search: `"displayName:${safe}" OR "mail:${safe}"`,
      $select: activeSelect(),
      $top: String(Math.min(Math.max(limit, 1), 50)),
    })
  // Exclude B2B GUEST accounts (#EXT# UPNs). The people-picker assigns Insight
  // region leaders / cost-centre owners / teammates — all EMPLOYEES — so a
  // partner/client/vendor guest invited into the tenant directory must never be
  // pickable. Mirrors the guest guard in getDirectoryUserByMailOrUpn (M1).
  const employeesOnly = (rows: GraphUser[]) =>
    rows.filter((u) => !(u.userPrincipalName ?? '').toUpperCase().includes('#EXT#'))
  try {
    const json = await graphGet<{ value: GraphUser[] }>('/users', mkParams(), true)
    return employeesOnly(json.value ?? []).map(toDirectoryUser)
  } catch (err) {
    // employeeOrgData being REJECTED (a 400 — tenant policy / property not
    // permitted in $select) must not break the picker: latch the
    // degradation and retry with the base property set. Transient errors
    // (throttle, 5xx, network) propagate untouched (R2 F4) — latching on
    // those would silently strip the hints for the process lifetime.
    const isSelectRejection =
      !orgDataUnavailable && err instanceof Error && err.message.includes('(400)')
    if (!isSelectRejection) throw err
    orgDataUnavailable = true
    const json = await graphGet<{ value: GraphUser[] }>('/users', mkParams(), true)
    return employeesOnly(json.value ?? []).map(toDirectoryUser)
  }
}

/**
 * Resolve a single directory user by EXACT email / UPN — for bill-driven placement,
 * which has an email (the provider-attested bill identity) but no oid. Requires
 * EXACTLY ONE non-guest match (M1, adversarial review): a fuzzy `searchDirectory`
 * could bind a bill (and someone's spend) to an alias / a guest (`#EXT#`) / a
 * displayName substring. 0 or >1 hits, or only a guest → null (caller leaves the
 * user unplaced, enriched only by the bill email — never a guessed identity).
 */
/**
 * Sample up to `limit` directory users for the region-attribute field-distribution
 * diagnostic. BEST-EFFORT, re-runnable, NOT a guaranteed-random sample — Graph
 * returns its default ordering, so on a large tenant the first page may skew.
 * Employees only (guests excluded). One page (no nextLink paging) — the diagnostic
 * is a directional "which attribute correlates to region", not a census.
 * TODO(fast-follow): 429 backoff in graphGet; per-field $select degradation.
 */
export async function sampleDirectoryUsers(limit = 200): Promise<DirectoryUser[]> {
  const top = Math.min(Math.max(limit, 1), 999)
  const notGuest = (u: GraphUser | MockDirectoryUser) =>
    !((u as { userPrincipalName?: string | null }).userPrincipalName ?? '').toUpperCase().includes('#EXT#')
  if (!isRealGraph()) return MOCK_DIRECTORY.filter(notGuest).slice(0, top)
  const mkParams = () => new URLSearchParams({ $select: activeSelect(), $top: String(top) })
  try {
    const json = await graphGet<{ value: GraphUser[] }>('/users', mkParams())
    return (json.value ?? []).filter(notGuest).map(toDirectoryUser)
  } catch (err) {
    const isSelectRejection = !orgDataUnavailable && err instanceof Error && err.message.includes('(400)')
    if (!isSelectRejection) throw err
    orgDataUnavailable = true
    const json = await graphGet<{ value: GraphUser[] }>('/users', mkParams())
    return (json.value ?? []).filter(notGuest).map(toDirectoryUser)
  }
}

export async function getDirectoryUserByMailOrUpn(email: string): Promise<DirectoryUser | null> {
  const e = email.trim().toLowerCase()
  if (!e || !e.includes('@')) return null
  if (!isRealGraph()) {
    const hits = MOCK_DIRECTORY.filter((u) => u.email.toLowerCase() === e && !isGuestUpn(u.userPrincipalName))
    return hits.length === 1 ? hits[0]! : null
  }
  // Escape single quotes for the OData string literal (' → '').
  const lit = e.replace(/'/g, "''")
  const params = new URLSearchParams({
    $filter: `mail eq '${lit}' or userPrincipalName eq '${lit}'`,
    $select: activeSelect(),
    $top: '2', // we only ever accept exactly 1; 2 lets us DETECT ambiguity
  })
  try {
    const json = await graphGet<{ value: GraphUser[] }>('/users', params, true)
    const rows = (json.value ?? []).filter((u) => !(u.userPrincipalName ?? '').toUpperCase().includes('#EXT#'))
    return rows.length === 1 ? toDirectoryUser(rows[0]!) : null
  } catch {
    return null
  }
}

// Mock manager edges (local dev + tests off-Azure): a small chain over MOCK_DIRECTORY
// so the manager-walk fallback can run without Entra. Sasha → Mei (lead) → Nadia (EM);
// James → Mei. Others have no manager (top of chart → null).
const MOCK_MANAGER_EDGES: Record<string, { oid: string; email: string }> = {
  'dir-oid-0001': { oid: 'dir-oid-0003', email: 'mei.lin@example.com' },
  'dir-oid-0006': { oid: 'dir-oid-0003', email: 'mei.lin@example.com' },
  'dir-oid-0003': { oid: 'dir-oid-0005', email: 'nadia.haddad@example.com' },
}

/**
 * Resolve a user's manager (mig 0068 region-derivation fallback): the `/users/{id}/manager`
 * navigation. Returns `{ oid, email }` or null at the top of the org chart / when the user
 * has no manager. Rides the SAME app-only `User.Read.All` (proven app-only on the Insight
 * tenant by AEUF). 404 → null (terminate the walk cleanly); ANY OTHER error PROPAGATES so
 * the caller aborts and retries next tick — a transient miss must never be cached as a
 * real top-of-chart null.
 */
export async function getUserManager(oid: string): Promise<{ oid: string; email: string | null } | null> {
  if (!isRealGraph()) {
    return MOCK_MANAGER_EDGES[oid] ?? null
  }
  const search = new URLSearchParams({ $select: 'id,mail,userPrincipalName' })
  try {
    const u = await graphGet<{ id?: string; mail?: string | null; userPrincipalName?: string | null }>(
      `/users/${encodeURIComponent(oid)}/manager`,
      search,
    )
    if (!u || !u.id) return null
    const email = (u.mail ?? u.userPrincipalName ?? '').toLowerCase() || null
    return { oid: u.id, email }
  } catch (err) {
    // 404 = no manager (top of chart) or user-not-found → null. Throttle / 5xx / network
    // PROPAGATE (per-user worker isolation retries) and are NEVER cached as a real miss.
    if (err instanceof Error && /\(404\)/.test(err.message)) return null
    throw err
  }
}

/**
 * Resolve a single directory user by their Entra object id (oid). Returns null
 * if the oid isn't found. This is the SERVER-SIDE source of truth used when
 * provisioning a teammate — never trust a client-supplied email/displayName.
 *
 * Rejects B2B GUEST accounts (#EXT# UPNs) → null: a partner/client/vendor guest
 * invited into the tenant directory must never be pickable/provisionable as an
 * Insight teammate. Mirrors the guest guard in searchDirectory /
 * getDirectoryUserByMailOrUpn (M1), closing the oid→provision path too.
 */
export async function getDirectoryUserByOid(oid: string): Promise<DirectoryUser | null> {
  if (!isRealGraph()) {
    const hit = MOCK_DIRECTORY.find((u) => u.oid === oid) ?? null
    return hit && !isGuestUpn(hit.userPrincipalName) ? hit : null
  }
  const search = new URLSearchParams({ $select: activeSelect() })
  try {
    const u = await graphGet<GraphUser>(`/users/${encodeURIComponent(oid)}`, search)
    if (!u || !u.id) return null
    // Guest guard: treat an #EXT# UPN as not-found (callers 404/handle null).
    if (isGuestUpn(u.userPrincipalName)) return null
    return toDirectoryUser(u)
  } catch {
    // 404 (unknown oid) and transient errors both surface as null → the
    // caller returns a clean 404/422 rather than a 500.
    return null
  }
}
