/*
 * drizzle/boot-sql.ts — the DDL primitives the BOOT-PATH scripts share.
 *
 * TWO scripts in `drizzle/` now issue DDL at boot: `provision-app-role.ts`
 * (creates the non-owner role) and `cutover-rls-sweep.ts` (the one-time RLS
 * DISABLE sweep). They were one file until an adversarial round showed the
 * sweep's trigger had been wrong three times running BECAUSE it was a side
 * effect of provisioning — see the header of `cutover-rls-sweep.ts`.
 *
 * Splitting them must not fork the identifier-safety layer. A second copy of
 * `execDdl` is exactly the "walk the sibling paths" failure this project keeps
 * paying for: the copy that gets the `format(%I)` treatment and the copy that
 * gets string concatenation look identical in review.
 *
 * WHY HERE AND NOT `server/`: the runtime image copies `node_modules`,
 * `.output`, `drizzle/`, `scripts/` and `entrypoint.sh` — NOT `server/`
 * (Dockerfile stage 4). Boot scripts run under `tsx` against those raw files, so
 * anything they import must live beside them.
 * `tests/unit/scripts/boot-path-imports.test.ts` makes that mechanical.
 */
import type postgres from 'postgres'

/**
 * The narrowest handle every helper here needs. `Sql` (a pool) and
 * `TransactionSql` (what `sql.begin` yields) both extend `postgres.ISql`, and
 * `TransactionSql` is NOT assignable to `Sql` — it has no `begin`/`end`. Typing
 * on the shared base is what lets the same `execDdl` run against the pool for
 * read-only probes and against the transaction for every write, with no casts.
 */
export type BootDb = postgres.ISql<Record<string, unknown>>

export interface PgErrorish {
  code?: string
  severity?: string
}

/** The SQLSTATE a postgres.js error carries, or undefined for a non-server error. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as PgErrorish).code : undefined
}

export interface BootDdl {
  /**
   * A role or table name cannot be a bind parameter, so it reaches the server
   * inside DDL text. This is a layer ON TOP of Postgres' own `format(%I)` in
   * {@link BootDdl.execDdl}, applied to the names the CALLER names — constants
   * in this repo — so that a future edit to one cannot turn it into identifier
   * injection.
   *
   * Names read out of `pg_class` are deliberately NOT passed through here: a
   * name that fails this pattern is a perfectly legal quoted identifier, and
   * refusing it would break on a schema this repo did not create. `format(%I)`
   * is the correct and sufficient layer for those.
   */
  assertSafeIdentifier(name: string, what: string): void
  /**
   * Render DDL server-side with `format()` and run it. `%I` quotes identifiers
   * and `%L` quotes literals using Postgres' own rules, so nothing is
   * concatenated in JavaScript.
   */
  execDdl(sql: BootDb, template: string, args: string[]): Promise<void>
}

/**
 * Bind the primitives to one script's log tag, so every message a caller can
 * produce is attributable to the step that produced it without threading the
 * tag through a dozen call sites.
 */
export function bootDdl(tag: string): BootDdl {
  return {
    assertSafeIdentifier(name: string, what: string): void {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
        throw new Error(`${tag} refusing to build DDL: ${what} '${name}' is not a plain lower-case identifier`)
      }
    },
    async execDdl(sql: BootDb, template: string, args: string[]): Promise<void> {
      const [row] = await sql<{ ddl: string }[]>`
        SELECT format(${template}::text, VARIADIC ${args}::text[]) AS ddl
      `
      if (!row?.ddl) throw new Error(`${tag} could not render DDL for: ${template}`)
      await sql.unsafe(row.ddl)
    },
  }
}
