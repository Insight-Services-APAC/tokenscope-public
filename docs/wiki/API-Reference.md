# API Reference

This is the as-built HTTP API of the running TokenScope app — a Nuxt 3 / Nitro
service whose server routes live under `server/api/v1/**`. It is the contract
the dashboard, the Claude Code plugin, and the background scheduler actually
call today. Surfaces that were designed but not yet built are listed separately
at the end and clearly marked.

Every application route is published under an explicit `/api/v1/...` prefix —
there is no implicit-v1 fallback and no v2. The single exception is
`GET /api/health`, which is non-versioned by convention because it describes
infrastructure rather than the app contract.

## Auth model in one paragraph

TokenScope mixes four authentication schemes by surface. **Browser calls** ride
a `nuxt-oidc-auth` cookie session (Entra OIDC), decrypted and DB-enriched lazily
via `requireAuth`/`tryAuth`; every state-changing browser method additionally
requires a same-origin CSRF check (`assertSameOrigin` — GET/HEAD/OPTIONS pass,
an Origin/Referer mismatch is 403'd, and a both-absent request from a CLI or
server is allowed because it cannot ride a stolen cookie). **MCP / CLI** clients
authenticate over **OAuth 2.1**: a client-initiated PKCE consent (the
`/api/v1/oauth/*` flow + the `/api/v1/mcp` server) grants `tokenscope.read` +
`tokenscope.tag` for the MCP tools, and the read-scoped `provision_emit` tool
returns a short-TTL one-time handoff code redeemed locally at
`/api/v1/setup/redeem` for the durable emit credential (the secret never crosses
the LLM). The legacy setup-token enrolment (`/me/setup-token` + `/setup/exchange`)
was **retired** by the MCP-first OAuth cutover (PR #38; `setup_token` dropped in
migration 0034). **Emission telemetry** (the bearer-refresh and session-lifecycle
endpoints) authenticates with a short-lived OAuth `tokenscope.emit` access token
as an `Authorization: Bearer <token>`; the Azure Monitor ingest token it returns
is an app-level **Managed Identity** token, not per-developer OAuth.
**The internal worker trigger** is machine-to-machine **HMAC-SHA-256**, with a
key isolated from the session HMAC. RBAC is enforced on top via
`requireRole(event, ...roles)` and region clamping via `requireRegionScope`.
A front-door middleware rejects any request lacking a matching `X-Azure-FDID`
header when `AZURE_FRONT_DOOR_ID` is set (`/api/health` excepted). In a
VNet-integrated deployment the ACA environment is internal behind an upstream
WAF, so that env is unset and the middleware is inert — the VNet perimeter is the
edge control.

**RBAC roles** (`shared/auth/roles.ts`):
`developer | manager | admin | global-finops | platform-admin` (plus `finance`,
retired/unassignable — excluded from `SELECTABLE_ROLES`, kept in the enum for
historical rows). `platform-admin` is the cross-region super-admin and satisfies
every `requireRole` gate; `admin` (label "Region admin") is the region-scoped
admin (bounded by `requireRegionScope`); `global-finops` (label "Global finance")
is the org-wide finance/super-finance role.

## Errors

All handlers throw `createError(...)` carrying an **RFC-9457 Problem Details**
body under `data`: `{ type, title, status, detail }`. Type URIs use the
`https://tokenscope.example.com/errors/<slug>` namespace (e.g.
`.../errors/not-a-member`). The h3 dispatcher writes the response envelope.

See also: [Authentication & Security](Authentication-and-Security.md),
[Data Model](Data-Model.md).

---

## MCP server & OAuth 2.1 (the client backbone)

The implemented Claude Code attribution path is an **MCP-first OAuth** flow
(PR #37 backbone + PR #38 cutover). The plugin registers a remote MCP server at
`/api/v1/mcp`; one browser PKCE consent grants `tokenscope.read` + `tokenscope.tag`
for the tools, and device emit is provisioned via a secret-isolating handoff
(`provision_emit` → `/api/v1/setup/redeem`). This **replaced** the retired
setup-token enrolment (`/me/setup-token` + `/setup/exchange`, deleted; `setup_token`
dropped in migration 0034).

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| ANY | `/api/v1/mcp` | OAuth Bearer (`tokenscope.read`/`tag`) | The Streamable-HTTP MCP server. A request with no/invalid token → 401 + `WWW-Authenticate` pointing at the protected-resource metadata. Exposes tools (`list_my_projects`, `list_activity_types`, `my_usage`, `tag_session`, `resolve_repo_project`, `provision_emit`) and prompts (`tokenscope-setup`, `tag`, `project`, `usage`). |
| GET | `/api/v1/oauth/authorize` | Entra cookie session | Gates the user's Entra session, validates `client_id`/`redirect_uri`, then 302s the browser to the consent page (`/oauth/authorize.vue`). |
| POST | `/api/v1/oauth/authorize` | cookie + CSRF (same-origin) | The consent grant: on `Accept: application/json` returns `{ redirect_url }` (callback carrying code+state) as data; on a form post, 302s. Reuses `issueAuthCode` (teammate-bound, PKCE-carried). Handles deny. |
| POST | `/api/v1/oauth/token` | PKCE code / refresh token | Exchange an authorization code (+ verifier) or refresh token for an access token (RFC 6749 + 7636). Non-rotating refresh (ADR-0005). |
| POST | `/api/v1/oauth/register` | none (RFC 7591) | Dynamic client registration; always writes a non-internal client. |
| POST | `/api/v1/oauth/revoke` | client-creds + raw token (RFC 7009) | Client-side token revocation (the machine path; the user-facing revoke is `/me/grants/{id}/revoke`). |
| POST | `/api/v1/setup/redeem` | handoff code = auth | Redeem the one-time, ~5-minute emit-provisioning handoff minted by `provision_emit` (atomic single-use, no cookie/CSRF) for the durable emit credential + the Claude OTel telemetry bundle. The durable secret is fetched here process→server, never over MCP. |
| POST | `/api/v1/setup/enroll` | bundled enrollment secret = auth | The **no-login, emit-on-install** enroll path (a separate mechanism from the retired setup-token exchange — that retirement stands): a privately-distributed plugin bundles a rotatable enrollment secret and calls this on install (no OAuth, no human) to mint a durable emit-only credential + the OTel bundle, bound to a server-chosen instance and a **provisional** shadow teammate keyed on the claimed email. A bad/expired secret is the only 401 (no existence oracle); response shape is constant regardless of whether the email exists. Usage emits immediately as `identity_state=provisional` until the human signs in and confirms. |

Discovery metadata is served at the origin root:
`GET /.well-known/oauth-authorization-server` (RFC 8414) and
`GET /.well-known/oauth-protected-resource/...` (RFC 9728).

## Sessions

The instance (device) telemetry lifecycle: bearer refresh for ingest, and
session teardown. The bearer/end endpoints authenticate with the short-lived
OAuth `tokenscope.emit` access token, not the cookie.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/instances/{instanceId}/bearer` | OAuth emit Bearer | Mint/return an app-level Managed-Identity Azure Monitor ingest token for Claude's `otelHeadersHelper` (single-header `{ Authorization }` shape). Each mint is an authenticated heartbeat (owner-checked) and stamps grant activity. |
| POST | `/api/v1/instances/{instanceId}/end` | OAuth emit Bearer | End an instance (sets `ts_actual_end`); idempotent, returns 204. |
| DELETE | `/api/v1/instances/{instanceId}` | cookie + CSRF + `admin` + region scope | Admin force-end of an instance bound to its region; returns 204. |

## Me / self-service

The signed-in user's own surface. All reads use `requireAuth` (cookie/OIDC);
state-changing methods add CSRF. Identity resolution spans the primary
`teammate.email` plus linked `teammate_identity_map` rows.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/me/usage` | cookie/OIDC | Month-to-date project-bucket split (cost, tokens, allocation, `is_active_now`, source, freshness). |
| GET | `/api/v1/me/projects` | cookie/OIDC | Projects the caller is a current member of (powers the quick-assign picker). |
| GET | `/api/v1/me/sessions/recent` | cookie/OIDC | Caller's recent attested sessions with summed tokens/cost (`limit` default 10, max 50). |
| GET | `/api/v1/me/sessions/recent/export` | cookie/OIDC | Same as CSV, formula-injection-escaped (`limit` default 100, max 500). |
| GET | `/api/v1/me/sessions/untagged` | cookie/OIDC | Caller's recent OTel sessions not yet attributed to a project (the retroactive-tagging worklist). |
| POST | `/api/v1/me/sessions/{sid}/assign` | cookie/OIDC + CSRF | Retroactively tag an untagged session to a project (triple gate: project exists, caller is a member, session email is one of the caller's identities); attribution runs on the next scheduled tick. |
| GET | `/api/v1/me/grants` | cookie/OIDC | The caller's own authorized OAuth connections (`oauth_token` rows): client name, plain-language scopes, derived state (active/inactive/revoked/expired), `created_at`, `last_used_at`, and `is_emit`. Owner-scoped. |
| POST | `/api/v1/me/grants/{id}/revoke` | cookie/OIDC + CSRF | Revoke one of the caller's own grants (404 if not theirs). Revoking an emit grant also ends its instance so the silence is expected. |
| GET | `/api/v1/me/quarantined-spend` | cookie/OIDC | The caller's sessions whose spend lacks covering emit-heartbeats ("unverified spend") pending reconciliation. |
| GET | `/api/v1/me/identities` | cookie/OIDC | Caller's primary email plus linked identity-map rows (with `verified`, `source`). |
| POST | `/api/v1/me/identities` | cookie/OIDC + CSRF | Self-link another identity (Claude/GitHub/client email) so its spend attributes to the caller; rows are `source='self'`, unverified, audited. |
| DELETE | `/api/v1/me/identities/{id}` | cookie/OIDC + CSRF | Unlink one of the caller's own identity rows (the primary email is not a map row and cannot be removed here). |
| GET | `/api/v1/me/inbox` | cookie/OIDC | List the caller's inbox items (filters: `ack_state` incl. open/closed shorthand, `category`, `severity`, `limit`). |
| PATCH | `/api/v1/me/inbox/{id}` | cookie/OIDC + CSRF | Change `ack_state` (read/acknowledged/dismissed/resolved) on one's own item; audited. |
| POST | `/api/v1/me/inbox/{id}/route` | `admin`/`global-finops` + CSRF | Forward an inbox item to another (active) recipient and resolve the source; audited. |
| GET | `/api/v1/me/consumption` | cookie/OIDC | The caller's own consumption/quota view (teammate-scoped, over the same usage math as `/me/usage`). |
| GET | `/api/v1/me/cost-centres` | cookie/OIDC | Cost centres the caller belongs to (self-scoped). |
| GET | `/api/v1/me/activity-types` | cookie/OIDC | Activity types visible to the caller (for self-tagging). |
| GET | `/api/v1/me/projects/summary` | cookie/OIDC | Summary rollup across the caller's projects. |
| GET | `/api/v1/me/projects/{code}` | cookie/OIDC | Detail for one of the caller's projects, keyed by project code. |
| GET | `/api/v1/me/instances` | cookie/OIDC | The caller's own enrolled instances/devices. |
| GET | `/api/v1/me/sessions/{sid}` | cookie/OIDC | Detail for one of the caller's own sessions. |

## Allocations (governance)

CRUD for project budget pools. All gated `requireRole('manager','admin','global-finops')`,
with project/region/org-subtree scoping; write methods add CSRF and emit audit
events.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/allocations` | `manager`/`admin`/`global-finops` | List allocations in the caller's scope. |
| POST | `/api/v1/allocations` | `manager`/`admin`/`global-finops` + CSRF | Create the baseline budget pool (first allocation flips the project `is_onboarded`); overlapping baseline period returns a clean 409. |
| GET | `/api/v1/allocations/{id}` | `manager`/`admin`/`global-finops` | Focused row plus siblings, project metadata, assigned devs, top-up history, and last-5 audit trail. |
| PATCH | `/api/v1/allocations/{id}` | `manager`/`admin`/`global-finops` + CSRF | Edit the allocation row (writes row plus audit event). |
| POST | `/api/v1/allocations/{id}/split` | `manager`/`admin`/`global-finops` + CSRF | Set allocation mode and per-developer caps. |
| POST | `/api/v1/allocations/{id}/topups` | `manager`/`admin`/`global-finops` + CSRF | Append a top-up row to the allocation. |

## Rollups & project reads

Aggregated read surfaces for finance and managers. (The plugin's project
resolver and repo-tagging now run over MCP — `list_my_projects` and
`resolve_repo_project` on the `/api/v1/mcp` server — so the old
`GET /api/v1/projects/search` and `GET /api/v1/projects/resolve-by-repo` REST
routes were removed in the cutover.)

(The `/api/v1/rollups/finance*` surface was retired in the reporting-consolidation
cutover — the finance pack now lives under [Reports](#reports-the-reporting-shell)
as `/api/v1/reports/finance`.)

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/rollups/manager` | `manager`/`admin`/`global-finops` | Per-teammate and per-project rollups for the manager's org scope. |
| GET | `/api/v1/rollups/practice/{ouId}/velocity` | `manager`/`admin`/`global-finops` | Velocity baseline signal feeding the manager rollup's Signal column. |
| GET | `/api/v1/rollups/org-tree` | any role (`developer`…`platform-admin`) | Org-unit tree rollup, scoped to the caller's own subtree. |
| GET | `/api/v1/rollups/practice/{ouId}` | any role (`developer`…`platform-admin`) | Practice/org-unit rollup for one org-unit id (scope-clamped). |
| GET | `/api/v1/projects/{id}/consumption` | `manager`/`admin`/`global-finops` | MTD consumption for a project regardless of caller assignment (org-subtree clamped; out-of-scope id returns 0). |

## Reports (the reporting shell)

The consolidated `/reporting` shell reads from `server/api/v1/reports/**`. Every
route is `requireAuth` (identity), then **scoped by the report-visibility
policy** — the granted scopes per persona are the RBAC default (`standard`)
unless an admin has loosened the org-wide mode (see
[Report-visibility policy](Authentication-and-Security.md#report-visibility-policy-report-scoping)).
`GET /reports/meta` returns only the **granted** scopes and drives which tabs
render. The across-regions and finance routes enforce with `requireReportScope`
(loosened modes flip a region admin / cost-centre owner's `403`→`200`); the
regional and cost-centre routes take a policy-computed `crossRegion` /
`unbounded` flag. All reads hit views / aggregate tables only (the lane
firewall) — no raw `attribution_record`.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/reports/meta` | `requireAuth` | Bootstrap: granted scopes (policy-derived), best-default scope, region default, month floors, provider settling states, copilot mode. |
| GET | `/api/v1/reports/regional` (+ `/trend`, `/active-trend`, `/drivers`, `/seasonality`) | `requireAuth` + regional scope | Regional usage/spend for the caller's region (cross-region roles, and admins under a loosened mode, may pass `?region=`). |
| GET | `/api/v1/reports/across-regions` (+ `/trend`, `/active-trend`, `/drivers`, `/seasonality`) | `requireAuth` + `requireReportScope('across')` | Whole-company across-regions view. `standard`: `global-finops`/`platform-admin` only; loosened modes admit region admins / cost-centre owners. |
| GET | `/api/v1/reports/cost-centres` · `/{ccId}` | `requireAuth` + cost-centre scope | Cost-centre list + drill (owned-or-subtree under `standard`; all cost centres under a loosened `unbounded` grant). |
| GET | `/api/v1/reports/finance` · `/{couId}` | `requireAuth` + `requireReportScope('finance')` | Per-CoU finance/chargeback (all-regions grant required; region admins denied under `standard`, admitted under loosened modes). |
| GET | `/api/v1/reports/export` | `requireAuth` + the active scope's gate | Synchronous CSV export of the active report (the gate runs in the same request that streams the bytes — no generate-vs-download re-auth gap). |

## Admin

The administrative surface, gated `requireRole('admin','global-finops')`
(with `platform-admin` passing via the super-admin bypass); region-scoped
admins are clamped by `requireRegionScope` where noted. Write methods add CSRF
and emit audit events.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/admin/audit` | `admin`/`global-finops` | Paginated `audit_event` reader. |
| GET | `/api/v1/admin/diagnostics` | `admin`/`global-finops` | Read-only operational health snapshot. |
| GET | `/api/v1/admin/grants` | `admin`/`global-finops` | OAuth grants in the caller's region scope (`oauth_token` joined to `teammate` for region clamping). |
| POST | `/api/v1/admin/grants/{id}/revoke` | `admin`/`global-finops` + CSRF + region scope | Revoke a teammate's grant (region-scoped via the teammate join; emit grants also end their instance). Audited. |
| GET | `/api/v1/admin/org-units` | `admin`/`global-finops` | LTREE org-unit tree (region-scoped). |
| GET | `/api/v1/admin/projects` | `admin`/`global-finops` | Region-scoped projects list. |
| POST | `/api/v1/admin/projects` | `admin`/`global-finops` + CSRF | Register a project (region-clamped; CoU must be same-region). |
| POST | `/api/v1/admin/projects/{id}/assignments` | `manager`/`admin`/`global-finops` + CSRF | Assign a teammate to a project (missing teammate returns 422 "add this teammate first"). |
| DELETE | `/api/v1/admin/projects/{id}/assignments/{teammateId}` | `manager`/`admin`/`global-finops` + CSRF | End an assignment (closes the effective range, preserving history). |
| GET | `/api/v1/admin/region/{regionId}` | `admin`/`global-finops` | Region-scoped admin landing payload. |
| GET | `/api/v1/admin/regions` | `admin`/`global-finops` | Region list for admin pickers. |
| GET | `/api/v1/admin/report-visibility` | `admin`/`global-finops` | The org-wide report-visibility policy: current mode + who set it & when, plus the three presets with the WHO-SEES-WHAT matrix. A region admin may **read** it. |
| PUT | `/api/v1/admin/report-visibility` | `platform-admin`/`global-finops` + CSRF | Set the mode (org-wide config — the `admin`/`global-finops` gate is re-narrowed to `platform-admin`/`global-finops`; a region admin is 403'd). Before/after `report-visibility-changed` audit. |
| GET | `/api/v1/admin/repos` | `admin`/`global-finops` | Region-scoped repo-to-project mappings. |
| GET | `/api/v1/admin/settings` | `admin`/`global-finops` | Read-only config summary (intentionally narrow). |
| GET | `/api/v1/admin/teammates` | `admin`/`global-finops` | Region-scoped teammates grid (`region`, `limit`, `offset`). |
| GET | `/api/v1/admin/users` | `admin`/`global-finops` | Users sub-page list (role plus last-sync). |
| PATCH | `/api/v1/admin/users/{id}` | `admin`/`global-finops` + CSRF | Change a teammate's role (region-clamped; last-admin guard). |
| PATCH | `/api/v1/admin/users/{id}/region` | `global-finops` + CSRF | Move a teammate to another region (org-wide op; region `admin` may not do it). |
| POST | `/api/v1/admin/users/{id}/revoke-sessions` | `admin`/`global-finops` + CSRF | Force-sign-out a teammate (region-clamped, audited). |
| PATCH | `/api/v1/admin/users/{id}/org-unit` | `admin`/`global-finops` + CSRF + region scope | Move a teammate to another org-unit (clamped to the caller's region). |
| POST | `/api/v1/admin/teammates` | `admin`/`global-finops` + CSRF + region scope | Create/place a teammate (region admin bounded to their own region). |
| GET | `/api/v1/admin/instances` | `admin`/`global-finops` + region scope | Region-scoped instances/devices grid. |
| GET | `/api/v1/admin/activity-types` · POST · PATCH `/{id}` | `admin`/`global-finops` (+ CSRF on writes) + region scope | Region-scoped activity-type catalogue: list, create, and edit (`is_standard` org-wide entries are global-only). |
| GET | `/api/v1/admin/directory-exclusions` · POST · DELETE `/{id}` | `admin`/`global-finops` (+ CSRF on writes) | Directory-sync exclusion list: read, add, remove. |
| GET | `/api/v1/admin/directory/search` | `manager`/`admin`/`global-finops` | Typeahead directory search (for placing/looking up teammates). |
| GET | `/api/v1/admin/directory-region-rules` · POST · DELETE `/{id}` | `global-finops`/`platform-admin` (+ CSRF on writes) | Directory-attribute → region placement rules: list, upsert, and hard-delete. GLOBAL roles only (cross-region placement config); writes audited. |
| GET | `/api/v1/admin/directory/field-distribution` | `global-finops`/`platform-admin` | K-anonymity directory diagnostic (`?sample=`): per region-attribute coverage plus top distinct values as value/count only, suppressed below a k-anon floor of 5 (`MIN_CELL`). Powers the Region-rules Discover panel; GLOBAL roles only. |
| GET | `/api/v1/admin/governance-settings` · PUT | `admin`/`global-finops` (+ CSRF on write) + region scope | Read/set the governance settings for the caller's region. |
| GET | `/api/v1/admin/settings/project-lifecycle` · PUT | GET `admin`/`global-finops`; PUT `global-finops` + CSRF | Org-wide project-lifecycle settings (the org-wide write is narrowed to `global-finops`). |
| POST | `/api/v1/admin/org-units` · DELETE/PATCH `/{id}` · POST `/{id}/move` · POST `/{id}/owners` · DELETE `/{id}/owners/{teammateId}` | `admin`/`global-finops` + CSRF | Org-unit tree writes: create, edit, delete, re-parent (`move`), and owner add/remove. (The read is `GET /api/v1/admin/org-units` above.) |
| DELETE/PATCH | `/api/v1/admin/projects/{id}` | `admin`/`global-finops` + CSRF | Delete or edit a project (region-clamped). |
| GET | `/api/v1/admin/projects/{id}/assignments` | `manager`/`admin`/`global-finops` | List a project's teammate assignments (writes are the `assignments` POST/DELETE/PATCH rows above). |
| GET | `/api/v1/admin/rate-cards` · POST · POST `/{id}/retire` | `admin`/`global-finops` (+ CSRF on writes) | Rate-card registry: list, create-card-with-lines (atomic; region admins bounded to own region, a global card is `global-finops`/`platform-admin`), and retire. No line-mutation endpoint by design — pricing changes mint a new card. (Distinct from the still-unbuilt bare `/api/v1/rate-cards`.) |
| POST | `/api/v1/admin/regions` · DELETE/PATCH `/{id}` | `platform-admin` + CSRF | Region create / edit / delete — cross-region acts reserved for the super-admin. (The list `GET /api/v1/admin/regions` is above.) |
| GET | `/api/v1/admin/regions/{id}/leaders` · POST · DELETE `/{leaderId}` | `admin`/`global-finops` (+ CSRF on writes) | Region leaders: list, add, remove. |
| GET/PUT/DELETE | `/api/v1/admin/regions/{id}/project-lifecycle` | `admin`/`global-finops` (+ CSRF on writes) | Per-region project-lifecycle override: read, set, clear. |
| GET | `/api/v1/admin/reconciliation/**` | `admin`/`global-finops` (+ CSRF on writes) | Provider-reconciliation admin subtree: `anthropic/{discover,health}`, `github/{discover-orgs,health,map,teammate-search,unresolved}`, `enterprises` (+ `/{id}` PATCH/DELETE), `orgs` (+ `/{id}` PATCH/DELETE), `backfill` (GET/POST), and `records` (GET). Configures and inspects the billing-reconciliation connectors. |
| GET | `/api/v1/admin/diagnostics/network` | `admin`/`global-finops` | Network-reachability diagnostic snapshot. |
| GET | `/api/v1/admin/diagnostics/otel-logs` | `platform-admin` | Recent OTel log-ingest diagnostic (super-admin only). |
| GET | `/api/v1/admin/worker-runs` · `/{id}` | `admin`/`global-finops` | Background-worker run history (list + one run's detail); admin-global, no region clamp. |
| POST | `/api/v1/admin/workers/{name}/run` | `global-finops` + CSRF | Trigger a named worker from the admin UI (RBAC/cookie path). **Distinct from** the HMAC machine-to-machine `POST /api/v1/internal/run-worker/{name}` below — same worker registry, different auth (cookie+RBAC here vs. HMAC there). |

## Internal (machine-to-machine)

The scheduler entrypoint for background workers, driven by the `caj-ts-*`
Container Apps cron jobs.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| POST | `/api/v1/internal/run-worker/{name}` | HMAC-SHA-256 (internal) | Run a named background worker; `{name}` is resolved against a static registry (unknown names 404 before any worker loads). Returns `{ worker, duration_ms, result }`. |

Auth detail: headers `X-Internal-Signature` (=
`hex(HMAC-SHA256(key, "${timestamp}\n${METHOD}\n${path}\n${sha256hex(body)}"))`)
and `X-Internal-Timestamp` (unix seconds), replay window ±300s, uniform 401 on
any failure. The key (`NUXT_INTERNAL_WORKER_HMAC_KEY`) is separate from the
session HMAC for blast-radius isolation.

## Auth lifecycle

Session probe, logout, and the non-production persona-override controls (disabled in dev).

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/auth/me` | none (probe) | Current-session probe; always 200, returns `{ authenticated:false }` when unauthenticated. |
| POST | `/api/v1/auth/logout` | cookie | Clear the persona-override sidecar cookie (the OIDC session itself is cleared by nuxt-oidc-auth's own logout route). |
| POST | `/api/v1/auth/stop-impersonating` | cookie | Clear the persona-override sidecar so the next request returns to the real OIDC identity. |
| POST | `/api/v1/auth/dev-login` | non-prod gate (else 404) | Non-production persona override only — **disabled in dev** (`allowPersonaOverride=false`); triple-gated on env + Entra-admin caller + non-production; mints an audited HMAC-signed `ts_persona_override` sidecar cookie. |

## Health

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/health` | none (edge-exempt) | Liveness plus readiness (process up plus DB `SELECT 1`); 200 `{ status:'ok', checks:{db:'up'}, version }`, 503 `degraded` on DB-ping failure. Excluded from the front-door header check where that gate is applied. |

---

## Planned / not yet implemented

The following surfaces are designed but **not built** — none exist in
`server/api/**` today. They are listed so the roadmap stays visible; do not
treat them as a live API.

- **Copilot OTLP bridge** — a separate ACA service receiving `POST /v1/{traces,logs,metrics}` from Copilot CLI, stamping attested identity and forwarding to Azure Monitor. *Not built; Copilot support is future-state.*
- **Attribution ledger reads** — `GET /api/v1/attribution/by-{teammate,project,cou,region,tool-model,session}`. *Not built; attribution is surfaced only via `/me/usage` and `/rollups/*` aggregates today.*
- **Spill reconciliation reads** — `GET /api/v1/spill/by-cou`, `/spill/by-workspace`, `/spill/report`. *Not built.*
- **Retrospective claim workflow** — `POST/PATCH /api/v1/claims`, `GET /claims/unclaimed`, `GET /claims/by-teammate`, `POST /claims/{id}/override`. *Not built (the membership-gated `/me/sessions/{sid}/assign` partly meets the retroactive-tagging need by a different mechanism).*
- **Bare rate-card CRUD** — the top-level `GET/POST /api/v1/rate-cards`, `PATCH /rate-cards/{id}`, `POST /rate-cards/{id}/lines`, `DELETE /rate-cards/{id}`, `POST /rate-cards/recost`. *Not built.* Note: the **admin** rate-card surface (`GET/POST /api/v1/admin/rate-cards` + `POST /api/v1/admin/rate-cards/{id}/retire`) **is** built — see the Admin table. There is deliberately no line-mutation or recost endpoint (pricing changes mint a new card; mistakes retire).
- **Generic project registry CRUD** — bare `GET/POST /api/v1/projects`, `PATCH /projects/{id}`, `GET/POST /api/v1/projects/repos`. *Not built (projects are created via `POST /api/v1/admin/projects` instead).*
- **Limits / tiers / bursts** — CRUD under `/api/v1/limits`, `/api/v1/tiers`, `/api/v1/burst`. *Not built (only `/api/v1/allocations/*` exists).*
- **Additional admin writes** — `/api/v1/admin/identity-map`, `/api/v1/admin/recost`, `/api/v1/admin/connectors` (+ `/{id}/api-key`), `/api/v1/admin/inbox`, `/api/v1/admin/notification-rules`. *Not built.*
- ~~**MCP server + OAuth 2.1 surface**~~ — **BUILT** (PR #37/#38). `/api/v1/mcp`, `/api/v1/oauth/{register,authorize,token,revoke}`, `/api/v1/setup/redeem`, and `/.well-known/oauth-authorization-server` + `oauth-protected-resource` are all live; see *MCP server & OAuth 2.1* above. Validated on Claude Code; other MCP clients (Copilot/Cursor) are unvalidated but use the same backbone.
- **Financial connectors (FIN)** — the `FinancialConnector` interface, connector ingest `POST /api/v1/connectors/{id}/ingest`, and sync-conflict admin endpoints `/api/v1/admin/sync-conflicts`. *Not built; pilot config is manual.*
- **OpenAPI / v2 / deprecation** — `GET /api/v1/openapi.json`, any `/api/v2/...` surface, and `410 Gone` + `Deprecation`/`Sunset` (RFC 8594) machinery. *Not built.*
- **`/health/{live,ready,deep}` split** — superseded by the single `GET /api/health`. *Not built.*
