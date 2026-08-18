/*
 * drizzle/connect.ts — the single postgres.js client factory.
 *
 * Every process that talks to Postgres directly (the app pool, the
 * migration runner, the seed scripts, the worker CLI, the synthetic
 * emitters) MUST create its client through this factory instead of calling
 * `postgres(url, options)` itself. One call site is what makes the
 * connection's TLS posture auditable in one place instead of nine — a
 * future script that imports `postgres` directly and skips this factory is
 * exactly how a tenth un-verified connection creeps back in.
 *
 * TLS enforcement itself is server-side, in the connection STRING:
 * `?sslmode=verify-full` (set in infra/modules/keyvault-secrets.bicep) is
 * what makes postgres@3.4.9 authenticate the server. connection.js only
 * special-cases the literal strings 'require' / 'allow' / 'prefer' by
 * forcing `rejectUnauthorized: false`; a `verify-full` string matches none
 * of those branches and falls through to Node's default
 * `rejectUnauthorized: true` + hostname verification. So this factory does
 * NOT add a client-side `ssl` object — none is needed, and per-call-site
 * `ssl` objects are exactly the pattern this file exists to replace. Node
 * 24's bundled CA store already carries the Azure roots
 * (DigiCert Global Root G2, Microsoft RSA Root CA 2017).
 *
 * scripts/preflight.ts WARNs at boot when the resolved DATABASE_URL is a
 * non-loopback host without verify-full, so an environment whose KV secret
 * hasn't been rewritten yet is visible in the boot log instead of silently
 * connecting unauthenticated. That check reads DATABASE_URL directly (it
 * runs before any client exists) — it does not go through this factory.
 */
import postgres from 'postgres'

/**
 * The URL the RUNTIME pools connect with — `server/db/index.ts` (request lane)
 * and `server/db/worker-db.ts` (worker lane), and nothing else.
 *
 * `TOKENSCOPE_APP_DATABASE_URL` names the NON-OWNER role that makes the RLS
 * policies execute (`docs/design/rls-enforcement.md` §9; the role is minted by
 * `drizzle/provision-app-role.ts`). When it is unset — which is every
 * environment until someone deliberately sets it — this returns `DATABASE_URL`
 * and the app behaves exactly as it does today. **Unsetting it is the rollback**:
 * one variable, no code change, no migration to reverse.
 *
 * It lives beside the client factory for the same reason the factory exists: so
 * "which credential does this connection use" has ONE answer, in ONE file,
 * instead of a `process.env` read in each pool that can drift apart.
 *
 * `migrate.ts`, the seed scripts and `provision-app-role.ts` deliberately do NOT
 * call this. They must stay on the OWNER's `DATABASE_URL` — migrations have to
 * own their objects, and the provisioning script's `ALTER DEFAULT PRIVILEGES`
 * only covers objects created by the role that runs it.
 */
export function runtimeDatabaseUrl(): string | undefined {
  const appUrl = process.env.TOKENSCOPE_APP_DATABASE_URL?.trim()
  if (appUrl) return appUrl
  return process.env.DATABASE_URL
}

/**
 * Create a postgres.js client. `url` and `options` pass straight through —
 * this factory does not alter connection behaviour, it only makes the call
 * site singular. See the file header for why that matters.
 */
export function createDbClient(
  url: string,
  options?: postgres.Options<Record<string, postgres.PostgresType>>,
): postgres.Sql<Record<string, unknown>> {
  return postgres(url, options)
}
