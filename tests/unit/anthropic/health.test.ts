/*
 * Anthropic reconciliation health — unit tests for the admin health/validation
 * logic (server/anthropic/health.ts + org-health.ts). Pure + client-injectable,
 * so no network/DB. The load-bearing safety property: the API key never leaks
 * into the OrgHealth output.
 */
import { describe, it, expect } from 'vitest'
import {
  ADMIN_KEY_PREFIX,
  classifyKeyShape,
  validateKeyFormat,
  classifyProbe,
  probeDay,
  probeStartRfc3339,
} from '../../../server/anthropic/health'
import { computeOrgHealth, type AnthropicOrgRow } from '../../../server/anthropic/org-health'

const ADMIN_KEY = `${ADMIN_KEY_PREFIX}abc123secretbody`
const ANALYTICS_KEY = 'sk-ant-analytics-XYZsecretbody'

describe('classifyKeyShape', () => {
  it('admin prefix -> admin; anything else -> analytics', () => {
    expect(classifyKeyShape(ADMIN_KEY)).toBe('admin')
    expect(classifyKeyShape(ANALYTICS_KEY)).toBe('analytics')
    expect(classifyKeyShape('garbage')).toBe('analytics')
  })
})

describe('validateKeyFormat — prefix vs api_kind', () => {
  it('claude-code-admin requires the Admin prefix', () => {
    expect(validateKeyFormat('claude-code-admin', ADMIN_KEY).ok).toBe(true)
    expect(validateKeyFormat('claude-code-admin', ANALYTICS_KEY).ok).toBe(false)
  })
  it('enterprise-analytics must NOT look like an Admin key (negative validation)', () => {
    expect(validateKeyFormat('enterprise-analytics', ANALYTICS_KEY).ok).toBe(true)
    expect(validateKeyFormat('enterprise-analytics', ADMIN_KEY).ok).toBe(false)
  })
})

describe('classifyProbe — status -> safe reason', () => {
  it('maps each status to its classified reason', () => {
    expect(classifyProbe({ ok: true, status: 200, parsed: true })).toBeNull()
    // 400 is a REQUEST error (e.g. the missing ending_at), distinct from connect-failed.
    expect(classifyProbe({ ok: false, status: 400, parsed: false })).toBe('400-bad-request')
    expect(classifyProbe({ ok: false, status: 401, parsed: false })).toBe('401-unauthorized')
    expect(classifyProbe({ ok: false, status: 403, parsed: false })).toBe('403-forbidden-scope')
    expect(classifyProbe({ ok: false, status: 404, parsed: false })).toBe('404-wrong-endpoint')
    expect(classifyProbe({ ok: false, status: 429, parsed: false })).toBe('429-rate-limited')
    expect(classifyProbe({ ok: false, status: 200, parsed: false })).toBe('parse-mismatch')
    expect(classifyProbe({ ok: false, status: 0, parsed: false })).toBe('connect-failed')
    expect(classifyProbe({ ok: false, status: 503, parsed: false })).toBe('connect-failed')
  })
})

describe('probeDay — recent past day, clamped to the data floor', () => {
  it('returns yesterday (UTC)', () => {
    expect(probeDay(new Date('2026-06-23T10:00:00Z'))).toBe('2026-06-22')
  })
  it('clamps to the 2026-01-01 data floor', () => {
    expect(probeDay(new Date('2026-01-01T10:00:00Z'))).toBe('2026-01-01')
  })
  it('probeStartRfc3339 makes a start-of-day timestamp', () => {
    expect(probeStartRfc3339('2026-06-22')).toBe('2026-06-22T00:00:00Z')
  })
})

describe('computeOrgHealth — the verdict ladder', () => {
  const baseOrg: AnthropicOrgRow = {
    externalOrgId: 'org-1',
    displayName: 'Insight (Claude org)',
    apiKind: 'enterprise-analytics',
    credentialSecretName: 'insight',
    reconciliationMode: 'reconciled',
  }
  const greenProbe = { enterprise: () => ({ probe: async () => ({ ok: true, status: 200, parsed: true }) }),
                       admin: () => ({ probe: async () => ({ ok: true, status: 200, parsed: true }) }) }

  it('no key -> red no-key (not probed)', async () => {
    const h = await computeOrgHealth(baseOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => null, clients: greenProbe })
    expect(h).toMatchObject({ keyPresent: false, connects: null, reason: 'no-key', color: 'red' })
  })

  it('indicative org with no key -> amber (not reconciled), NOT a red alarm', async () => {
    const indicativeOrg: AnthropicOrgRow = { ...baseOrg, reconciliationMode: 'indicative' }
    const h = await computeOrgHealth(indicativeOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => null, clients: greenProbe })
    expect(h).toMatchObject({ keyPresent: false, reason: 'no-key', color: 'amber' })
  })

  it('key-format mismatch -> red, NOT probed', async () => {
    let probed = false
    const clients = { enterprise: () => ({ probe: async () => { probed = true; return { ok: true, status: 200, parsed: true } } }), admin: greenProbe.admin }
    const h = await computeOrgHealth(baseOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => ADMIN_KEY, clients })
    expect(h).toMatchObject({ keyPresent: true, keyFormatOk: false, reason: 'key-format-mismatch', color: 'red' })
    expect(probed).toBe(false)
  })

  it('endpoint unset -> amber (config gap, not a red auth error)', async () => {
    const h = await computeOrgHealth(baseOrg, { endpoint: undefined, resolveKey: () => ANALYTICS_KEY, clients: greenProbe })
    expect(h).toMatchObject({ keyPresent: true, keyFormatOk: true, reason: 'endpoint-unset', color: 'amber' })
  })

  it('good key + endpoint + 200 -> green', async () => {
    const h = await computeOrgHealth(baseOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => ANALYTICS_KEY, clients: greenProbe })
    expect(h).toMatchObject({ connects: 'green', reason: null, color: 'green' })
  })

  it('live probe 401 -> red 401-unauthorized', async () => {
    const clients = { enterprise: () => ({ probe: async () => ({ ok: false, status: 401, parsed: false }) }), admin: greenProbe.admin }
    const h = await computeOrgHealth(baseOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => ANALYTICS_KEY, clients })
    expect(h).toMatchObject({ connects: 'red', reason: '401-unauthorized', color: 'red' })
  })

  it('routes the Admin variant to the admin client', async () => {
    let usedAdmin = false
    const clients = {
      enterprise: () => ({ probe: async () => ({ ok: false, status: 401, parsed: false }) }),
      admin: () => ({ probe: async () => { usedAdmin = true; return { ok: true, status: 200, parsed: true } } }),
    }
    const h = await computeOrgHealth({ ...baseOrg, apiKind: 'claude-code-admin' }, { endpoint: 'https://api.anthropic.com', resolveKey: () => ADMIN_KEY, clients })
    expect(usedAdmin).toBe(true)
    expect(h.color).toBe('green')
  })

  it('SAFETY: the API key never appears anywhere in the OrgHealth output', async () => {
    const h = await computeOrgHealth(baseOrg, { endpoint: 'https://api.anthropic.com', resolveKey: () => ANALYTICS_KEY, clients: greenProbe })
    expect(JSON.stringify(h)).not.toContain('secretbody')
  })
})
