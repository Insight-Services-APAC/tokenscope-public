# Run locally

Everything runs on your machine — no Azure needed. The local stack uses Postgres,
Redis, a local OpenTelemetry collector, and fakes for the Azure Monitor and
provider APIs, so you can exercise the full emit → attribute → report loop
offline.

## Prerequisites

- **Node.js 24+** and **npm**.
- **Docker** (for the local stack: Postgres, Redis, OTel collector, fakes).

## Setup

```bash
git clone https://github.com/Insight-Services-APAC/tokenscope-public.git
cd tokenscope-public

cp .env.example .env.local     # fill in the placeholders (see below)
npm install
```

`.env.example` is the annotated template. For a first local run you mainly need:

- `DATABASE_URL` — points at the local Postgres from the stack.
- `NUXT_OIDC_AUTH_DEV_MODE=true` — skips real Entra sign-in and enables the demo
  personas.
- `NUXT_SESSION_SECRET`, `NUXT_HMAC_SESSION_KEY`, `NUXT_INTERNAL_WORKER_HMAC_KEY`
  — generate with `openssl rand -base64 48`.

## Start the stack + app

```bash
npm run dev:stack     # Postgres + Redis + local OTel collector + fakes (docker compose)
npm run dev           # the app on http://localhost:3450
```

`npm run dev:stack:status` shows the containers; `npm run dev:stack:down` tears
them down.

In dev mode you can switch between the demo personas (developer / manager /
admin / finance / cost-centre owner) to see each reporting scope.

## Database

Migrations run automatically, but you can drive them directly:

```bash
npm run db:migrate      # apply migrations
npm run db:seed         # seed synthetic org/region/demo data
```

## Workers

There is no in-app cron. Run a worker directly against the local DB:

```bash
npm run worker -- --list        # list registered workers
npm run worker -- <name>        # run one
```

The canonical worker list + recommended cadences is `server/workers/registry.ts`.

## Tests

```bash
npm run test:unit           # fast unit tests
npm run test:integration    # integration tests (spin up a real Postgres via testcontainers)
npm run typecheck
npm run lint
```

Integration tests need a container runtime for the throwaway Postgres. If your
environment has no Docker socket, point `TEST_PG_URL` at any Postgres 16 server
(with `ltree`, `pgcrypto`, `btree_gist` available) and the suites provision a
per-run throwaway database there.

## Next

- Deploy to Azure: [DEPLOY-AZURE.md](DEPLOY-AZURE.md)
- Configure providers + env: [CONFIGURATION.md](CONFIGURATION.md)
- Onboard a real tool: [PROVIDERS.md](PROVIDERS.md)
