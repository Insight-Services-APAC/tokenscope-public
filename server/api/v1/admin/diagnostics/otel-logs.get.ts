/*
 * GET /api/v1/admin/diagnostics/otel-logs — RAW OTelLogs diagnostic, queried via
 * the app's Managed Identity (the only identity inside the NSP perimeter that can
 * reach the dev Log Analytics workspace).
 *
 * RBAC: platform-admin ONLY. This returns RAW Azure result/error packets (status,
 * error codes, the inner NspValidationFailedError, partial errors, the exact KQL),
 * so it is gated at the highest tier — not the per-region `admin`. The reader is
 * careful to exclude request/response objects (which carry the auth bearer).
 *
 * Read-only. FIXED KQL parameterised only by clamped ?hours= (1..168, default 24)
 * and ?limit= (1..100, default 20) — no caller-supplied query, no injection.
 *
 * Why this exists: the dev workspace is in-VNet-locked (publicNetworkAccessForQuery
 * Disabled + a Network Security Perimeter). Laptops, Azure Cloud Shell, and CI
 * runners all hit the NSP deny. So "is Claude telemetry actually landing, and if
 * not, what exactly fails?" can ONLY be answered from inside the app.
 */
import { defineEventHandler, createError } from 'h3'
import { getValidated } from '../../../../utils/validated-body'
import { z } from 'zod'
import { requireRole } from '../../../../auth/rbac'
import { LogAnalyticsReader, serializeQueryError } from '../../../../azure/reader'

const QuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // NO caller-supplied query-endpoint override. There used to be one here
  // ("test the Private Link path live"), allowlisted by a hostname regex
  // (`/(^|\.)monitor\.azure\.[a-z]{2,}$/`) — but that regex classifies a
  // STRING, and a wildcard TLD is not a network boundary: it let a caller
  // steer this Managed-Identity-authenticated outbound query at any host
  // matching the pattern. reader.ts's own comment records that the override
  // was added on wrong guidance and that the SDK default already reaches the
  // private AMPLS path — it "MUST be left empty on dev/sandbox". The fix is
  // to remove the parameter, not to tighten the regex: the reader's
  // env-sourced `queryEndpoint` option stays for real overrides that need a
  // deploy to change.
})

export default defineEventHandler(async (event) => {
  // Platform-admin only — raw error/result packets are exposed here.
  await requireRole(event, 'platform-admin')

  const { hours, limit } = await getValidated(event, QuerySchema)

  const workspaceId = process.env.NUXT_LOG_ANALYTICS_WORKSPACE_ID
  const miClientId = process.env.NUXT_AZURE_MI_CLIENT_ID
  // Config echo so the operator can see the wiring (MI client id is a GUID, not a
  // secret). NEVER echo bearer/keys here.
  const config = {
    telemetryReader: process.env.NUXT_TELEMETRY_READER ?? null,
    workspaceIdSet: Boolean(workspaceId),
    miClientId: miClientId ?? null,
    logsEndpointHost: (() => {
      try {
        return new URL(process.env.NUXT_AZURE_MONITOR_LOGS_ENDPOINT ?? '').host
      } catch {
        return null
      }
    })(),
  }

  if (process.env.NUXT_TELEMETRY_READER !== 'log-analytics' || !workspaceId) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Log Analytics reader not configured',
      data: { config },
    })
  }

  const queryEndpoint = process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT
  const reader = new LogAnalyticsReader(workspaceId, { miClientId, queryEndpoint })

  // Never swallow: even an unexpected throw is returned raw (200 with the error
  // packet) so the operator always gets something pasteable.
  try {
    // `workspaceId` deliberately stripped from the spread: the UI's
    // `config.workspaceIdSet` boolean already answers "is a workspace
    // configured" without echoing the GUID itself.
    const { workspaceId: _workspaceId, ...result } = await reader.diagnosticOtelLogs({ hours, limit })
    void _workspaceId
    return { config, ...result }
  } catch (err) {
    return { config, fatalError: serializeQueryError(err) }
  }
})
