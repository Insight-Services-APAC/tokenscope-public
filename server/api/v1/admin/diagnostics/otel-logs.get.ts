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
  // Optional query-endpoint override to TEST the Private Link path live, e.g.
  // ?endpoint=https://api.monitor.azure.com (the LA query endpoint over AMPLS).
  // Restricted to https monitor.azure.<tld> hosts so this can't be pointed at an
  // arbitrary server.
  endpoint: z
    .string()
    .url()
    .refine((u) => {
      try {
        const { protocol, hostname } = new URL(u)
        return protocol === 'https:' && /(^|\.)monitor\.azure\.[a-z]{2,}$/.test(hostname)
      } catch {
        return false
      }
    }, 'endpoint must be an https monitor.azure.<tld> host')
    .optional(),
})

export default defineEventHandler(async (event) => {
  // Platform-admin only — raw error/result packets are exposed here.
  await requireRole(event, 'platform-admin')

  const { hours, limit, endpoint } = await getValidated(event, QuerySchema)

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

  // ?endpoint= override (test-only) takes precedence over the env-configured one.
  const queryEndpoint = endpoint ?? process.env.NUXT_AZURE_MONITOR_QUERY_ENDPOINT
  const reader = new LogAnalyticsReader(workspaceId, { miClientId, queryEndpoint })

  // Never swallow: even an unexpected throw is returned raw (200 with the error
  // packet) so the operator always gets something pasteable.
  try {
    const result = await reader.diagnosticOtelLogs({ hours, limit })
    return { config, ...result }
  } catch (err) {
    return { config, fatalError: serializeQueryError(err) }
  }
})
