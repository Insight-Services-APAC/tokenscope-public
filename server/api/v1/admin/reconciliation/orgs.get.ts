/*
 * GET /api/v1/admin/reconciliation/orgs — list EVERY provider_org (anthropic AND
 * github), joined to its provider_enterprise, with credential presence and (for
 * anthropic) the live health verdict. This generalises the anthropic-only
 * anthropic/orgs.get.ts into the cross-provider onboarding surface.
 *
 * Per row we surface:
 *   - provider, externalOrgId, displayName, reconciliationMode, billing, notes
 *   - apiKind (+ human label) for anthropic; null for github
 *   - the linked enterprise (id / display_name / external_id) when set
 *   - keyPresent: anthropic ⇒ resolveOrgApiKey(credential_secret_name) != null;
 *     github ⇒ the LINKED enterprise's credential is present (readSecret). The
 *     KEY ITSELF IS NEVER returned — only the boolean presence flag.
 *   - health: the anthropic computeOrgHealth verdict (key-format + live probe);
 *     null for github (no per-org Anthropic health model — github reconciles via
 *     the enterprise PAT, surfaced by enterprises.get / records).
 *
 * RBAC: requireRole(admin, global-finops). provider_org is a config table (no RLS
 * policy) → getDb() like regions.get.ts / the anthropic reader.
 *
 * SAFETY: the probe (computeOrgHealth) never throws and never leaks the key.
 */
import { defineEventHandler } from 'h3'
import { sql } from 'drizzle-orm'
import { requireRole } from '../../../../auth/rbac'
import { getDb } from '../../../../db'
import { resolveOrgApiKey } from '../../../../workers/analytics-poller'
import { readSecret } from '../../../../reconciliation/credentials'
import { computeOrgHealth, apiKindLabel, type AnthropicOrgRow } from '../../../../anthropic/org-health'
import type { AnthropicApiKind } from '../../../../reconciliation/adapters/registry'

interface Row extends Record<string, unknown> {
  id: string
  provider: string
  external_org_id: string
  display_name: string
  api_kind: string | null
  credential_secret_name: string | null
  reconciliation_mode: string
  billing: string
  notes: string | null
  provider_enterprise_id: string | null
  enterprise_external_id: string | null
  enterprise_display_name: string | null
  enterprise_credential_secret_name: string | null
  region_id: string | null
  region_code: string | null
  cost_owning_unit_id: string | null
  cost_owning_unit_code: string | null
}

function narrowApiKind(value: string | null): AnthropicApiKind {
  // CHECK-constrained (mig 0063) to the two anthropic kinds for anthropic rows;
  // treat anything unexpected as the conservative Admin default for display.
  return value === 'enterprise-analytics' ? 'enterprise-analytics' : 'claude-code-admin'
}

export default defineEventHandler(async (event) => {
  await requireRole(event, 'admin', 'global-finops')
  const db = getDb()

  const rows = await db.execute<Row>(sql`
    SELECT po.id::text AS id,
           po.provider,
           po.external_org_id,
           po.display_name,
           po.api_kind,
           po.credential_secret_name,
           po.reconciliation_mode,
           po.billing,
           po.notes,
           po.provider_enterprise_id::text AS provider_enterprise_id,
           pe.external_id AS enterprise_external_id,
           pe.display_name AS enterprise_display_name,
           pe.credential_secret_name AS enterprise_credential_secret_name,
           po.region_id::text AS region_id,
           rg.code AS region_code,
           po.cost_owning_unit_id::text AS cost_owning_unit_id,
           cou.code AS cost_owning_unit_code
    FROM provider_org po
    LEFT JOIN provider_enterprise pe ON pe.id = po.provider_enterprise_id
    LEFT JOIN region rg ON rg.id = po.region_id
    LEFT JOIN org_unit cou ON cou.id = po.cost_owning_unit_id
    ORDER BY po.provider, po.display_name
  `)

  // Read the endpoint once; computeOrgHealth folds an unset endpoint into an
  // amber 'endpoint-unset' verdict (not a throw, not a red error).
  const endpoint = process.env.NUXT_ANTHROPIC_API_ENDPOINT || undefined

  const orgs = []
  for (const r of [...rows]) {
    const enterprise = r.provider_enterprise_id
      ? {
          id: r.provider_enterprise_id,
          externalId: r.enterprise_external_id,
          displayName: r.enterprise_display_name,
        }
      : null

    if (r.provider === 'anthropic') {
      const apiKind = narrowApiKind(r.api_kind)
      // Presence ONLY — the key value never crosses this boundary.
      const keyPresent = resolveOrgApiKey(r.credential_secret_name) != null
      const orgRow: AnthropicOrgRow = {
        externalOrgId: r.external_org_id,
        displayName: r.display_name,
        apiKind,
        credentialSecretName: r.credential_secret_name,
        reconciliationMode: r.reconciliation_mode,
      }
      const health = await computeOrgHealth(orgRow, { endpoint })
      orgs.push({
        id: r.id,
        provider: r.provider,
        externalOrgId: r.external_org_id,
        displayName: r.display_name,
        apiKind,
        apiKindLabel: apiKindLabel(apiKind),
        credentialSecretName: r.credential_secret_name,
        reconciliationMode: r.reconciliation_mode,
        billing: r.billing,
        notes: r.notes,
        providerEnterpriseId: r.provider_enterprise_id,
        enterprise,
        regionId: r.region_id,
        regionCode: r.region_code,
        costOwningUnitId: r.cost_owning_unit_id,
        costOwningUnitCode: r.cost_owning_unit_code,
        keyPresent,
        health,
      })
    } else {
      // github: credential lives on the linked enterprise (one manage_billing PAT).
      const keyPresent =
        readSecret('github', r.enterprise_credential_secret_name) != null
      orgs.push({
        id: r.id,
        provider: r.provider,
        externalOrgId: r.external_org_id,
        displayName: r.display_name,
        apiKind: null,
        apiKindLabel: null,
        // github key-presence is driven by the LINKED ENTERPRISE's credential (one
        // manage_billing PAT), NOT the org's own credential_secret_name — which is
        // unused for github. Surface null here so the UI can't misread the org-level
        // name as the thing that drives keyPresent.
        credentialSecretName: null,
        reconciliationMode: r.reconciliation_mode,
        billing: r.billing,
        notes: r.notes,
        providerEnterpriseId: r.provider_enterprise_id,
        enterprise,
        regionId: r.region_id,
        regionCode: r.region_code,
        costOwningUnitId: r.cost_owning_unit_id,
        costOwningUnitCode: r.cost_owning_unit_code,
        keyPresent,
        // No per-org Anthropic-style health model for github (reconciled via the
        // enterprise PAT). Surfaced by enterprises.get / the records reader.
        health: null,
      })
    }
  }

  return { orgs, total: orgs.length }
})
