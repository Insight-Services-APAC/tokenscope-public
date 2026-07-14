/*
 * PATCH /api/v1/admin/reconciliation/enterprises/{id} — update a
 * provider_enterprise's mutable fields: externalId, displayName,
 * reconciliationMode, billing, credentialSecretName, notes.
 *
 * provider is IMMUTABLE (it flips the credential env-prefix + the api_kind
 * relationship of any linked orgs). externalId, when supplied, is re-canonicalised
 * the same way as create (anthropic auto-lowercase; github mixed-case rejected) so
 * the mig-0062 lowercase CHECK never trips, and the case-insensitive UNIQUE is
 * pre-checked for a clean 409.
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
import {
  reconciliationModeSchema,
  billingSchema,
  credentialSecretNameSchema,
  githubAppIdSchema,
  canonicaliseExternalId,
  type Provider,
} from '../../../../../reconciliation/provider-validation'

const Body = z
  .object({
    externalId: z.string().min(1).max(200).optional(),
    displayName: z.string().min(1).max(200).optional(),
    reconciliationMode: reconciliationModeSchema.optional(),
    billing: billingSchema.optional(),
    credentialSecretName: credentialSecretNameSchema.nullish(),
    // ADR-0010 D1/D2 (Copilot only): whole-month flat seat price + per-user included
    // allowance, both USD. null clears (disables that bill component).
    flatSeatPriceUsd: z.number().min(0).max(1_000_000).nullish(),
    includedAllowanceUsd: z.number().min(0).max(1_000_000).nullish(),
    // Optional GitHub App id (mig 0078). Supply to opt into App mode; supply null to
    // clear it (revert to PAT). Absent key = unchanged. github-only (enforced below).
    githubAppId: githubAppIdSchema.nullish(),
    notes: z.string().max(2000).nullish(),
  })
  .refine((d) => Object.keys(d).length > 0, 'at least one field must be supplied')

function badRequest(detail: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: 'Invalid provider enterprise update',
    data: {
      type: 'https://tokenscope.example.com/errors/validation',
      title: 'Invalid provider enterprise update',
      status: 400,
      detail,
    },
  })
}

interface CurrentRow extends Record<string, unknown> {
  provider: string
  external_id: string
}

export default defineEventHandler(async (event) => {
  const caller = await requireRole(event, 'admin', 'global-finops')
  assertSameOrigin(event)
  const id = requireUuidParam(event, 'id', 'provider-enterprise id')
  const body = await readValidated(event, Body)
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? null
  const ua = getHeader(event, 'user-agent') ?? null

  const has = (k: keyof typeof body) => Object.prototype.hasOwnProperty.call(body, k)

  return await withRequestRls(event, async (tx) => {
    const rows = await tx.execute<CurrentRow>(sql`
      SELECT provider, external_id FROM provider_enterprise WHERE id = ${id}::uuid LIMIT 1
    `)
    const cur = [...rows][0]
    if (!cur) {
      throw createError({
        statusCode: 404,
        statusMessage: 'Provider enterprise not found',
        data: {
          type: 'https://tokenscope.example.com/errors/not-found',
          title: 'Provider enterprise not found',
          status: 404,
          detail: 'No provider_enterprise matches the supplied id.',
        },
      })
    }
    const provider = cur.provider as Provider

    // App mode is github-only (the App-id pairs with an installed GitHub App). Reject a
    // non-null github_app_id on an anthropic enterprise loudly. (A null is always fine —
    // it clears App mode.)
    if (has('githubAppId') && body.githubAppId != null && provider !== 'github') {
      badRequest('github_app_id is only valid for a github enterprise')
    }

    let nextExternalId = cur.external_id
    if (has('externalId')) {
      const canon = canonicaliseExternalId(provider, body.externalId!)
      if ('error' in canon) badRequest(canon.error)
      nextExternalId = canon.value
      // Pre-check the case-insensitive UNIQUE against OTHER rows (exclude self).
      const dupe = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM provider_enterprise
        WHERE provider = ${provider}
          AND lower(external_id) = lower(${nextExternalId})
          AND id <> ${id}::uuid
        LIMIT 1
      `)
      if ([...dupe][0]) {
        throw createError({
          statusCode: 409,
          statusMessage: 'Provider enterprise already exists',
          data: {
            type: 'https://tokenscope.example.com/errors/conflict',
            title: 'Provider enterprise already exists',
            status: 409,
            detail: `A ${provider} enterprise with external_id '${nextExternalId}' already exists.`,
          },
        })
      }
    }

    const sets = []
    if (has('externalId')) sets.push(sql`external_id = ${nextExternalId}`)
    if (has('displayName')) sets.push(sql`display_name = ${body.displayName}`)
    if (has('reconciliationMode')) sets.push(sql`reconciliation_mode = ${body.reconciliationMode}`)
    if (has('billing')) sets.push(sql`billing = ${body.billing}`)
    if (has('credentialSecretName'))
      sets.push(sql`credential_secret_name = ${body.credentialSecretName ?? null}`)
    // Bind money as a fixed-scale STRING, not a JS float, into numeric(14,6) — float
    // artifacts (e.g. 39.1) have no place in a finance column.
    if (has('flatSeatPriceUsd'))
      sets.push(sql`flat_seat_price_usd = ${body.flatSeatPriceUsd != null ? body.flatSeatPriceUsd.toFixed(6) : null}::numeric`)
    if (has('includedAllowanceUsd'))
      sets.push(sql`included_allowance_usd = ${body.includedAllowanceUsd != null ? body.includedAllowanceUsd.toFixed(6) : null}::numeric`)
    if (has('githubAppId')) sets.push(sql`github_app_id = ${body.githubAppId ?? null}`)
    if (has('notes')) sets.push(sql`notes = ${body.notes ?? null}`)

    try {
      await tx.execute(sql`
        UPDATE provider_enterprise SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid
      `)
    } catch (err: unknown) {
      translatePgConstraintError(err, {
        '23505': {
          title: 'Provider enterprise already exists',
          detail: `A ${provider} enterprise with external_id '${nextExternalId}' already exists.`,
        },
      })
    }

    await recordAuditEvent(tx, {
      eventType: 'provider-enterprise-updated',
      actorTeammateId: caller.teammateId,
      subjectKind: 'provider-enterprise',
      subjectId: id,
      payload: {
        provider,
        changed: {
          ...(has('externalId') ? { external_id: nextExternalId } : {}),
          ...(has('displayName') ? { display_name: body.displayName } : {}),
          ...(has('reconciliationMode') ? { reconciliation_mode: body.reconciliationMode } : {}),
          ...(has('billing') ? { billing: body.billing } : {}),
          ...(has('credentialSecretName')
            ? { credential_secret_name: body.credentialSecretName ?? null }
            : {}),
          ...(has('flatSeatPriceUsd') ? { flat_seat_price_usd: body.flatSeatPriceUsd ?? null } : {}),
          ...(has('includedAllowanceUsd')
            ? { included_allowance_usd: body.includedAllowanceUsd ?? null }
            : {}),
          ...(has('githubAppId') ? { github_app_id: body.githubAppId ?? null } : {}),
          ...(has('notes') ? { notes: body.notes ?? null } : {}),
        },
      },
      ipAddress: ip,
      userAgent: ua,
    })

    return { id, updated: true }
  })
})
