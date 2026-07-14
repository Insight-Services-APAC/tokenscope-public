/*
 * Per-org Anthropic reconciliation health computation — the engine behind the
 * admin health route. Pure-ish + client-injectable so it unit-tests with mocked
 * clients (no network). NEVER returns/logs the API key (see health.ts contract).
 *
 * For each anthropic org it reports:
 *   - keyPresent    : is NUXT_ANTHROPIC_KEY_<name> set? (resolveOrgApiKey != null)
 *   - keyFormatOk   : does the key prefix match api_kind? (validateKeyFormat)
 *   - keyLooksLike  : which variant the key SHAPE looks like (prefix-only, safe)
 *   - connects      : a LIVE read-only probe verdict ('green' | 'red')
 *   - reason        : SAFE classified red reason (null when green)
 *   - color         : green | amber | red health badge
 */
import { AnthropicAnalyticsClient } from './client'
import { AnthropicEnterpriseClient } from './enterprise-client'
import { resolveOrgApiKey } from '../workers/analytics-poller'
import type { AnthropicApiKind } from '../reconciliation/adapters/registry'
import {
  validateKeyFormat,
  classifyKeyShape,
  classifyProbe,
  probeDay,
  probeStartRfc3339,
  type HealthColor,
  type RedReason,
  type KeyShape,
} from './health'

/** The provider_org fields the health computation needs. */
export interface AnthropicOrgRow {
  externalOrgId: string
  displayName: string
  apiKind: AnthropicApiKind
  credentialSecretName: string | null
  reconciliationMode: string
}

export interface OrgHealth {
  externalOrgId: string
  displayName: string
  apiKind: AnthropicApiKind
  /** "Enterprise Analytics" | "Claude Code (Admin)" — the human label. */
  apiKindLabel: string
  credentialSecretName: string | null
  reconciliationMode: string
  keyPresent: boolean
  /** null when no key present (nothing to validate). */
  keyFormatOk: boolean | null
  /** prefix-only shape classification; null when no key. NEVER the key body. */
  keyLooksLike: KeyShape | null
  /** 'green' (200 + parsed) | 'red' (classified failure). null when not probed. */
  connects: 'green' | 'red' | null
  reason: RedReason | null
  color: HealthColor
}

export function apiKindLabel(apiKind: AnthropicApiKind): string {
  return apiKind === 'enterprise-analytics' ? 'Enterprise Analytics' : 'Claude Code (Admin)'
}

/** Injectable client factories (overridden in tests; default = real clients). */
export interface HealthClients {
  enterprise: (endpoint: string, apiKey: string) => Pick<AnthropicEnterpriseClient, 'probe'>
  admin: (endpoint: string, apiKey: string) => Pick<AnthropicAnalyticsClient, 'probe'>
}

const realClients: HealthClients = {
  enterprise: (endpoint, apiKey) => new AnthropicEnterpriseClient(endpoint, apiKey),
  admin: (endpoint, apiKey) => new AnthropicAnalyticsClient(endpoint, apiKey),
}

export interface ComputeHealthOpts {
  /** NUXT_ANTHROPIC_API_ENDPOINT (undefined/empty => endpoint-unset, not red). */
  endpoint?: string
  /** Reference clock for the probe day. Defaults to now. */
  now?: Date
  /** Resolve the env key for a credential_secret_name. Defaults to resolveOrgApiKey. */
  resolveKey?: (name: string | null | undefined) => string | null
  clients?: HealthClients
}

/*
 * Compute health for ONE anthropic org. Order of verdicts:
 *   1. no key            -> red 'no-key' (cannot reconcile; not probed).
 *   2. key-format MISMATCH -> red 'key-format-mismatch' (do NOT probe — a wrong
 *      key against the wrong variant would 401/403 and muddy the signal).
 *   3. endpoint unset    -> red 'endpoint-unset' (cannot reach the API).
 *   4. live probe        -> green, or red with the classified reason.
 */
export async function computeOrgHealth(
  org: AnthropicOrgRow,
  opts: ComputeHealthOpts = {},
): Promise<OrgHealth> {
  const resolveKey = opts.resolveKey ?? resolveOrgApiKey
  const clients = opts.clients ?? realClients
  const now = opts.now ?? new Date()

  const base = {
    externalOrgId: org.externalOrgId,
    displayName: org.displayName,
    apiKind: org.apiKind,
    apiKindLabel: apiKindLabel(org.apiKind),
    credentialSecretName: org.credentialSecretName,
    reconciliationMode: org.reconciliationMode,
  }

  const key = resolveKey(org.credentialSecretName)
  if (!key) {
    // An INDICATIVE org legitimately has no key (telemetry-only, never reconciled) →
    // amber/info, not a red alarm. A RECONCILED org missing its key IS a config error → red.
    const reconciled = org.reconciliationMode === 'reconciled'
    return {
      ...base,
      keyPresent: false,
      keyFormatOk: null,
      keyLooksLike: null,
      connects: null,
      reason: 'no-key',
      color: reconciled ? 'red' : 'amber',
    }
  }

  const fmt = validateKeyFormat(org.apiKind, key)
  const looksLike = classifyKeyShape(key)
  if (!fmt.ok) {
    // A format mismatch is a config error — surface it without a live probe so the
    // red reason is unambiguous (probing with a mismatched key just yields 401/403).
    return {
      ...base,
      keyPresent: true,
      keyFormatOk: false,
      keyLooksLike: looksLike,
      connects: null,
      reason: 'key-format-mismatch',
      color: 'red',
    }
  }

  if (!opts.endpoint) {
    // Key present + well-formed, but no endpoint to reach. Amber (config gap, not
    // an auth failure) per the spec — endpoint-unset is NOT a red-error verdict.
    return {
      ...base,
      keyPresent: true,
      keyFormatOk: true,
      keyLooksLike: looksLike,
      connects: null,
      reason: 'endpoint-unset',
      color: 'amber',
    }
  }

  const day = probeDay(now)
  const probe =
    org.apiKind === 'enterprise-analytics'
      ? await clients.enterprise(opts.endpoint, key).probe(probeStartRfc3339(day))
      : await clients.admin(opts.endpoint, key).probe(day)

  const reason = classifyProbe(probe)
  if (reason === null) {
    return {
      ...base,
      keyPresent: true,
      keyFormatOk: true,
      keyLooksLike: looksLike,
      connects: 'green',
      reason: null,
      color: 'green',
    }
  }
  return {
    ...base,
    keyPresent: true,
    keyFormatOk: true,
    keyLooksLike: looksLike,
    connects: 'red',
    reason,
    color: 'red',
  }
}
