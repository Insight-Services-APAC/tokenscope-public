/*
 * Holistic private-link / DNS route validator.
 *
 * The dev app runs inside an IT-managed VNet where every Azure dependency
 * (Postgres, Redis, Key Vault, Azure Monitor/AMPLS) must resolve to a
 * private-endpoint IP via a LINKED privatelink DNS zone. When a zone is missing
 * or unlinked, the FQDN resolves PUBLIC and the call is denied or routed off the
 * private path (the 2026-06 read-joiner `NspValidationFailedError` was exactly
 * this — `api.monitor.azure.com` resolving public while `oms.opinsights` was
 * private).
 *
 * This resolves EVERY private-link FQDN the app depends on FROM INSIDE the app
 * (the one client inside the perimeter), reports public-vs-private + TCP
 * reachability per record, and emits a copy-paste "IT report" so a missing
 * zone-link becomes an exact checklist instead of "it doesn't work".
 *
 * Read-only: DNS resolution + raw TCP connects only. No credentials, no secrets
 * (host:port + resolved IPs only — never a connection URL).
 */
import { promises as dnsPromises } from 'node:dns'
import { resolveServices, probeTcp } from '../../scripts/preflight'

const PRIVATE_IP = /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./

export type NetVerdict = 'ok' | 'dns-public-zone-not-linked' | 'unreachable' | 'dns-fail' | 'public-ok'

export interface NetCheckRecord {
  service: string
  category: 'data-plane' | 'azure-monitor' | 'reference'
  host: string
  port: number
  expectedZone: string
  expectPrivate: boolean
  addresses: string[]
  resolvesPrivate: boolean
  dnsError?: string
  reachable: boolean | null
  tcpLatencyMs: number | null
  tcpError?: string
  verdict: NetVerdict
}

export interface NetCheckReport {
  generatedNote: string
  vnetHint: string
  records: NetCheckRecord[]
  summary: { total: number; ok: number; zoneNotLinked: number; unreachable: number; dnsFail: number }
  itReport: string
}

function classify(r: Omit<NetCheckRecord, 'verdict'>): NetVerdict {
  if (r.dnsError) return 'dns-fail'
  if (r.expectPrivate && !r.resolvesPrivate) return 'dns-public-zone-not-linked'
  if (r.reachable === false) return 'unreachable'
  if (!r.expectPrivate) return 'public-ok'
  return 'ok'
}

const DATA_PLANE_ZONE: Record<string, string> = {
  postgres: 'privatelink.postgres.database.azure.com',
  redis: 'privatelink.redis.cache.windows.net',
  keyVault: 'privatelink.vaultcore.azure.net',
}

export async function runNetworkCheck(env: NodeJS.ProcessEnv = process.env): Promise<NetCheckReport> {
  const wsid = env.NUXT_LOG_ANALYTICS_WORKSPACE_ID ?? ''
  const vnetHint = env.NUXT_DEV_VNET_NAME ?? 'vnet-tokenscope-example'
  type Target = Pick<NetCheckRecord, 'service' | 'category' | 'host' | 'port' | 'expectedZone' | 'expectPrivate'>
  const targets: Target[] = []

  // Data-plane PEs (host:port derived from env by preflight's resolver).
  for (const s of resolveServices(env)) {
    if (!s.endpoint) continue
    targets.push({
      service: s.name,
      category: 'data-plane',
      host: s.endpoint.host,
      port: s.endpoint.port,
      expectedZone: DATA_PLANE_ZONE[s.name] ?? '(unknown)',
      expectPrivate: true,
    })
  }

  // Azure Monitor / AMPLS — all 11 records across the 5 privatelink zones.
  const MON = 'privatelink.monitor.azure.com'
  const monitorSet: Array<[string, string]> = wsid
    ? [
        [`${wsid}.oms.opinsights.azure.com`, 'privatelink.oms.opinsights.azure.com'],
        [`${wsid}.ods.opinsights.azure.com`, 'privatelink.ods.opinsights.azure.com'],
        [`${wsid}.agentsvc.azure-automation.net`, 'privatelink.agentsvc.azure-automation.net'],
        ['api.monitor.azure.com', MON],
        ['global.in.ai.monitor.azure.com', MON],
        ['profiler.monitor.azure.com', MON],
        ['live.monitor.azure.com', MON],
        ['diagservices-query.monitor.azure.com', MON],
        ['snapshot.monitor.azure.com', MON],
        ['scadvisorcontentpl.blob.core.windows.net', 'privatelink.blob.core.windows.net'],
        ['global.handler.control.monitor.azure.com', MON],
      ]
    : []
  for (const [host, zone] of monitorSet) {
    targets.push({ service: host, category: 'azure-monitor', host, port: 443, expectedZone: zone, expectPrivate: true })
  }

  // The SDK-default Log Analytics query host. On PUBLIC-query envs (sandbox) it
  // resolves public (expected). On AMPLS/private-query envs (dev) it resolves to
  // the private endpoint (VERIFIED dev 2026-07-01: same 10.0.0.x as
  // api.monitor.azure.com) and the reader's DEFAULT client queries fine over it.
  // Do NOT "fix" the reader by pointing it at api.monitor.azure.com — that host
  // 404s the LA query path. Kept as reference (expectPrivate=false) so a public
  // resolution on a public-query env is never flagged as a broken zone-link.
  targets.push({
    service: 'api.loganalytics.io (LA query SDK default — resolves private on dev)',
    category: 'reference',
    host: 'api.loganalytics.io',
    port: 443,
    expectedZone: '(SDK default; resolves private via the monitor PE on dev)',
    expectPrivate: false,
  })

  const records: NetCheckRecord[] = []
  for (const t of targets) {
    let addresses: string[] = []
    let resolvesPrivate = false
    let dnsError: string | undefined
    try {
      const addrs = await dnsPromises.lookup(t.host, { all: true })
      addresses = addrs.map((a) => a.address)
      resolvesPrivate = addresses.some((ip) => PRIVATE_IP.test(ip))
    } catch (e) {
      dnsError = e instanceof Error ? e.message : String(e)
    }
    let reachable: boolean | null = null
    let tcpLatencyMs: number | null = null
    let tcpError: string | undefined
    if (!dnsError) {
      const p = await probeTcp(t.host, t.port, 4000)
      reachable = p.ok
      tcpLatencyMs = p.latencyMs
      if (!p.ok) tcpError = `${p.errorClass ?? 'other'}${p.error ? ` ${p.error}` : ''}`
    }
    const partial = { ...t, addresses, resolvesPrivate, dnsError, reachable, tcpLatencyMs, tcpError }
    records.push({ ...partial, verdict: classify(partial) })
  }

  const summary = {
    total: records.length,
    ok: records.filter((r) => r.verdict === 'ok' || r.verdict === 'public-ok').length,
    zoneNotLinked: records.filter((r) => r.verdict === 'dns-public-zone-not-linked').length,
    unreachable: records.filter((r) => r.verdict === 'unreachable').length,
    dnsFail: records.filter((r) => r.verdict === 'dns-fail').length,
  }

  // Copy-paste IT report — GROUPED BY ZONE so it stays short (one line per zone,
  // not per record). A network engineer acts on the zone, not each FQDN.
  const byZone = (recs: NetCheckRecord[]) => {
    const m = new Map<string, NetCheckRecord[]>()
    for (const r of recs) {
      const list = m.get(r.expectedZone) ?? []
      list.push(r)
      m.set(r.expectedZone, list)
    }
    return [...m.entries()]
  }
  const linkedZones = byZone(records.filter((r) => r.expectPrivate && r.resolvesPrivate))
  const notLinkedZones = byZone(records.filter((r) => r.verdict === 'dns-public-zone-not-linked'))
  const ex = (rs: NetCheckRecord[]) => {
    const r = rs[0]!
    const n = rs.length > 1 ? `${rs.length} records, e.g. ` : ''
    return `${n}${r.host} → ${r.addresses[0] ?? '(none)'}`
  }
  const lines: string[] =
    notLinkedZones.length === 0
      ? [`TokenScope dev — all privatelink zones resolve to the private endpoint from ${vnetHint}. ✅`]
      : [
          `TokenScope dev — on ${vnetHint} these resolve to PUBLIC IPs but must point at the private endpoint.`,
          `Please link these ${notLinkedZones.length} zone(s) to the VNet:`,
          '',
          ...notLinkedZones.map(([z, rs]) => `   ${z}   (e.g. ${ex(rs)} → should be 10.0.0.x)`),
          '',
          `(Already linked & working: ${linkedZones.map(([z]) => z).join(', ') || 'none'})`,
        ]

  return {
    generatedNote: 'Resolved from inside the dev Container App — the only client inside the VNet perimeter.',
    vnetHint,
    records,
    summary,
    itReport: lines.join('\n'),
  }
}
