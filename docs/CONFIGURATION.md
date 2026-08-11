# Configuration

TokenScope is configured entirely by environment variables (no secrets in the
tree). Locally they live in `.env.local` (copy `.env.example`); in Azure they are
container-app env vars, with secrets sourced from Key Vault. This page groups the
variables by concern. **Required-to-boot** variables are marked ⛔.

> Runtime overlay: the app never reads `process.env` in build-time config — it
> declares placeholders and overlays real values at boot (`nuxt.config.ts`), so
> the same image runs in every environment.

## Core / boot ⛔

| Variable                                     | Purpose                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` ⛔                            | PostgreSQL connection string. Also used by the worker CLI.                                                                               |
| `REDIS_URL`                                  | Redis connection string (ephemeral state).                                                                                               |
| `NUXT_SESSION_SECRET` ⛔                     | Signs the app session.                                                                                                                   |
| `NUXT_HMAC_SESSION_KEY` ⛔                   | HMAC key for session integrity (≥32 chars).                                                                                              |
| `NUXT_INTERNAL_WORKER_HMAC_KEY` ⛔           | HMAC key the external scheduler signs worker calls with (≥32 chars). Separate from the session key.                                      |
| `NUXT_DEPLOY_ENV` / `NUXT_PUBLIC_DEPLOY_ENV` | `local` \| `sandbox` \| `dev` \| `staging` \| `production`. Drives the demo-capable allowlist (only `local`/`sandbox` are demo-capable). |

## Auth / OIDC (Microsoft Entra)

Optional during first bring-up (dev mode); required for real sign-in.

| Variable                                                                                                                                                                 | Purpose                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `NUXT_OIDC_AUTH_DEV_MODE`                                                                                                                                                | `true` locally disables real OIDC and enables the persona cookie. **Must be `false` in production.**     |
| `NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` / `_AUTHORIZATION_URL` / `_TOKEN_URL` / `_TENANT_ID` / `_LOGOUT_URL` / `_LOGOUT_REDIRECT_URI` | Entra OIDC app registration wiring.                                                                      |
| `NUXT_OIDC_SESSION_SECRET` / `NUXT_OIDC_AUTH_SESSION_SECRET` / `NUXT_OIDC_TOKEN_KEY`                                                                                     | OIDC module encryption keys — **must stay stable across revisions** or every session breaks on redeploy. |
| `NUXT_ALLOW_PERSONA_OVERRIDE`                                                                                                                                            | Demo persona impersonation gate. **Must be `false` in production.**                                      |
| `NUXT_BOOTSTRAP_ADMIN_EMAIL`                                                                                                                                             | First matching Entra sign-in becomes `admin` on JIT creation.                                            |
| `NUXT_OAUTH_CLIENT_ID` / `NUXT_ENROLLMENT_SECRET`                                                                                                                        | MCP OAuth + device-enrolment.                                                                            |

## Telemetry read path (Azure Log Analytics)

| Variable                            | Purpose                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NUXT_TELEMETRY_READER`             | `log-analytics` to enable the read-joiner; empty = off.                                                                                                                                                                                                                                                                              |
| `NUXT_LOG_ANALYTICS_WORKSPACE_ID`   | The workspace the read-joiner queries.                                                                                                                                                                                                                                                                                               |
| `NUXT_AZURE_MI_CLIENT_ID`           | User-assigned managed identity client id (query + ingest auth).                                                                                                                                                                                                                                                                      |
| `NUXT_AZURE_MONITOR_AUTH`           | `mi` for managed identity.                                                                                                                                                                                                                                                                                                           |
| `NUXT_AZURE_MONITOR_LOGS_ENDPOINT`  | Full DCR OTLP-logs ingest URL.                                                                                                                                                                                                                                                                                                       |
| `NUXT_AZURE_MONITOR_ENDPOINT`       | Local/dev collector endpoint the reader queries; also the logs-ingest fallback when `_LOGS_ENDPOINT` is unset.                                                                                                                                                                                                                       |
| `NUXT_AZURE_MONITOR_QUERY_ENDPOINT` | Log Analytics query endpoint (leave default unless private-linked).                                                                                                                                                                                                                                                                  |
| `NUXT_JOINER_INSTANCE_CAP`          | Max instances scanned per read tick (default 500). Raise this — not the liveness window — if `worker_run.result->>'selectionCapHit'` is non-null.                                                                                                                                                                                    |
| `NUXT_JOINER_LIVE_BEARER_HOURS`     | How recently an open instance must have minted an ingest bearer to count as live and be re-scanned, regardless of enrolment age (default 336 = 14 days; min 1, max 2160 = 90 days). Widening is safe but enlarges the selection against `NUXT_JOINER_INSTANCE_CAP`; out-of-range values fall back to the default or clamp, and warn. |
| `NUXT_COPILOT_NATIVE_OTEL`          | `true` enables the native Copilot GenAI read-side (default off).                                                                                                                                                                                                                                                                     |

## Directory placement (Microsoft Graph)

| Variable                    | Purpose                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `NUXT_GRAPH_DIRECTORY_MODE` | `graph` to place teammates from Entra (cost-centre + manager chain); empty = mock. |
| `NUXT_GRAPH_BASE_URL`       | Microsoft Graph base URL.                                                          |

Placement precedence, most-specific first: a manager-chain **unit** match wins;
otherwise a configurable **directory-attribute → region rule**; otherwise a
manager-chain **region** leader. The attribute-rule step lets each tenant map a
region-correlated directory field (company name, country, office location,
state, or department) to a region, curated in the admin **Region rules**
surface — so directories where region tracks an attribute rather than the
manager chain still place correctly.

## Providers

| Variable                                                     | Purpose                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `NUXT_ANTHROPIC_API_ENDPOINT`                                | `https://api.anthropic.com` on reconciled envs; empty = poller no-op.                                                                   |
| `NUXT_ANTHROPIC_KEY_<SUFFIX>`                                | Admin API key for the Anthropic analytics poller (per-org).                                                                             |
| `NUXT_GITHUB_PAT_<SUFFIX>`                                   | GitHub PAT (`manage_billing:enterprise`) for Copilot billing reconciliation; name derived from the provider's `credential_secret_name`. |
| `NUXT_GITHUB_APP_KEY_<SUFFIX>`                               | GitHub App private key (base64 PEM) for App-mode reconciliation.                                                                        |
| `NUXT_GITHUB_CHARGEBACK_EXEMPT_ENTERPRISES` / `_EXEMPT_ORGS` | Pooled-chargeback exemptions.                                                                                                           |
| `NUXT_COPILOT_CHARGEBACK_ENABLED`                            | Gate Copilot §B chargeback (default off → usage-vs-pool showback).                                                                      |

## Tuning (all optional, sensible defaults)

`NUXT_RECONCILIATION_GAP_PCT` / `_GAP_USD`, `NUXT_HEARTBEAT_GRACE_MINUTES` /
`_LOOKBACK_DAYS`, `NUXT_BASE_ALLOWANCE_USD`, `LEDGER_ROLLUP_FREEZE_FLOOR_DAYS`,
`MAX_PROVISIONAL_INSTANCES` / `_PER_EMAIL`, `MAX_LIVE_EMIT_INSTANCES` /
`_PER_TEAMMATE`.

The four `MAX_*_INSTANCES*` caps come in pairs, one pair per provisioning door:
`MAX_PROVISIONAL_*` bounds the unauthenticated enrol path
(`server/auth/enroll-provision.ts`), `MAX_LIVE_EMIT_*` bounds the authenticated
one (`server/auth/emit-provision.ts`). Each pair is a per-identity bound plus a
global DoS backstop. Note that one human who uses BOTH Claude Code and Copilot
CLI on one host consumes TWO instances, since an instance is bound to a single
emit tool, so size the per-identity caps for tools-per-person, not people.

## Azure-injected (set by the deploy, not by you)

`APP_PUBLIC_ORIGIN`, `AZURE_FRONT_DOOR_ID`, `AZURE_CLIENT_ID`,
`AZURE_KEYVAULT_URL`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `GIT_COMMIT_SHA`,
`NITRO_PORT`, `NODE_ENV`, `NUXT_SECURITY_RATE_LIMITER_IP_HEADER`
(`x-azure-clientip` only when Front Door is enforced).

`CONTAINER_APP_NAME`, `CONTAINER_APP_ENV_DNS_SUFFIX` and
`CONTAINER_APP_HOSTNAME` are injected by the Container Apps platform itself (no
Bicep entry). The MCP transport derives the hostnames it answers to from them —
see [MCP host verification](development/mcp-host-verification.md).

`MCP_ALLOWED_HOSTS` (Bicep param `mcpAllowedHosts`, empty by default) is a
**break-glass** comma-separated list of EXTRA hostnames the MCP transport should
answer to, for a fronting topology the derivation above does not model (custom
backend domain, private DNS alias, traffic-label FQDN). Reach for it when MCP
returns `Invalid Host header` on a deployment you cannot immediately re-derive;
prefer fixing the derivation afterwards.

## Workers / scheduler

Workers are triggered by an **external scheduler** POSTing to an HMAC-signed
endpoint — there is no in-app cron:

```
POST /api/v1/internal/run-worker/{name}
X-Internal-Timestamp: <unix seconds>
X-Internal-Signature: hex(HMAC-SHA256(key, `${ts}\n${method}\n${path}\n${sha256(body)}`))
```

Key = `NUXT_INTERNAL_WORKER_HMAC_KEY`; replay window ±300 s. The **source of
truth for worker names and cadences is `server/workers/registry.ts`** (each entry
carries a `recommendedCron`). The Azure deploy ships Container Apps Jobs
(`scripts/cron-trigger.mjs`) to drive them; locally, run one directly with
`npm run worker -- <name>` (or `--list`).
