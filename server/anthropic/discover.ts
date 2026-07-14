/*
 * Anthropic org DISCOVERY — given a credential_secret_name, resolve its env key,
 * classify the key shape to pick the API variant, call the variant's cheapest
 * report for one in-range day, and read back the organization_id. This is the
 * onboarding probe behind POST .../reconciliation/anthropic/discover.
 *
 * SAFETY CONTRACT (same as health.ts): NEVER returns or logs the API key. The
 * result carries only the discovered organization_id, the detected api_kind, a
 * prefix-only keyFormatLooksLike, and — on failure — a SAFE classified reason
 * (the same RedReason vocabulary health.ts uses). No raw provider error text
 * (which could echo the key) is surfaced.
 *
 * Variant selection (per the spec):
 *   - admin-prefixed key (sk-ant-admin01-) → claude-code-admin: probe the
 *     claude_code usage report and read organization_id off a record.
 *   - otherwise → enterprise-analytics: call getUserUsageReport(limit 1) for a
 *     recent in-range day and read organization_id off the report.
 *
 * NUXT_ANTHROPIC_API_ENDPOINT unset → a clear 'endpoint-unset' result (not a
 * throw). 200-with-no-org-id / wrong-shape → 'parse-mismatch'. The route returns
 * 200 ONLY when an organization_id was read.
 */
import { AnthropicAnalyticsClient } from './client'
import { AnthropicEnterpriseClient } from './enterprise-client'
import { resolveOrgApiKey } from '../workers/analytics-poller'
import {
  classifyKeyShape,
  classifyProbe,
  probeDay,
  probeStartRfc3339,
  type KeyShape,
  type RedReason,
} from './health'
import type { AnthropicApiKind } from '../reconciliation/adapters/registry'

export interface DiscoverOk {
  ok: true
  organizationId: string
  apiKindDetected: AnthropicApiKind
  keyFormatLooksLike: KeyShape
}

export interface DiscoverFail {
  ok: false
  /** SAFE classified reason (health.ts vocabulary). NEVER the key/raw error. */
  reason: RedReason
  /** Present once a key resolved (prefix-only, key-body-free). */
  keyFormatLooksLike?: KeyShape
  /** Which variant we attempted (so the operator sees what was probed). */
  apiKindDetected?: AnthropicApiKind
}

export type DiscoverResult = DiscoverOk | DiscoverFail

/** Inject the report fetchers in tests (no network). Default = real clients. */
export interface DiscoverClients {
  enterprise: (
    endpoint: string,
    apiKey: string,
  ) => Pick<AnthropicEnterpriseClient, 'getUserUsageReport'>
  admin: (endpoint: string, apiKey: string) => Pick<AnthropicAnalyticsClient, 'getClaudeCodeUsage'>
}

const realClients: DiscoverClients = {
  enterprise: (endpoint, apiKey) => new AnthropicEnterpriseClient(endpoint, apiKey),
  admin: (endpoint, apiKey) => new AnthropicAnalyticsClient(endpoint, apiKey),
}

export interface DiscoverOpts {
  /** NUXT_ANTHROPIC_API_ENDPOINT (undefined/empty → endpoint-unset). */
  endpoint?: string
  now?: Date
  resolveKey?: (name: string | null | undefined) => string | null
  clients?: DiscoverClients
}

/**
 * Map a thrown client error to a SAFE RedReason. The clients throw
 * `Error('… HTTP <status>')` on a non-2xx; we parse the status out of the message
 * (the message is our own template, never the provider body) and reuse
 * classifyProbe. A transport throw with no HTTP status → connect-failed.
 */
function reasonFromThrow(err: unknown): RedReason {
  const msg = err instanceof Error ? err.message : ''
  const m = /HTTP (\d{3})/.exec(msg)
  if (m) {
    const status = Number(m[1])
    return classifyProbe({ ok: false, status, parsed: false }) ?? 'connect-failed'
  }
  return 'connect-failed'
}

/*
 * Discover the org for one credential_secret_name. Never throws — every failure
 * path returns a classified DiscoverFail. Returns ok only when an org id was read.
 */
export async function discoverAnthropicOrg(
  credentialSecretName: string,
  opts: DiscoverOpts = {},
): Promise<DiscoverResult> {
  const resolveKey = opts.resolveKey ?? resolveOrgApiKey
  const clients = opts.clients ?? realClients
  const now = opts.now ?? new Date()

  const key = resolveKey(credentialSecretName)
  if (!key) return { ok: false, reason: 'no-key' }

  const keyFormatLooksLike = classifyKeyShape(key)
  // Variant selection is prefix-only (never the key body): admin → claude-code-admin.
  const apiKindDetected: AnthropicApiKind =
    keyFormatLooksLike === 'admin' ? 'claude-code-admin' : 'enterprise-analytics'

  if (!opts.endpoint) {
    return { ok: false, reason: 'endpoint-unset', keyFormatLooksLike, apiKindDetected }
  }

  const day = probeDay(now)
  try {
    let organizationId: string | null | undefined
    if (apiKindDetected === 'claude-code-admin') {
      const report = await clients.admin(opts.endpoint, key).getClaudeCodeUsage({ startingAt: day })
      // organization_id rides each per-user record on the claude_code report.
      for (const rec of report.data) {
        if (rec.organization_id) {
          organizationId = rec.organization_id
          break
        }
      }
    } else {
      const report = await clients
        .enterprise(opts.endpoint, key)
        .getUserUsageReport({ startingAt: probeStartRfc3339(day) })
      organizationId = report.organization_id
    }

    if (!organizationId) {
      // Endpoint answered + parsed, but carried no organization_id (empty range /
      // wrong endpoint / shape drift). Same safe bucket as health's parse-mismatch.
      return { ok: false, reason: 'parse-mismatch', keyFormatLooksLike, apiKindDetected }
    }
    return { ok: true, organizationId, apiKindDetected, keyFormatLooksLike }
  } catch (err: unknown) {
    return { ok: false, reason: reasonFromThrow(err), keyFormatLooksLike, apiKindDetected }
  }
}
