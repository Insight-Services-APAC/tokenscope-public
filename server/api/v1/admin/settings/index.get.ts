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
  // imageTag uses CONTAINER_APP_REVISION which Container Apps injects
  // automatically (no Bicep wiring needed); local dev leaves it null.
  const commitShaRaw = process.env.GIT_COMMIT_SHA
  const commitSha = commitShaRaw && commitShaRaw !== 'unknown'
    ? commitShaRaw
    : null
  const imageTagRaw = process.env.CONTAINER_APP_REVISION
  const imageTag = imageTagRaw && imageTagRaw.length > 0 ? imageTagRaw : null

  return {
    auth: {
      devMode: process.env.NUXT_OIDC_AUTH_DEV_MODE === 'true',
      allowPersonaOverride: isPersonaOverrideAllowed(),
      bootstrapAdminEmail: process.env.NUXT_BOOTSTRAP_ADMIN_EMAIL ?? '',
      // The structural posture: deployEnv is the classified identity and
      // demoCapable is whether persona/demo features can run AT ALL here. On a
      // pilot-prod env demoCapable=false even if allowPersonaOverride drifts true.
      deployEnv: currentServerDeployEnv(),
      demoCapable: isDemoCapableEnv(currentServerDeployEnv()),
    },
    build: {
      commitSha,
      imageTag,
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
