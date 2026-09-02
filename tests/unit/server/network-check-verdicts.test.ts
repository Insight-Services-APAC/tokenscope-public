// @vitest-environment node
/*
 * The `not-wired` verdict (server/azure/network-check.ts): a service that is
 * provisioned but DELIBERATELY unmapped/unconsumed (owner ruling 2026-08-20 —
 * redis, kept "in case we need it") must classify its failures as a neutral
 * `not-wired`, never as dns-fail/unreachable: a permanently-red known-benign
 * row trains operators to ignore reds, and it muddied the 2026-08-20 AMPLS
 * incident triage. The exemption covers EXACTLY the declared state — DNS
 * absence — so a privately-resolving-but-down service stays red and a
 * working one shows `ok`, both with no code change.
 */
import { describe, it, expect } from 'vitest'
import { buildItReport, classify, monitorTargets, summarize, type NetCheckRecord } from '../../../server/azure/network-check'

const base = {
  category: 'data-plane' as const,
  host: 'x',
  port: 443,
  expectedZone: 'z',
  expectPrivate: true,
  addresses: [],
  resolvesPrivate: false,
  reachable: null,
  tcpLatencyMs: null,
}

describe('classify — the not-wired exemption', () => {
  it('a redis DNS failure is not-wired, not dns-fail', () => {
    expect(classify({ ...base, service: 'redis', dnsError: 'ENOTFOUND' })).toBe('not-wired')
  })

  it('a redis that RESOLVES privately but is down stays unreachable — DNS wired means the premise is false', () => {
    expect(
      classify({ ...base, service: 'redis', resolvesPrivate: true, addresses: ['10.0.0.1'], reachable: false }),
    ).toBe('unreachable')
  })

  it('a WIRED redis (resolves private, reachable) shows ok — the exemption covers failures only', () => {
    expect(
      classify({ ...base, service: 'redis', resolvesPrivate: true, addresses: ['10.0.0.1'], reachable: true }),
    ).toBe('ok')
  })

  it('the same failures on any other service stay red', () => {
    expect(classify({ ...base, service: 'postgres', dnsError: 'ENOTFOUND' })).toBe('dns-fail')
    expect(
      classify({ ...base, service: 'postgres', resolvesPrivate: true, addresses: ['10.0.0.1'], reachable: false }),
    ).toBe('unreachable')
  })
})

describe('summarize — not-wired counts in its own bucket, never as a failure', () => {
  it('splits the buckets correctly', () => {
    const rec = (service: string, verdict: NetCheckRecord['verdict']): NetCheckRecord => ({
      ...base,
      service,
      verdict,
    })
    const s = summarize([
      rec('postgres', 'ok'),
      rec('keyVault', 'ok'),
      rec('redis', 'not-wired'),
      rec('monitor', 'unreachable'),
      rec('snapshot.monitor.azure.com', 'dns-only'),
    ])
    // dns-only counts apart from ok: a private answer we chose not to dial is
    // not the same claim as a host we reached.
    expect(s).toEqual({ total: 5, ok: 2, dnsOnly: 1, zoneNotLinked: 0, unreachable: 1, dnsFail: 0, notWired: 1 })
  })
})

/*
 * The IT report's all-clear branch. A record that does not resolve AT ALL
 * classifies as `dns-fail`, not `dns-public-zone-not-linked` — so a report that
 * asked only for the latter printed "every privatelink zone resolves to a
 * PRIVATE address" while the Monitor records were missing entirely. That is
 * precisely the state the 2026-08 outage left the zones in, and the report
 * exists to catch it, so the all-clear is gated here.
 */
describe('buildItReport — the all-clear cannot be printed over a failure', () => {
  const monitor = (over: Partial<NetCheckRecord>): NetCheckRecord =>
    ({
      ...base,
      service: 'api.monitor.azure.com',
      category: 'azure-monitor',
      expectedZone: 'privatelink.monitor.azure.com',
      verdict: 'ok',
      ...over,
    }) as NetCheckRecord

  it('a record that does not resolve at all lands in the ticket, not the all-clear', () => {
    const report = buildItReport(
      [monitor({ dnsError: 'ENOTFOUND', verdict: 'dns-fail' })],
      'vnet-test',
    )
    expect(report).not.toContain('every privatelink zone resolves')
    expect(report).toContain('privatelink.monitor.azure.com')
    expect(report).toContain('(none)')
  })

  it('a record answering PUBLICLY still lands in the ticket', () => {
    const report = buildItReport(
      [monitor({ addresses: ['20.1.2.3'], verdict: 'dns-public-zone-not-linked' })],
      'vnet-test',
    )
    expect(report).not.toContain('every privatelink zone resolves')
    expect(report).toContain('20.1.2.3')
  })

  it('the all-clear says what it proved, and states what it did NOT', () => {
    const report = buildItReport(
      [monitor({ addresses: ['10.80.141.20'], resolvesPrivate: true })],
      'vnet-test',
    )
    expect(report).toContain('every privatelink zone resolves')
    // It must never claim the endpoint belongs to OUR scope — a record owned by
    // another team's AMPLS resolves private too, and that was the outage.
    expect(report).toContain('does not prove')
  })

  it('a deliberately not-wired service never reaches an IT ticket', () => {
    const report = buildItReport(
      [
        monitor({ addresses: ['10.80.141.20'], resolvesPrivate: true }),
        { ...base, service: 'redis', expectedZone: 'privatelink.redis.cache.windows.net', dnsError: 'ENOTFOUND', verdict: 'not-wired' } as NetCheckRecord,
      ],
      'vnet-test',
    )
    expect(report).toContain('every privatelink zone resolves')
    expect(report).not.toContain('redis')
  })
})

/*
 * Which AMPLS hosts we probe, and which we dial. Both halves earned a gate on
 * 2026-08-27, when the card carried two permanent reds that no action by IT
 * could ever clear: `agentsvc` (no such member exists on the private endpoint,
 * and we run no Log Analytics agent) and `diagservices-query` (a member that
 * does not listen, for a service we never call). A red nobody can fix is the
 * noise that trained everyone to ignore this card during the August outage.
 */
describe('monitorTargets — probe what proves linkage, dial what we call', () => {
  const WSID = '00096876-5856-4b19-b1e5-cf6b672c5b9d'

  it('never probes the Log Analytics agent endpoint', () => {
    const hosts = monitorTargets(WSID).map((t) => t.host)
    expect(hosts.some((h) => h.includes('agentsvc'))).toBe(false)
  })

  it('dials exactly one host — the address the LA query path resolves to', () => {
    const dialled = monitorTargets(WSID).filter((t) => t.dial).map((t) => t.host)
    expect(dialled).toEqual(['api.monitor.azure.com'])
  })

  it('still covers every AMPLS zone, so linkage evidence is unchanged', () => {
    const zones = new Set(monitorTargets(WSID).map((t) => t.zone))
    expect([...zones].sort()).toEqual([
      'privatelink.blob.core.windows.net',
      'privatelink.monitor.azure.com',
      'privatelink.ods.opinsights.azure.com',
      'privatelink.oms.opinsights.azure.com',
    ])
  })

  it('probes nothing without a workspace id', () => {
    expect(monitorTargets('')).toEqual([])
  })

  it('a private answer we did not dial is dns-only, never ok', () => {
    // `ok` would assert a reachability nobody measured.
    expect(
      classify({ ...base, service: 'snapshot.monitor.azure.com', resolvesPrivate: true, addresses: ['10.80.141.31'], reachable: null }),
    ).toBe('dns-only')
  })

  it('a dialled host that times out is still unreachable — the exemption is not a blanket', () => {
    expect(
      classify({ ...base, service: 'api.monitor.azure.com', resolvesPrivate: true, addresses: ['10.80.141.26'], reachable: false }),
    ).toBe('unreachable')
  })
})
