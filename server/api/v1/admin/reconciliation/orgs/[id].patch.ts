/*
 * PATCH /api/v1/admin/reconciliation/orgs/{id} — update a provider_org's
 * mutable fields: displayName, reconciliationMode, billing, apiKind,
 * credentialSecretName, providerEnterpriseId, notes.
 *
 * provider + external_org_id are IMMUTABLE here: provider flips the api_kind
 * invariant + the credential env-prefix, and external_org_id is half the UNIQUE
 * identity — re-keying an onboarded org is a delete+create, not a patch.
 *
 * Every supplied field is merged onto the current row and the FULL CHECK
 * invariant set is re-validated (mig 0063 api_kind + reconciled-credential +
 * charset), so a partial PATCH can't leave the row in a state the DB CHECK would
 * reject. Nullable fields use an explicit-null convention: omit a key to leave it
 * unchanged, pass null to clear it.
 *
 * RBAC: requireRole(admin, global-finops) + assertSameOrigin. Audited.
 */
import { defineEventHandler, createError, getRequestIP, getHeader } from 'h3'
import { readValidated } from '../../../../../utils/validated-body'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { requireRole } from '../../../../../auth/rbac'
import { assertSameOrigin } from '../../../../../auth/csrf'
import { withRequestRls } from '../../../../../db/request-rls'
import { recordAuditEvent } from '../../../../../db/audit'
import { requireUuidParam } from '../../../../../utils/require-uuid-param'
import { translatePgConstraintError } from '../../../../../utils/pg-constraint-error'
import { readSecret } from '../../../../../reconciliation/credentials'
import { validateKeyFormat } from '../../../../../anthropic/health'
import {
  reconciliationModeSchema,
  billingSchema,
  apiKindSchema,
  credentialSecretNameSchema,
  validateApiKindForProvider,
  validateReconciledCredential,
  type Provider,
  type ReconciliationMode,
} from '../../../../../reconciliation/provider-validation'
import type { AnthropicApiKind } from '../../../../../reconciliation/adapters/registry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Each key OPTIONAL: omit to leave unchanged. Nullable keys accept null to clear.
const Body = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    reconciliationMode: reconciliationModeSchema.optional(),
    billing: billingSchema.optional(),
    apiKind: apiKindSchema.nullish(),
    credentialSecretName: credentialSecretNameSchema.nullish(),
    providerEnterpriseId: z.string().regex(UUID_RE).nullish(),
    // ADR-0010 D4: the region this license-org bills to (regionForLicenseOrg / the bill-
    // driven provisioner's floor). null clears it.
    regionId: z.string().regex(UUID_RE).nullish(),
    // Reporting-consolidation Wave 0 (mig 0079): the GitHub-org → cost-owning-unit map. The
    // org's POOLED Copilot bill (copilot_pool_bill) homes to this CoU. null clears it (→ the
    // visible unallocated bucket). Must reference a cost-owning org_unit.
    costOwningUnitId: z.string().regex(UUID_RE).nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((d) => Object.keys(d).length > 0, 'at least one field must be supplied')

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid provider org update',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider org update',
      status: 400,
      detail,
    },
  })
}

interface CurrentRow extends Record<string, unknown> {
  provider: string
  external_org_id: string
  reconciliation_mode: string
  api_kind: string | null
  credential_secret_name: string | null
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-org id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k)

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<CurrentRow>(sql`
      SELECT provider, external_org_id, reconciliation_mode, api_kind, credential_secret_name
      FROM provider_org WHERE id = ${id}::uuid LIMIT 1
    `)
    const cur = [...rows][0]
    if (!cur) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider org not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider org not found',
          status: 404,
          detail: 'No provider_org matches the supplied id.',
        },
      })
    }
    const provider = cur.provider as Provider

    // Merge supplied fields onto current to validate the resulting row.
    const nextMode: ReconciliationMode = has('reconciliationMode')
      ? body.reconciliationMode!
      : (cur.reconciliation_mode as ReconciliationMode)
    const nextApiKind: AnthropicApiKind | null = has('apiKind')
      ? (body.apiKind ?? null)
      : (cur.api_kind as AnthropicApiKind | null)
    const nextCred: string | null = has('credentialSecretName')
      ? (body.credentialSecretName ?? null)
      : cur.credential_secret_name

    const apiKindErr = validateApiKindForProvider(provider, nextApiKind)
    if (apiKindErr) badRequest(apiKindErr)
    const credErr = validateReconciledCredential(provider, nextMode, nextCred)
    if (credErr) badRequest(credErr)

    // Key-shape write-guard (anthropic only): when the patch touches api_kind OR the
    // credential and a key is ALREADY wired for the (merged) credential name, the
    // key's prefix must match the (merged) api_kind. Rejects e.g. flipping an
    // sk-ant-admin01-keyed org to enterprise-analytics. Skipped when no key is wired
    // (key-presence is surfaced separately). The key is NEVER echoed.
    if (
      provider === 'anthropic' &&
      nextApiKind &&
      nextCred &&
      (has('apiKind') || has('credentialSecretName'))
    ) {
      const key = readSecret('anthropic', nextCred)
      if (key) {
        const fmt = validateKeyFormat(nextApiKind, key)
        if (!fmt.ok) {
          badRequest(
            `the wired key for '${nextCred}' looks like a ${fmt.looksLike} key, which does not match api_kind '${nextApiKind}'`,
          )
        }
      }
    }

    // Mapped region (when set) must exist (ADR-0010 D4).
    if (has('regionId') && body.regionId != null) {
      const regRows = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM region WHERE id = ${body.regionId}::uuid LIMIT 1
      `)
      if (![...regRows][0]) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Region not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Region not found',
            status: 404,
            detail: 'No region matches regionId.',
          },
        })
      }
    }

    // Mapped cost-owning unit (when set) must exist AND be a cost-owning unit (Copilot pooled
    // chargeback homes here — a non-CoU target would silently never surface as a charge).
    if (has('costOwningUnitId') && body.costOwningUnitId != null) {
      const ouRows = await tx.execute<{ is_cost_owning_unit: boolean }>(sql`
        SELECT is_cost_owning_unit FROM org_unit
        WHERE id = ${body.costOwningUnitId}::uuid AND retired_at IS NULL LIMIT 1
      `)
      const ou = [...ouRows][0]
      if (!ou) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Org unit not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Org unit not found',
            status: 404,
            detail: 'No active org_unit matches costOwningUnitId.',
          },
        })
      }
      if (!ou.is_cost_owning_unit) {
        badRequest('costOwningUnitId must reference a cost-owning org_unit (is_cost_owning_unit = true)')
      }
    }

    // Linked enterprise (when set) must exist + share provider.
    if (has('providerEnterpriseId') && body.providerEnterpriseId != null) {
      const entRows = await tx.execute<{ provider: string }>(sql`
        SELECT provider FROM provider_enterprise WHERE id = ${body.providerEnterpriseId}::uuid LIMIT 1
      `)
      const ent = [...entRows][0]
      if (!ent) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Enterprise not found',
          data: {
            type: 'https://tokenscope.example.com/errors/not-found',
            title: 'Enterprise not found',
            status: 404,
            detail: 'No provider_enterprise matches providerEnterpriseId.',
          },
        })
      }
      if (ent.provider !== provider) {
        badRequest(
          `providerEnterpriseId references a ${ent.provider} enterprise, but the org is ${provider}`,
        )
      }
    }

    // Build the SET list from only the supplied fields.
    const sets = []
    if (has('displayName')) sets.push(sql`display_name = ${body.displayName}`)
    if (has('reconciliationMode')) sets.push(sql`reconciliation_mode = ${nextMode}`)
    if (has('billing')) sets.push(sql`billing = ${body.billing}`)
    if (has('apiKind')) sets.push(sql`api_kind = ${nextApiKind}`)
    if (has('credentialSecretName')) sets.push(sql`credential_secret_name = ${nextCred}`)
    if (has('providerEnterpriseId'))
      sets.push(sql`provider_enterprise_id = ${body.providerEnterpriseId ?? null}::uuid`)
    if (has('regionId')) sets.push(sql`region_id = ${body.regionId ?? null}::uuid`)
    if (has('costOwningUnitId'))
      sets.push(sql`cost_owning_unit_id = ${body.costOwningUnitId ?? null}::uuid`)
    if (has('notes')) sets.push(sql`notes = ${body.notes ?? null}`)

    try {
      await tx.execute(sql`
        UPDATE provider_org SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid
      `)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23503': {
          status: 404,
          title: 'Enterprise not found',
          detail: 'The linked enterprise was deleted while updating the org.',
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-org-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-org',
      subjectId: id,
      payload: {
        provider,
        external_org_id: cur.external_org_id,
        changed: {
          ...(has('displayName') ? { display_name: body.displayName } : {}),
          ...(has('reconciliationMode') ? { reconciliation_mode: nextMode } : {}),
          ...(has('billing') ? { billing: body.billing } : {}),
          ...(has('apiKind') ? { api_kind: nextApiKind } : {}),
          ...(has('credentialSecretName') ? { credential_secret_name: nextCred } : {}),
          ...(has('providerEnterpriseId')
            ? { provider_enterprise_id: body.providerEnterpriseId ?? null }
            : {}),
          ...(has('regionId') ? { region_id: body.regionId ?? null } : {}),
          ...(has('costOwningUnitId') ? { cost_owning_unit_id: body.costOwningUnitId ?? null } : {}),
          ...(has('notes') ? { notes: body.notes ?? null } : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, updated: true }
  })
})
