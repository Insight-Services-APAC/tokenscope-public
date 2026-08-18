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
| POST | `/api/v1/oauth/authorize` | cookie + CSRF (same-origin) | The consent grant: on `Accept: application/json` returns `{ redirect_url }` (callback carrying code+state) as data; on a form post, 302s. Reuses `issueAuthCode` (teammate-bound, PKCE-carried). Handles deny. A session that is an **assumed identity** (persona override) is refused with a JSON `403 access_denied` before the client/`redirect_uri` lookup — so the refusal can never become a redirect, and no impersonator can mint a durable credential in the impersonated teammate's name. |
| POST | `/api/v1/oauth/token` | PKCE code / refresh token | Exchange an authorization code (+ verifier) or refresh token for an access token (RFC 6749 + 7636). Non-rotating refresh (ADR-0005). |
| POST | `/api/v1/oauth/register` | none (RFC 7591) | Dynamic client registration; always writes a non-internal client. |
| POST | `/api/v1/oauth/revoke` | client-creds + raw token (RFC 7009) | Client-side token revocation (the machine path; the user-facing revoke is `/me/grants/{id}/revoke`). |
| POST | `/api/v1/setup/redeem` | handoff code = auth | Redeem the one-time, ~5-minute emit-provisioning handoff minted by `provision_emit` (atomic single-use, no cookie/CSRF) for the durable emit credential + the Claude OTel telemetry bundle. The durable secret is fetched here process→server, never over MCP. |
| POST | `/api/v1/setup/enroll` | bundled enrollment secret = auth | The **no-login, emit-on-install** enroll path (a separate mechanism from the retired setup-token exchange — that retirement stands): a privately-distributed plugin bundles a rotatable enrollment secret and calls this on install (no OAuth, no human) to mint a durable emit-only credential + the OTel bundle, bound to a server-chosen instance and a **provisional** shadow teammate keyed on the claimed email. A bad/expired secret is the only 401 (no existence oracle); response shape is constant regardless of whether the email exists. Usage emits immediately as `identity_state=provisional` until the human signs in and confirms. Two capacity caps guard the create branch — a global one and a per-claimed-email one (`MAX_PROVISIONAL_INSTANCES` / `MAX_PROVISIONAL_INSTANCES_PER_EMAIL`) — and either returns `429`. Both count only **live** provisional instances: a row that has ended or been purged is no longer a device and no longer consumes quota, so re-enrolling one laptop repeatedly cannot exhaust either cap. Idempotent reuse of an existing instance never consumes quota at all. |

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

The needs-tagging worklist (`me/sessions/untagged` + `me/unaccounted/**` +
`me/worklist/bulk`) and the **Activity** list (`me/activity`) render on **both**
Home and **My usage** — Home is where tagging pressure lands, My usage is the
self-depth surface. One set of components serves both, so there is one
implementation of the tagging contract and the endpoints below are called
identically from either page.

The two lists answer different questions and both are needed. The **worklist is
a task list** — what still awaits a decision, so it filters `project_id IS
NULL`. **Activity is a record** — what happened, decided or not. Making the
worklist double as the only inventory of provider-recorded days is what made a
tagged Copilot day unfindable: `/me/sessions/recent` read `attribution_record`
(OTel only, by design) so it never held one, and tagging removed it from the
only list that did.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/me/home` | cookie/OIDC | Month-to-date project-bucket split (cost, tokens, allocation, `is_active_now`, source, freshness) — the **Home** dashboard payload. Renamed from `/api/v1/me/usage`, which now belongs to the My usage page below; there is no redirect. Also carries `has_ever_emitted` — the onboarding CTA's operand, answered on the **OTel lane alone** (`EXISTS` over `attribution_record`, all-time and unfiltered). It is deliberately NOT "has any record": Activity is a union that includes API-reported provider days, so a Copilot-only teammate who has never emitted would otherwise read as an onboarded one — the rollout gap mis-read as coverage. |
| GET | `/api/v1/me/home/recent` | cookie/OIDC | Rolling-window (`window=7\|30\|90`, default 30) spend snapshot over `attribution_aggregate` for **Home**'s "recent spend" strip: `total_cost_usd`, `total_tokens`, `active_days`, `cost_per_active_day`, daily `series`, `by_model`. NO budget/quota framing (that stays month-to-date on `/me/home`); the honest home for the strip's time controls. Moved with the page it serves — it sat under `me/usage/` while serving Home, which is the exact word-collision this rename set out to remove, one level down. |
| GET | `/api/v1/me/projects` | cookie/OIDC | Projects the caller is a current member of (powers the quick-assign picker). |
| GET | `/api/v1/me/activity` | cookie/OIDC | **Activity** — ONE list holding both kinds of record the platform can hold about the caller: OTel-observed **sessions** and **provider-recorded days** (`unaccounted_usage`), tagged or not, dismissed or not. Filters (`kind=all\|session\|provider-day`, `tool`, `project` = project CODE, `tagged=all\|tagged\|untagged`, `from`/`to` as inclusive **UTC** days, validated as REAL calendar days — `2026-02-31` is a `400`, not a `500`) and keyset paging (`cursor`, opaque; `limit` default 25, max 100). Both rows kinds sort on ONE key — the **UTC day** — and each branch of the union is bounded independently, so a heavy session user's provider-days can never be crowded out. **Grain:** a session row carries `ts_last` (a real instant, rendered in the viewer's zone); a provider-day row carries **no timestamp field at all** — no instant exists at day grain and a synthesised `00:00` would be a fabricated measurement. **Tokens may be `null`.** A provider-recorded day carries the token quantity the provider reported, and GitHub's `ai_credit/usage` reports none at all (Copilot is metered in ai-credits), so every Copilot day ships `tokens: null` — "not reported", never a measured `0`. A session row's tokens are OTel-observed and always a number. The response carries **no echo of the applied filters**: nothing read it, and it could not have proven list/CSV parity anyway (the CSV is a separate request off the same client state) — the guarantee is structural, one shared filter schema. **The list claims non-duplication, not conservation, and returns NO total**: the two kinds are different quantities (a session's ledger cost vs. a day's reconciled residual `max(0, API day total − Σ OTel captured)`), so summing across them would mean nothing. Month totals stay on `/me/usage`. An unrecognised `cursor` is a `400`, never a silent restart. |
| GET | `/api/v1/me/activity/export` | cookie/OIDC | The same list as CSV under the **same filters** (`limit` default 1000, max 5000). The filter set is identical by construction; the ROW SET may be shorter — a match larger than `limit` is truncated to the newest `limit` rows. "Matches what you are looking at" is a claim about the filters, not about completeness, read through the same keyset walk so the file and the screen cannot disagree. Columns: `kind,id,day,when,tool,project_code,project_display_name,activity,tokens,cost_usd`; `when` is **empty** for a provider-recorded day. Formula-injection-escaped. The filename carries no date — the server owns the clock and this is not a windowing path. Note the routing: a static segment outranks a parameter, so `export` resolves here rather than at `/me/activity/{activity}`; the cost is that an activity label of exactly `export` is not reachable through the drill-down URL. |
| ~~GET `/api/v1/me/sessions/recent`~~ | — | **RETIRED** (superseded by `/me/activity`). It read `attribution_record` — a single OTel source, by design — so a provider-recorded day could never appear on it. Removed with its handler; no redirect, no auth-reachable landmine. |
| ~~GET `/api/v1/me/sessions/recent/export`~~ | — | **RETIRED** with the route above; the CSV is now `/me/activity/export`. |
| GET | `/api/v1/me/sessions/untagged` | cookie/OIDC | Caller's recent OTel sessions and provider-recorded days not yet attributed to a project (the retroactive-tagging worklist), plus the dismissed set. **Stays** alongside `/me/activity`: this is the TASK list (`project_id IS NULL` by definition), Activity is the RECORD. |
| POST | `/api/v1/me/sessions/{sid}/assign` | cookie/OIDC + CSRF | Retroactively tag an untagged session to a project (triple gate: project exists, caller is a member, session email is one of the caller's identities); attribution runs on the next scheduled tick. |
| GET | `/api/v1/me/unaccounted/{id}` | cookie/OIDC | Full drill-down for one of the caller's provider-recorded days (`ProviderDayDetail`) — the counterpart of `/me/sessions/{sid}` for the unit that has no session: model mix, token lanes, cost by model and requests, read from the provider's own `provider_usage_fact` rows for that (teammate, day, tool). Ownership is the query's `WHERE` — a foreign or unknown id 404s identically, so neither can be probed. |
| POST | `/api/v1/me/unaccounted/{id}/assign` | cookie/OIDC + CSRF | Tag a provider-recorded day (`{ project_id?, activity? }`, at least one present) — the same correction primitive as a session tag, membership-gated by the same rule; `project_id: null` returns the day to needs-tagging; `activity` omitted = preserved, `null` = cleared. Ownership + ended-budget + membership gates, then update + audit, atomically. |
| POST | `/api/v1/me/worklist/bulk` | cookie/OIDC + CSRF | Apply ONE decision (`tag` / `dismiss` / `restore`) to a set of needs-tagging items — conversations and/or provider-recorded days — in one atomic transaction: ownership pre-flight on every item, all gates first, nothing changed if any item fails. Dismissal changes no money: the spend stays unallocated and still charges to the caller's cost centre. |
| GET | `/api/v1/me/grants` | cookie/OIDC | The caller's own authorized OAuth connections (`oauth_token` rows): client name, plain-language scopes, derived state (active/inactive/revoked/expired), `created_at`, `last_used_at`, and `is_emit`. Owner-scoped. |
| POST | `/api/v1/me/grants/{id}/revoke` | cookie/OIDC + CSRF | Revoke one of the caller's own grants (404 if not theirs). Revoking an emit grant also ends its instance so the silence is expected. |
| GET | `/api/v1/me/quarantined-spend` | cookie/OIDC | The caller's sessions whose spend lacks covering emit-heartbeats ("unverified spend") pending reconciliation. |
| GET | `/api/v1/me/identities` | cookie/OIDC | Caller's primary email plus linked identity-map rows (with `verified`, `source`). |
| POST | `/api/v1/me/identities` | cookie/OIDC + CSRF | Self-link another identity (Claude/GitHub/client email) so its spend attributes to the caller; rows are `source='self'`, unverified, audited. |
| DELETE | `/api/v1/me/identities/{id}` | cookie/OIDC + CSRF | Unlink one of the caller's own identity rows (the primary email is not a map row and cannot be removed here). |
| GET | `/api/v1/me/inbox` | cookie/OIDC | List the caller's inbox items (filters: `ack_state` incl. open/closed shorthand, `category`, `severity`, `limit`). |
| PATCH | `/api/v1/me/inbox/{id}` | cookie/OIDC + CSRF | Change `ack_state` (read/acknowledged/dismissed/resolved) on one's own item; audited. |
| POST | `/api/v1/me/inbox/{id}/route` | `admin`/`global-finops` + CSRF | Forward an inbox item to another (active) recipient and resolve the source; audited. |
| GET | `/api/v1/me/usage` | cookie/OIDC | The caller's own usage-detail view — the **My usage** page (teammate-scoped). Renamed from `/api/v1/me/consumption`; there is no redirect. The dashboard payload moved the other way and is now `/api/v1/me/home`. Accepts the report window vocabulary (`month=YYYY-MM` XOR `from`/`to`, resolved via `resolveReportWindow`) beside the trend card's own `window=30\|90`; `lane=usage\|chargeback` selects the lens. Payload: `headline`/`disclosure` (ADR 0012), `hero_tiles` (the four window-scoped KPI tiles with same-elapsed MoM deltas and named delta-empty reasons — the page's only hero since the §I3 basis-group `hero` leg retired with its card), `context_residency` (spend by provider-reported context-window band + reason-typed un-banded remainder), `session_economics` (OTel-arm conversation distribution: median/p90/top-3 share), `model_mix` (reason-typed Top-models rows + the mix's own denominator), `where_it_went` (per-project contribution rows with the PROJECT's window total + allocation, plus one untagged remainder), `engagement` (`claude` and `copilot` columns, each in its own vocabulary; `null` = empty state). `hero_tiles.window` echoes the resolved window and carries `spark_partial` — whether the tiles' sparks END on a still-filling day (the axis runs to `min(to, today)`). It is stated by the server because nothing else on the echo can distinguish a finished month from the current month's last day, and a client that guessed from the frame would draw the "still accruing" mark on completed days. The former `cache`, `aux` and `hero` legs are removed with their cards (`hero` fed "What kind of AI work drove this", retired 2026-08-05; `disclosure` stays — Home reads it too, and /usage now renders it behind the lane toggle's (i) rather than as a card). Tagged-activity chips on the page open the activity drill-down. |
| GET | `/api/v1/me/cost-centres` | cookie/OIDC | Cost centres the caller belongs to (self-scoped). |
| GET | `/api/v1/me/activity-types` | cookie/OIDC | Activity types visible to the caller (for self-tagging). |
| GET | `/api/v1/me/activity/{activity}` | cookie/OIDC | Tag/activity drill-down (`ActivityDetail`, `window=7\|30\|90`): the caller's spend on ONE activity label broken down by model, token lane, cache economics and fidelity, plus the session list carrying the tag (cost desc). Teammate-scoped ledger read (activity is not an aggregate dimension); an unused label returns an empty breakdown (no `404`). Surfaced by the **activity drill-down drawer**, whose session rows hand off to the session drawer. |
| GET | `/api/v1/me/projects/summary` | cookie/OIDC | Summary rollup across the caller's projects (MTD). Each card carries `mine_mtd_usd` (the caller's own slice, same lane/window/provisional option as the card total) and `spark` (same-window per-day series); the response carries `untagged_usd` — the caller's taggable-but-untagged MTD spend behind the list band's worklist pull-through. |
| GET | `/api/v1/me/projects/{code}` | cookie/OIDC | Detail for one of the caller's projects, keyed by project code. Windows on the report vocabulary (`?month=YYYY-MM` XOR `?from&to`; default = current month). Payload: `window` (bounds + `days_elapsed`/`days_in_window` pace operands), `budget.window_cost_usd`, `hero` (active/assigned member counts + per-tile MoM deltas paced on the data frontier, with a named `empty_reason` when withheld), reason-typed `mix.by_model` rows for the Top-models panel, `mix.by_activity`, windowed `series_by_model`, team, untagged pressure, and the chip-row operands (`providerStates`, `coverage`). **`?window=30\|90`** (default 30) governs the Daily-burn card ALONE: it returns `burn` — `window_days`, `from`/`settled_to`/`to`, a trailing `series_by_model`, `advisory_cost_usd` and `advisory_basis`. The bounds span `window_days` SETTLED days (`from`…`settled_to`) plus the still-filling `to` day beyond the settled edge, which is exactly the axis the chart draws — so a "30d" card spans 31 dates by design, the last one drawn partial and excluded from means. `advisory_cost_usd` is tier-2 / telemetry-only spend over that same trailing window (rendered as the chart's footer, omitted entirely at zero) and is **`null`, not `"0.00"`, when `attribution_aggregate` holds no row for the window** — an un-materialised rollup is not a measured zero. `advisory_uncovered_days` counts the window's SPENDING days the rollup provably has not covered (days the ledger series carries and the aggregate holds no row for) — non-zero means the figure is **not** a window total and the client must not present it as one; a partially materialised rollup used to be indistinguishable from a complete one. `advisory_basis` (`otel-aggregate-all-identities`) names the population that sum covers: the aggregate has no identity dimension, so unlike the chart above it the figure includes provisional identities, and it is OTel-only (no reconciliation or ingest-only arms). The trailing bounds are resolved from the request clock, so the series and its footer describe the same days; nothing else on the payload moves with it. The token-lane mix, cache stats, top-level `fidelity` and plain daily `series` legs stay retired. |
| GET | `/api/v1/me/projects/{code}/team/export` | cookie/OIDC | CSV of the project page's team-contribution table (member, cost, tokens, active days, $/active day, share, last activity), windowed like the page (`?month` XOR `?from&to`). Membership-gated: a non-member — including a cost-centre-owner observer, who never sees named member rows — gets the same `404` as a missing project. |
| GET | `/api/v1/me/instances` | cookie/OIDC | The caller's own enrolled instances/devices. |
| GET | `/api/v1/me/sessions/{sid}` | cookie/OIDC | Full drill-down for one of the caller's own sessions (`SessionDetail`): model×token-type cost matrix, per-lane split (input/output/cache-read/cache-write), main-vs-aux (harness) split, cache economics (hit ratio + $ saved) and the estimated-vs-advisory fidelity split. AR-based ownership → `404` for a foreign/unknown id. Surfaced by the **session drill-down drawer** (opened from any recent-session row). |

## Allocations (governance)

CRUD for project budget pools. All gated `requireRole('manager','admin','global-finops')`,
with project/region/org-subtree scoping; write methods add CSRF and emit audit
events. The scope is the same on both sides of that split: an `admin` is bound to
the project's region, a `manager` needs the project to be **in their own region
AND** its cost-owning unit inside their org subtree, and `global-finops` is
unbounded. A project that fails either half returns the same `403` — the refusal
does not say which.

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
route is `requireAuth` (identity), then **scoped by report access** — each
caller's granted scopes are their role-shaped baseline (§RBAC; admin roles see
their region or the whole company by role) UNION whichever positive permissions
their ACTIVE `report_access_grant` rows buy, then zeroed entirely if an active
`revoke-all` row is present (see
[Report access grants](Authentication-and-Security.md#report-access-grants)).
`GET /reports/meta` returns only the **granted** scopes and drives which tabs
render, plus `permissions` (the caller's held permission names) when
non-empty. The region route resolves both of its widths through
`resolveRegionRequest` — `?region=all` (the whole-company answer) requires the
`across` grant (an active `operational` permission), a single region the
`regional` scope; the finance routes enforce `requireReportScope('finance')`
(an active `finance` permission); the cost-centre routes take a
grant-computed `crossRegion` / `unbounded` flag. All reads hit the lane views
only (the lane firewall) — no `attribution_record`, no `attribution_aggregate`,
no raw `actual_spend`.

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/reports/meta` | `requireAuth` | Bootstrap: granted scopes (policy-derived), best-default scope, region default, month floors, provider settling states, copilot mode, and `drill` — the two grant columns (`teammate`, `project`) the client needs to decide link-or-plain-text on every reports row. |
| GET | `/api/v1/reports/region` (+ `/trend`, `/active-trend`, `/drivers`, `/seasonality`, `/behaviour`) | `requireAuth` + region scope (see above) | ONE route, two widths. `?region=all` is the whole-company view (`standard`: `global-finops`/`platform-admin` only; loosened modes admit region admins / cost-centre owners); any other region is that region's view (cross-region roles, and admins under a loosened mode, may pass `?region=`). The retired `/reports/regional` and `/reports/across-regions` routes folded in here. `/drivers` takes `?axis` (width-specific enums) and `?lane=usage\|chargeback`. The response `meta` carries `settledThrough` — the last SETTLED UTC day (`today − 1`) the payload's day series were cut on — so a consumer can tell whether a series' last point is a finished day or the still-filling one without opening a second `/api/v1/clock` request with its own instant. |
| GET | `/api/v1/reports/cost-centres` · `/{ccId}` | `requireAuth` + cost-centre scope | Cost-centre list + drill (owned-or-subtree under `standard`; all cost centres under a loosened `unbounded` grant). Both carry the centre's two lanes: `burnUsd` (§A usage, homed by emit-time `cost_owning_unit_id`) and `chargeUsd` (§B chargeable), from one shared fetcher so the list and the drill cannot disagree. Never summed. `copilotChargebackPartialMonth` is `true` when the pooled Copilot charge — billed monthly, so unsliceable — is excluded because the window is not month-aligned; it is a property of the WINDOW and does not assert that a given centre has a pool row. The drill's `vendor` split covers every surface a vendor ships, not its flagship tool. |
| GET | `/api/v1/reports/finance` · `/{couId}` | `requireAuth` + `requireReportScope('finance')` | Per-CoU finance/chargeback (all-regions grant required; region admins denied under `standard`, admitted under loosened modes). |
| GET | `/api/v1/reports/teammate/{id}` (+ `/export`) | `requireAuth` + `teammateDrillAdmission` | The per-teammate **contribution view** (reports depth only). Requires `?src=` — the entry scope frame (`cc:{id}` / `region:{id}` / `across` / `finance`); a request with no frame is a `400` and a frame the caller does not hold is a `403`. Every subject figure is computed over the frame's predicate; the TokenSheet's "share of project" and budget state are whole-project figures over ALL members. Writes a `report-teammate-viewed` audit row on every request (the export writes `report-teammate-export`); both responses are `Cache-Control: no-store`. Withholds its figures behind `refusal: { reason: 'coverage-stale', … }` when the stalest provider feeding the subject's in-scope rows is past the freshness threshold. |
| GET | `/api/v1/reports/project/{code}` | `requireAuth` + the `project` grant | The project at **reports depth**, for a viewer admitted by a grant rather than by membership: total vs allocation + burn/day, top models, and contributors in the viewer's people-scope NAMED with ONE aggregate remainder so the rows foot to the project total over all members. Member depth is unchanged and stays at `/api/v1/me/projects/{code}`, which admits on TWO paths: current project membership (`access: 'member'`), or an active `cou_owner` row on the project's lead cost-owning unit (`access: 'cou-owner'` — the P&L drill-through). A caller with neither is 404, indistinguishable from a missing project. An out-of-scope project and a nonexistent code return the SAME 403. |
| GET | `/api/v1/reports/export` | `requireAuth` + the active scope's gate | Synchronous CSV export of the active report (the gate runs in the same request that streams the bytes — no generate-vs-download re-auth gap). |

### `GET /api/v1/clock` — the one clock

| Method | Path | Auth gate | Purpose |
|---|---|---|---|
| GET | `/api/v1/clock` | `requireAuth` | The server's resolved clock: `{ now, today, settledThrough }`. `Cache-Control: no-store`. |

Deliberately trivial — no database, no scope, no per-caller variation: the day is
UTC for everyone. It exists because "today" on a chart is a **coverage** fact the
browser cannot know (see [Reporting §3a](Reporting.md#3a-the-clock--what-today-means-on-a-report)).
Every clock-sensitive client control consumes this rather than calling
`new Date()`; the server resolves it once per request (`requestClock(event)`) so
the SQL series frontier, the response-cache key and this payload are the same
instant.

**The clock pin (`?clock=`) — demo-capable environments only.** On a `local` or
`sandbox` deployment (the same structural allowlist that gates persona
impersonation — `shared/env/deploy-env.ts`), any request may carry
`?clock=<ISO-8601 UTC instant>`. It pins that request's clock and sets a session
cookie so the browser's own `/api/v1/clock` fetch resolves to the same instant;
`?clock=off` clears it. A malformed value is a `400` rather than a silent
fallback — a screenshot filed as "day 1" that was really taken mid-month is worse
than a failed run. Outside `local`/`sandbox` the parameter and the cookie are
inert. It exists so the parity capture (`scripts/parity-shots.sh`) can shoot the
product on a real day 1, which is the only way that gate can see the month-start
states.

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
| GET | `/api/v1/admin/report-access` | `global-finops` | List report-access grants (active + expired-but-not-revoked, each carrying holder, permission, granted-by, and expiry). Org-wide only — no region-admin read, unlike the retired policy dial. |
| POST | `/api/v1/admin/report-access` | `global-finops` + CSRF | Write one report-access row for one active, non-provisional teammate, with an optional future `expires_at`: a positive grant (`operational`/`finance`) that WIDENS, or `revoke-all` that REMOVES all report access (deny-wins over role default and any grant — the "administer, no data" case). `409` on a live duplicate for the same (teammate, permission); an expired-but-unrevoked blocker is superseded automatically first (its own audited revoke). |
| DELETE | `/api/v1/admin/report-access/{id}` | `global-finops` + CSRF | Soft-revoke a report-access row (history preserved; a later re-grant is a new row). `404` if no active row matches the id. `403` if the row is a `revoke-all` targeting the **caller themselves** — lifting your own revoke needs a different admin. |
| GET | `/api/v1/admin/report-access/teammate-search` | `global-finops` | Company-wide typeahead over active, non-provisional teammates (`?q=` min 2 chars, `?limit=` max 25) for the grant dialog — the region-scoped `/admin/users` list cannot serve an org-wide picker. |
| GET | `/api/v1/admin/repos` | `admin`/`global-finops` | Region-scoped repo-to-project mappings. |
| GET | `/api/v1/admin/settings` | `admin`/`global-finops` | Read-only config summary (intentionally narrow). |
| GET | `/api/v1/admin/teammates` | `admin`/`global-finops` | Region-scoped teammates grid (`region`, `limit`, `offset`). |
| GET | `/api/v1/admin/users` | `admin`/`global-finops` | Users sub-page list (role plus last-sync). |
| PATCH | `/api/v1/admin/users/{id}` | `admin`/`global-finops` + CSRF | Change a teammate's role (region-clamped; last-admin guard). |
| PATCH | `/api/v1/admin/users/{id}/region` | `global-finops` + CSRF | Move a teammate to another region (org-wide op; region `admin` may not do it). |
| POST | `/api/v1/admin/users/{id}/revoke-sessions` | `admin`/`global-finops` + CSRF | Force-sign-out a teammate (region-clamped, audited). |
| PATCH | `/api/v1/admin/users/{id}/org-unit` | `admin`/`global-finops` + CSRF + region scope | Move a teammate to another org-unit (clamped to the caller's region). Optional `rehome` moves their recorded usage with them — see **Correcting a placement** below. |
| POST | `/api/v1/admin/users/{id}/placement-span` | `admin`/`global-finops` + CSRF + region scope | Read-only: what a placement correction would move, and how many Business Units it spans. |
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
| DELETE/PATCH | `/api/v1/admin/projects/{id}` | `admin`/`global-finops` + CSRF | Delete or edit a project (region-clamped). PATCH also accepts `migrate_spend` — see **Migrate** below. |
| POST | `/api/v1/admin/projects/{id}/migrate-preview` | `admin`/`global-finops` + CSRF | Read-only: what a Migrate would move. See **Migrate** below. |
| GET | `/api/v1/admin/reporting-snapshots/{month}` | `admin`/`global-finops` | What the month read when it was recorded, plus what it reads now and the movement. `null` = never recorded. |
| POST | `/api/v1/admin/reporting-snapshots/{month}/close` | `admin`/`global-finops` + CSRF | Record the month. Refused if it has already been recorded. |
| GET | `/api/v1/admin/projects/{id}/assignments` | `manager`/`admin`/`global-finops` | List a project's teammate assignments (writes are the `assignments` POST/DELETE/PATCH rows above). All four share `assertProjectScope`: `admin` bound to the project's region, `manager` needs the project in their **own region and** its cost-owning unit in their org subtree, `global-finops` unbounded. |
| GET | `/api/v1/admin/rate-cards` · POST · POST `/{id}/retire` | `admin`/`global-finops` (+ CSRF on writes) | Rate-card registry: list, create-card-with-lines (atomic; region admins bounded to own region, a global card is `global-finops`/`platform-admin`), and retire. No line-mutation endpoint by design — pricing changes mint a new card. (Distinct from the still-unbuilt bare `/api/v1/rate-cards`.) |
| POST | `/api/v1/admin/regions` · DELETE/PATCH `/{id}` | `platform-admin` + CSRF | Region create / edit / delete — cross-region acts reserved for the super-admin. (The list `GET /api/v1/admin/regions` is above.) |
| GET | `/api/v1/admin/regions/{id}/leaders` · POST · DELETE `/{leaderId}` | `admin`/`global-finops` (+ CSRF on writes) | Region leaders: list, add, remove. |
| GET/PUT/DELETE | `/api/v1/admin/regions/{id}/project-lifecycle` | `admin`/`global-finops` (+ CSRF on writes) | Per-region project-lifecycle override: read, set, clear. |
| GET | `/api/v1/admin/reconciliation/**` | `admin`/`global-finops` (+ CSRF on writes) | Provider-reconciliation admin subtree: `anthropic/{discover,health}`, `github/{discover-orgs,health,map,teammate-search,unresolved}`, `enterprises` (+ `/{id}` PATCH/DELETE), `orgs` (+ `/{id}` PATCH/DELETE), `backfill` (GET/POST), and `records` (GET). Configures and inspects the billing-reconciliation connectors. |
| GET | `/api/v1/admin/diagnostics/network` | `admin`/`global-finops` | Network-reachability diagnostic snapshot. |
| GET | `/api/v1/admin/diagnostics/multi-bu-owners` | `admin`/`global-finops` | Teammates who actively own more than one Business Unit. Returns `{ clean, violations[] }`; region-scoped unless global. |
| GET | `/api/v1/admin/diagnostics/otel-logs` | `platform-admin` | Recent OTel log-ingest diagnostic (super-admin only). |
| GET | `/api/v1/admin/diagnostics/rls-posture` | `platform-admin` | Row-level-security posture and capability probe (super-admin only). Reports the connection in use, whether it can provision the non-owner app role (`rolsuper`, `rolcreaterole`, `azure_pg_admin` membership), whether that role exists with its grants, and per-table `relrowsecurity` / `relforcerowsecurity` / policy count / whether the policies actually filter the caller. Read-only — it provisions nothing. |
| GET | `/api/v1/admin/worker-runs` · `/{id}` | `admin`/`global-finops` | Background-worker run history (list + one run's detail); admin-global, no region clamp. |
| POST | `/api/v1/admin/workers/{name}/run` | `global-finops` + CSRF | Trigger a named worker from the admin UI (RBAC/cookie path). **Distinct from** the HMAC machine-to-machine `POST /api/v1/internal/run-worker/{name}` below — same worker registry, different auth (cookie+RBAC here vs. HMAC there). |
| GET | `/api/v1/admin/workers/enablement` | `admin`/`global-finops` | The kill-switch state of the whole registry — every worker, its description, its live cron (null when it has no scheduled job), and whether it is enabled. An absent row means enabled, so the read returns the full fleet rather than a list of exceptions. |
| PUT | `/api/v1/admin/workers/enablement` | `global-finops` + CSRF | Turn one scheduled worker on or off; takes effect on that worker's next tick. A disable requires a `reason`. `400` for an unknown worker name or one with no scheduled job. Attributed (`updated_by`/`at`) and audited as `worker-enabled` / `worker-disabled`. **Write is global-only, unlike the read**: `worker_enablement` has no region column and every worker it governs runs globally, so a toggle reaches past a region admin's scope — the admin card renders for a region `admin` but offers no toggle. |

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
- **Attribution ledger reads** — `GET /api/v1/attribution/by-{teammate,project,cou,region,tool-model,session}`. *Not built; attribution is surfaced only via `/me/home`, `/me/usage` and `/rollups/*` aggregates today.*
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


## Correcting a placement — moving a person's recorded usage with them

Two different moves, on two different axes, and the difference is deliberate:

| | Migrate (below) | Placement correction (here) |
|---|---|---|
| axis | the PROJECT's Business Unit | the PERSON's Business Unit |
| column | `cost_owning_unit_id` | `org_unit_id` (+ `cost_owning_unit_id` where it is the teammate's own) |
| reached from | `PATCH /admin/projects/{id}` | `PATCH /admin/users/{id}/org-unit`, `POST /admin/users/bulk-place` |

**Who changed the placement decides whether history follows.** A directory or
graph sync means the person genuinely moved team, so history STAYS — a reorg
must not hand February's consumption to March's Business Unit. An admin moving
somebody by hand is almost always correcting a mis-placement, so the record was
always wrong and history FOLLOWS. Only the two admin doors above can ask for it;
nothing under `server/reconciliation/**` or `server/workers/**` may even import
the module, and a test asserts both halves of that.

### `GET /api/v1/admin/reporting-snapshots/{month}`

`admin`/`global-finops`. Returns `null` when the month was never recorded —
distinct from recorded-and-unchanged, which comes back with
`chargeableUnchanged: true`.

| field | meaning |
|---|---|
| `snapshot` | what the month read when it was recorded, and who recorded it |
| `current` | what it reads now |
| `deltaUsd` | the movement, or `null` when the two are not comparable |
| `incomparableReason` | `basis-changed` / `version-changed` — why the arithmetic was withheld |
| `chargeableUnchanged` · `attributedMoved` | the two questions a reader actually asks |

The delta is the point of the snapshot: the bill lands after the month is
reported, so the product's job is to surface the movement rather than refuse the
correction. `chargeable` reads `v_finance_chargeback_month` (Anthropic ∪ Copilot
pooled, minus `copilot-unclassified`, which is counted and alerted but never
charged) — the same query that recorded it, so the delta cannot drift from what
it measures.

### `POST /api/v1/admin/users/{id}/placement-span`

`admin`/`global-finops` + CSRF + region scope. Writes nothing.

```jsonc
{ "range": { "from": "all" } }        // or { "from": "2026-06-01" }
```

| field | meaning |
|---|---|
| `sources[]` | `{ orgUnitId, displayName, usd, firstDay, lastDay }` per Business Unit the history sits under, largest first |
| `usd` | total §A usage in range |
| `spansMultipleUnits` | more than one source — moving "everything" collapses them into one |
| `current_org_unit_id` | where the person sits now |

Reads `v_complete_usage`, the same §A lane the Business Units page reads, so the
preview and the report agree. **Money and days, never rows** — that view fans
one key into several rows, so a row count is an artefact of the fan-out while
dollar totals are invariant across it.

There is no preview token (unlike Migrate): this is scoped to one teammate whose
row the PATCH locks `FOR UPDATE`, so the worst drift is a few dollars of newer
usage moving too, which is the intended outcome either way.

### `PATCH /api/v1/admin/users/{id}/org-unit` · `POST /api/v1/admin/users/bulk-place`

One additional optional field on each:

```jsonc
{ "org_unit_id": "<uuid>", "rehome": { "from": "all" } }   // or { "from": "2026-06-01" }
```

Omit `rehome` and behaviour, response shape and audit payload are unchanged —
placement moves, history does not.

With it, six tables follow in the same transaction as the `UPDATE teammate`:
`attribution_record`, `unaccounted_usage`, `over_emission`, `actual_spend`,
`reconciliation_record`, `spend_rollup_daily`. Three exclusions are deliberate:

- **`region_id` is never written.** Both doors are intra-region by construction;
  cross-region moves go through the region PATCH.
- **`attribution_record.cost_owning_unit_id` is never written.** On that table
  the column is the PROJECT's Business Unit and belongs to Migrate. Writing it
  here would silently re-home project spend as a side effect of moving a person.
  On `actual_spend` and `reconciliation_record` the same column IS the
  teammate's own, so it does follow, and `dimension_source` becomes
  `admin-correction`. It resolves to the **nearest active cost-owning ancestor**
  of the target, not the target itself: the endpoint allows placing somebody on
  a plain team node, and a team node bills to nothing. NULL when the ancestry
  has none — the `no-cost-owning-ancestor` diagnostic exists to surface exactly
  that, and inventing a value would hide it.
- **`provider_usage_fact` stays out.** §B homing is its own decision.

`spend_rollup_daily` is a MERGE, not an update: `org_unit_id` is part of its
unique grain, so amounts ADD onto any row the teammate already has under the
target. **The source is aggregated before the merge** — a teammate with rows
under two historical Business Units on one grain would otherwise feed two rows
into one target key and abort the whole statement ("ON CONFLICT DO UPDATE
command cannot affect row a second time"), taking the placement change with it.
That is what any second correction of the same person produces.

**Every day, including cold ones.** The archive floor marks when a day becomes
eligible for archiving, not that it was archived — and `v_complete_usage` reads
`attribution_record` directly, so a skipped row that still exists would leave
the rollup on the new Business Unit and every §A report on the old one. "All
history" means all history.

**Already in the target unit** is not automatically a no-op. Without `rehome` it
is — nothing is written, and crucially the manager-chain provenance is not
stripped, so the person stays re-derivable. WITH `rehome` it is a **history-only
repair**: the placement does not change and the stranded usage moves. That is
the common case on an estate where `bulk-place` corrected hundreds of people and
touched no spend row, and the alternative was moving somebody somewhere wrong and
back — two false audit entries to fix one real problem.

`outcome` is therefore `placed` | `noop` | `history-repaired`, and the bulk
response counts `historyRepaired` separately from `placed`: those people did not
move, so folding them together would report placements that never happened.

The response gains `rehomed` with a per-table count; the audit row records what
actually moved, not what was asked for, and marks a repair with
`rehome.historyOnly`.

**A history batch is capped at 50** (`BULK_REHOME_MAX`), refused by the schema
before any row is touched. Placement-only batches stay at 200. Six tables per
teammate in ONE transaction, with no `statement_timeout` anywhere, is a write
that outlives the browser while still committing — the Migrate failure below, on
a control that reaches it more easily.

The admin UI reflects all of this. On **Admin → Teammates**:

- The Business Unit picker opens a confirmation rather than applying on change —
  the same control can restate months of reported usage, and a stray keystroke
  on a focused select should not.
- The repair has its **own "Repair history" control** on the row. It is not
  reached by re-selecting the current unit in the picker: a `<select>` fires no
  `change` event for the option already selected, so that path is unreachable by
  hand (a synthetic `selectOption()` fires it, which is how two browser harnesses
  once certified it).
- Before applying, the confirmation names the amount, the Business Unit the
  usage is LEAVING and its date range, and warns when several units of history
  would collapse into one. Recorded days render in UTC and are never converted.
- Afterwards a **persistent receipt** — dismissed by the operator, not on a timer
  — gives the per-table counts and the figure that was approved. Any later
  message replaces it, so a stale success can never mask a fresh failure.

## Migrate — re-homing a project's recorded spend

`attribution_record.cost_owning_unit_id` is stamped when a usage row is written
and is never refreshed, so changing a project's Business Unit affects FUTURE
usage only. Migrate applies the change to usage already recorded.

Reachable only from these admin endpoints. Directory/graph placement never
re-homes recorded spend.

### `POST /api/v1/admin/projects/{id}/migrate-preview`

```jsonc
{
  "to_cost_owning_unit_id": "<uuid>",           // must be active, and in the project's region
  "range": { "from": "2026-08-01" }              // or { "from": "all", "confirm_unbounded": true }
}
```

Writes nothing. Returns:

| field | meaning |
|---|---|
| `affected[]` | `{ periodMonth, rows, usd }` per period that would change |
| `refused[]` | `{ periodMonth, rows, usd, reason }` — `archived` is the only reason; left alone and named |
| `fromCostOwningUnits[]` | every BU the rows are moving away from, with rows and dollars |
| `totalRows` / `totalUsd` | totals over `affected` only |
| `token` | binds this preview to the row set it described |

`from: "all"` means every recorded period and requires `confirm_unbounded: true`.
A month that has been snapshotted is still migrated: recording a month is a
snapshot, not a lock.

### `PATCH /api/v1/admin/projects/{id}`

Two additional optional fields, valid only together with `cost_owning_unit_id`:

```jsonc
{
  "cost_owning_unit_id": "<uuid>",
  "migrate_spend": { "from": "all", "confirm_unbounded": true },
  "migrate_expect_token": "<token from the preview>"   // required with migrate_spend
}
```

Omit `migrate_spend` and behaviour, response shape and audit payload are
unchanged.

The migrate runs in the same transaction as the project update, holds a
`reportingSnapshot` advisory lock for each period it touches, bumps
`ts_recorded` so the rollup worker recomputes, and skips archived days. On
success the response gains `migrated` (`rows_updated`, `usd_moved`,
`periods_affected`, `periods_refused`). The report cache is dropped after
commit.

A stale `migrate_expect_token` returns **409** with the CURRENT plan in
`data.current_plan`, so the caller can re-confirm against what is true now. When
that plan is empty **and refuses nothing** the spend is already on the destination — the commonest cause
is a large migration whose transaction committed after the client stopped
waiting — and the 409 says so rather than blaming a concurrent write. Re-running
is safe: the write is a stamp move, never an increment.

**409** when the token no longer matches the current plan — the response carries
`current_plan` so the caller can re-confirm. **400** when `migrate_spend` is sent
without `cost_owning_unit_id`, or without `migrate_expect_token`.

The `project-updated` audit row gains `migrate_spend` carrying every source BU,
the target, the range, rows updated, dollars moved (measured from the rows that
moved) and dollars planned, the affected periods and days, and every refusal.
