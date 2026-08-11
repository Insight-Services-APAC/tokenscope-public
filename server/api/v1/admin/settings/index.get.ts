/*
 * GET /api/v1/admin/settings — read-only configuration summary for the
 * Wave-VI Admin → Settings sub-page.
 *
 * RBAC: admin / global-finops only. RLS-aware on the region read so
 * RLS denial → no region surfaced (rather than leaking another region).
 *
 * The response is INTENTIONALLY narrow: only public configuration
 * fields land here. Secret material (CLIENT_SECRET, SESSION_SECRET,
 * HMAC_SESSION_KEY, etc.) is NEVER read in this handler — the
 * response shape doesn't even have a slot for them. If a future flag
 * adds something secret-shaped, add a separate handler and rotate this
 * one's tests to assert non-leakage.
 *
 * No mutations this wave — settings UI is a sectioned read-only view
 * (per Wave-VI brief §Out-of-scope).
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { withRequestRls } from '../../../../db/request-rls'
import { isPersonaOverrideAllowed } from '../../../../utils/auth'
import { currentServerDeployEnv, isDemoCapableEnv } from '../../../../../shared/env/deploy-env'
import { getSessionStoreHealth, type StorageLike } from '../../../../utils/session-store-health'

interface RegionRow extends Record<string, unknown> {
  id: string
  code: string
  display_name: string
}

export default defineEventHandler(async (event) => {
  const session = await requireRole(event, 'admin', 'global-finops')

  // Region lookup is RLS-scoped — RLS-denial would mean the caller's
  // session.regionId doesn't match any visible row (edge case: stale
  // session referencing a deleted region). Surface as `region: null`
  // rather than a 5xx.
  let region: { id: string; code: string; displayName: string } | null = null
  if (session.regionId) {
    const rows = await withRequestRls(event, async (tx) =>
      tx.execute<RegionRow>(sql`
        SELECT id::text AS id, code, display_name
        FROM region WHERE id = ${session.regionId}::uuid LIMIT 1
      `),
    )
    const row = [...rows][0]
    if (row) {
      region = { id: row.id, code: row.code, displayName: row.display_name }
    }
  }

  // Wave-VII: build-provenance section.
  //
  // commitSha source order (Bicep contract):
  //   1. infra/modules/container-app.bicep env GIT_COMMIT_SHA (operator
  //      override at deploy time) — wins if non-empty.
  //   2. Dockerfile ARG GIT_COMMIT_SHA baked at build time — kicks in
  //      when the Container App env entry is absent or empty.
  //
  // Container Apps explicitly overrides Dockerfile ENV when the platform
  // env entry is present (even if value is ''). The Bicep wiring sets
  // the entry unconditionally with `value: ''` when the override param is
  // empty — meaning the runtime env carries ''. We normalise empty/unset
  // to `null` here so the UI can show "unknown" uniformly.
  //
  // imageTag (CONTAINER_APP_REVISION) is DELIBERATELY not surfaced here —
  // commitSha already answers "what is deployed", and the revision name is
  // redundant infrastructure detail (server-api-app:deployment finding).
  const commitShaRaw = process.env.GIT_COMMIT_SHA
  const commitSha = commitShaRaw && commitShaRaw !== 'unknown'
    ? commitShaRaw
    : null

  // Session-store health (mig 0097). Reported here because the failure it
  // guards against is invisible from the outside — an unmounted driver leaves
  // the app building, booting and serving normally while silently keeping
  // sessions per-replica and in-memory. On a deployed environment kv_store is
  // behind a private endpoint, so this page is the only place the answer is
  // actually reachable by the person who needs it.
  // Resolving storage is itself guarded: `useStorage` is a Nitro runtime
  // auto-import that does not exist when this handler is invoked directly (the
  // admin integration tests do exactly that), and a diagnostic must never be
  // the reason the page it lives on stops rendering.
  let storage: StorageLike | null
  try {
    storage = useStorage() as unknown as StorageLike
  } catch {
    storage = null
  }
  const sessionStore = await getSessionStoreHealth(storage)

  return {
    sessionStore,
    auth: {
      devMode: process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true',
      allowPersonaOverride: isPersonaOverrideAllowed(),
      // The ADDRESS is not surfaced (app-frontend:secret_sprawl finding) —
      // only whether one is configured. The email itself adds nothing an
      // operator needs from THIS page; anyone provisioning bootstrap access
      // already knows the value they set.
      bootstrapAdminConfigured: Boolean(process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL),
      // The structural posture: deployEnv is the classified identity and
      // demoCapable is whether persona/demo features can run AT ALL here. On a
      // pilot-prod env demoCapable=false even if allowPersonaOverride drifts true.
      deployEnv: currentServerDeployEnv(),
      demoCapable: isDemoCapableEnv(currentServerDeployEnv()),
    },
    build: {
      commitSha,
    },
    // Provider key is `entra`, not `microsoft`. The Wave V env var names
    // set by infra/modules/container-app.bicep are
    // NUXT_OIDC_PROVIDERS_ENTRA_<FIELD>; any rename here MUST be made
    // alongside container-app.bicep AND oidc-auth.d.ts (the local
    // augment). Tenant/client IDs are public identifiers (per Microsoft
    // docs); CLIENT_SECRET is intentionally NOT read here.
    entra: {
      tenantId: process.env.NUXT_OIDC_PROVIDERS_ENTRA_TENANT_ID ?? '',
      clientId: process.env.NUXT_OIDC_PROVIDERS_ENTRA_CLIENT_ID ?? '',
      redirectUri: process.env.NUXT_OIDC_PROVIDERS_ENTRA_REDIRECT_URI ?? '',
    },
    // Feature-flag placeholder. Empty object is the canonical
    // "no flags wired yet" shape — clients can `Object.keys` it
    // safely. Wave-VI scope §Out-of-scope keeps this empty.
    features: {} as Record<string, boolean>,
    region,
    nodeEnv: process.env.NODE_ENV ?? 'development',
  }
})
