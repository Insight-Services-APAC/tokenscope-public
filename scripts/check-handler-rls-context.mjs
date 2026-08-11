#!/usr/bin/env node
/*
 * check-handler-rls-context.mjs — CI guard, pulled forward from UF-1(a).
 *
 * `FORCE ROW LEVEL SECURITY` is deliberately NOT enabled yet (see S11 /
 * urgent-follow-sprint.md UF-1): only 126 of 173 API handlers set the RLS
 * session GUCs via server/db/request-rls.ts::withRequestRls (or the
 * pre-Epic-4 server/db/rls.ts::withRlsContext directly) — 47 call
 * server/db/index.ts::getDb() directly instead, which means their queries
 * run with NO RLS context. Enabling FORCE now would make those 47 either
 * silently return zero rows (SELECT) or error (INSERT/UPDATE/DELETE).
 *
 * This check does NOT fix those 47 — that is UF-1's job, gated on FORCE
 * landing. It only stops the count drifting from 47 to 48+ while UF-1
 * waits: any NEW file under server/api/** that calls getDb() directly
 * fails CI. Existing debt is allowlisted below.
 *
 * The allowlist was generated mechanically, not hand-typed:
 *   grep -rl 'getDb(' server/api/ | sort
 * Re-run that and diff against ALLOWLIST if a handler is migrated to
 * withRequestRls() and should be dropped — shrinking the allowlist never
 * fails this check, only growing it does.
 *
 * Run: npm run check:handler-rls-context
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = resolve(root, 'server/api')

// Generated via `grep -rl 'getDb(' server/api/ | sort` on 2026-07-27 — 47 entries.
export const ALLOWLIST = new Set([
  'server/api/health.get.ts',
  'server/api/v1/admin/directory/search.get.ts',
  'server/api/v1/admin/grants/[id]/revoke.post.ts',
  'server/api/v1/admin/grants/index.get.ts',
  'server/api/v1/admin/org-units/[id]/owners.post.ts',
  'server/api/v1/admin/projects/[id]/assignments.post.ts',
  'server/api/v1/admin/reconciliation/anthropic/health.get.ts',
  'server/api/v1/admin/reconciliation/enterprises.get.ts',
  'server/api/v1/admin/reconciliation/github/health.get.ts',
  'server/api/v1/admin/reconciliation/github/teammate-search.get.ts',
  'server/api/v1/admin/reconciliation/github/unresolved.get.ts',
  'server/api/v1/admin/reconciliation/orgs.get.ts',
  'server/api/v1/admin/regions.get.ts',
  'server/api/v1/admin/teammates.post.ts',
  'server/api/v1/admin/workers/[name]/run.post.ts',
  'server/api/v1/auth/dev-login.post.ts',
  'server/api/v1/auth/logout.post.ts',
  'server/api/v1/auth/stop-impersonating.post.ts',
  'server/api/v1/instances/[instanceId].delete.ts',
  'server/api/v1/instances/[instanceId]/bearer.get.ts',
  'server/api/v1/instances/[instanceId]/end.post.ts',
  'server/api/v1/instances/[instanceId]/health.get.ts',
  'server/api/v1/instances/[instanceId]/project-resolve.get.ts',
  'server/api/v1/internal/run-worker/[name].post.ts',
  'server/api/v1/me/grants/[id]/revoke.post.ts',
  'server/api/v1/me/grants/index.get.ts',
  'server/api/v1/me/identities.get.ts',
  'server/api/v1/me/identities.post.ts',
  'server/api/v1/me/identities/[id].delete.ts',
  'server/api/v1/me/inbox/[id].patch.ts',
  'server/api/v1/me/inbox/[id]/route.post.ts',
  'server/api/v1/me/instances/[instanceId]/revoke.post.ts',
  'server/api/v1/me/over-emission/[id]/resolve.post.ts',
  'server/api/v1/me/projects.get.ts',
  'server/api/v1/me/provisional-instances.get.ts',
  'server/api/v1/me/provisional-instances/[instanceId]/confirm.post.ts',
  'server/api/v1/me/sessions/[sid]/assign.post.ts',
  'server/api/v1/me/unaccounted/[id]/assign.post.ts',
  'server/api/v1/me/worklist/bulk.post.ts',
  'server/api/v1/oauth/authorize.get.ts',
  'server/api/v1/oauth/authorize.post.ts',
  'server/api/v1/oauth/register.post.ts',
  'server/api/v1/oauth/revoke.post.ts',
  'server/api/v1/oauth/token.post.ts',
  'server/api/v1/projects/[id]/consumption.get.ts',
  'server/api/v1/setup/enroll.post.ts',
  'server/api/v1/setup/redeem.post.ts',
])

const DIRECT_CALL_RE = /\bgetDb\s*\(/

/** Recursively list every .ts file under `dir`. Exported for the unit test. */
export function walkTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      walkTsFiles(full, out)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** True if the handler source calls getDb() directly. Exported for the unit test. */
export function callsGetDbDirectly(source) {
  return DIRECT_CALL_RE.test(source)
}

function main() {
  const files = walkTsFiles(API_DIR)
  const seen = new Set()
  let failed = false

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    const body = readFileSync(file, 'utf8')
    if (!callsGetDbDirectly(body)) continue
    seen.add(rel)
    if (!ALLOWLIST.has(rel)) {
      console.error(
        `✗ ${rel}: calls getDb() directly. New server/api/** handlers must go through ` +
          `withRequestRls() (server/db/request-rls.ts) — or withRlsContext() pre-Epic-4 — ` +
          `so the RLS session GUCs are set. If this genuinely cannot use RLS context, add it ` +
          `to ALLOWLIST in scripts/check-handler-rls-context.mjs with a comment explaining why.`,
      )
      failed = true
    }
  }

  const stale = [...ALLOWLIST].filter((f) => !seen.has(f))
  if (stale.length > 0) {
    console.log(
      `ℹ ${stale.length} allowlist entr${stale.length === 1 ? 'y' : 'ies'} no longer call(s) getDb() directly — safe to drop (regenerate with: grep -rl 'getDb(' server/api/ | sort):`,
    )
    for (const f of stale) console.log(`  - ${f}`)
  }

  if (failed) {
    console.error(`\nSee UF-1(a) / urgent-follow-sprint.md — this check only stops the count growing past today's ${ALLOWLIST.size}.`)
    process.exit(1)
  }
  console.log(`✓ no new direct getDb() calls in server/api/** (${ALLOWLIST.size} pre-existing, tracked, gated on UF-1/FORCE)`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
