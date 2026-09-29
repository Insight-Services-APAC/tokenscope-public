# Run locally

The whole emit → attribute → report loop runs on one machine with no Azure
account. Docker runs the backing services and a local stand-in for the Azure
Monitor telemetry store; the app runs with `npm run dev`.

## Prerequisites

- **Node.js 24+** and npm
- **Docker** with Compose v2.24 or later
- Optional: the **Claude Code** CLI, signed in, to send real telemetry
  ([Send real telemetry](#send-real-claude-code-telemetry))

## 1. Configure

```bash
git clone https://github.com/Insight-Services-APAC/tokenscope-public.git
cd tokenscope-public
npm install

cp .env.example .env
for k in NUXT_SESSION_SECRET NUXT_HMAC_SESSION_KEY NUXT_INTERNAL_WORKER_HMAC_KEY; do
  sed -i.bak "s|^$k=.*|$k=$(openssl rand -base64 48 | tr -d '\n')|" .env
done
rm -f .env.bak
```

`.env` is read by `npm run dev`, the `db:*` and `emit:*` scripts and the
worker runner. The defaults point at the local stack; the three secrets must
be at least 32 high-entropy characters or the app rejects sign-ins and worker
calls.

## 2. Start

```bash
npm run dev:stack     # backing services; waits for Postgres and Redis to be healthy
npm run db:migrate    # apply migrations (fresh database: ~150 files)
npm run db:seed       # regions, Business Units, teammates, projects, demo personas
npm run dev           # http://localhost:3450
```

The dev server listens on all interfaces (so container port-forwarding
works), and dev-mode sign-in lets anyone who reaches it pick any persona: run
it on a trusted network, or firewall port 3450.

Open <http://localhost:3450/login> and pick a demo persona: Developer, Manager,
Region admin, Global finance or Business Unit owner. Each lands on its own
reporting scope.

The stack's data lives in its containers. `npm run dev:stack:down` removes
them, and the next start needs `db:migrate` and `db:seed` again. To wipe and
reload the seed on a running stack: `SEED_RESET=true npm run db:seed`.

### What the stack runs

All ports bind to `127.0.0.1`. If one is taken, set its variable before
`npm run dev:stack` and update `.env` to match.

| Service | Host port | Role |
|---|---|---|
| postgres | 5432 (`TS_PG_PORT`) | The database |
| fake-azure-monitor | 4318 (`TS_AZMON_PORT`) | The telemetry store: receives OTLP logs at `/v1/logs` and serves them to the app |
| synthetic-anthropic-api | 8090 (`TS_ANTHROPIC_PORT`) | Stand-in for the Anthropic usage API |
| redis | 6379 (`TS_REDIS_PORT`) | Provisioned for parity; the app does not use it today |
| azurite | 10000 (`TS_AZURITE_PORT`) | Blob storage emulator; the app does not use it today |
| otel-collector | not published | A debug sink that logs whatever is sent to it; nothing sends to it by default |

## 3. Put data in it

**Demo data.** Writes ten synthetic sessions through the telemetry store and
the real read-joiner:

```bash
npm run emit:data
```

**Workers.** There is no scheduler locally. Run workers by hand; in Azure the
same code runs on a schedule:

```bash
npm run worker -- --list               # every worker, with its production schedule
npm run worker -- azure-monitor-read   # join new telemetry into attribution records
npm run worker -- aggregate-rollup     # refresh the consumption dashboards
npm run worker -- usage-rollup         # refresh the region reporting view
```

After new telemetry, run those three in order and reload the page.

### Send real Claude Code telemetry

```bash
npm run check:claude-emission-local
```

This registers a throwaway instance for the demo developer, runs one real
`claude -p` turn with the same exporter settings an enrolled device gets
(OTLP logs, `http/protobuf`, to the store's `/v1/logs`), runs the real
read-joiner and prints the attributed tokens and cost. It spends one short
turn. Claude Code runs in a throwaway home with your credentials file copied
in; where credentials live in the OS keychain (macOS), export
`ANTHROPIC_API_KEY` first instead. Each run adds one instance and its
attribution rows to the demo developer's data.

To watch a store directly:

```bash
curl -s http://127.0.0.1:4318/v1/sessions    # sessions the store has received
```

The store keys records on the `tokenscope.instance_id` resource attribute and
accepts OTLP/HTTP logs as protobuf or JSON, gzipped or not. It keeps them in
memory, so restarting the container empties it.

Run Claude Code from a directory **outside** any TokenScope-tagged repository
when you point it at the local store yourself. A tagged repo's
`.claude/settings.local.json` sets `OTEL_RESOURCE_ATTRIBUTES`, and settings take
precedence over your shell environment, so the turn would carry that repo's
instance instead of yours.

## Local vs Azure

The code is the same; what surrounds it is not. A green local run proves the
application logic and the client's wire format, not the Azure plumbing.

| Concern | Local | Azure |
|---|---|---|
| Telemetry ingest | `fake-azure-monitor` accepts any request; it checks no bearer and keeps records in memory | Data Collection Endpoint validates the device's bearer; a Data Collection Rule writes to Log Analytics |
| Telemetry read | `LocalCollectorReader` over HTTP (`NUXT_TELEMETRY_READER` unset) | `LogAnalyticsReader`: KQL against Log Analytics. The KQL never runs locally |
| Fields the reader returns | A subset: no backfill flag, no emitting email | All of them |
| Ingest bearer for devices | Mocked | Minted by the app's managed identity |
| Sign-in | Demo personas (`NUXT_OIDC_AUTH_DEV_MODE=true`) | Entra ID OIDC; dev mode is off and cannot be turned on |
| People directory | A small mock roster | Microsoft Graph |
| Workers | `npm run worker`: runs in-process, without the run lock and without a run record, so Diagnostics shows no worker history | Container Apps Jobs call the app's signed internal endpoint, which locks and records each run |
| Ops alerting | Not scheduled; no alert channel configured | `ops-alert` runs on a schedule and pages the configured channel |
| Anthropic usage | `synthetic-anthropic-api` | The real API, with a key |
| GitHub / Copilot billing | No stand-in | The real API, with a GitHub App or PAT |
| Database role | `tokenscope`, a superuser, which bypasses every row-level-security policy | By default the server admin login, which owns the tables and so is exempt from every policy not marked `FORCE`; an opt-in app-role cutover (`useAppRoleAtRuntime`) moves the app to a role the policies bind |
| Boot | You run `db:migrate` and `db:seed` | The container migrates and seeds on start (`entrypoint.sh`) |

What this means in practice:

- **A KQL or Log Analytics change needs Azure to verify.** Local tests exercise
  the store's normalisation, not the query.
- **Row-level-security behaviour needs the integration suite**, which provisions
  the non-superuser roles. Neither the local superuser nor a default Azure
  deployment exercises the policies the way the app role does.
- **Client changes** (plugin, exporter settings) are testable locally: Claude
  Code through the store path above, Copilot CLI with
  `npm run check:copilot-usage-e2e` (its own stub; needs a signed-in Copilot
  CLI).

## Tests

```bash
npm run test:unit           # fast unit tests
npm run test:integration    # integration tests (a real Postgres per file via testcontainers)
npm run typecheck
npm run lint
```

Integration tests need a container runtime for the throwaway Postgres. Without
a Docker socket, point `TEST_PG_URL` at any Postgres 16 server (with `ltree`,
`pgcrypto` and `btree_gist` available) and each test file provisions its own
database there. The repo's devcontainer (`.devcontainer/`) does this for you.
Two files that need a pristine cluster (Postgres roles are cluster-wide) skip
under `TEST_PG_URL` and run in CI.

## Next

- Deploy to Azure: [DEPLOY-AZURE.md](DEPLOY-AZURE.md)
- Configure providers and settings: [CONFIGURATION.md](CONFIGURATION.md)
- Onboard a real tool: [PROVIDERS.md](PROVIDERS.md)
