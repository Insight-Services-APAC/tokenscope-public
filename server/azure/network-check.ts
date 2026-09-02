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

export type NetVerdict =
  | 'ok'
  | 'dns-only'
  | 'dns-public-zone-not-linked'
  | 'unreachable'
  | 'dns-fail'
  | 'public-ok'
  | 'not-wired'

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
  summary: {
    total: number
    ok: number
    dnsOnly: number
    zoneNotLinked: number
    unreachable: number
    dnsFail: number
    notWired: number
  }
  itReport: string
}

/**
 * Services that are PROVISIONED but deliberately not DNS-mapped and consumed
 * by nothing (owner ruling 2026-08-20: redis is kept "in case we need it",
 * unmapped on purpose). The exemption covers EXACTLY the declared state —
 * DNS-level absence (dns-fail / zone-not-linked) — and nothing more: a name
 * that RESOLVES privately means someone wired the DNS path, so a
 * reachability failure past that point is a real outage and stays red, and
 * a fully-working service shows `ok` with no code change.
 */
const NOT_WIRED_SERVICES: ReadonlySet<string> = new Set(['redis'])

export function classify(r: Omit<NetCheckRecord, 'verdict'>): NetVerdict {
  const dnsAbsent = Boolean(r.dnsError) || (r.expectPrivate && !r.resolvesPrivate)
  if (dnsAbsent && NOT_WIRED_SERVICES.has(r.service)) return 'not-wired'
  if (r.dnsError) return 'dns-fail'
  if (r.expectPrivate && !r.resolvesPrivate) return 'dns-public-zone-not-linked'
  if (r.reachable === false) return 'unreachable'
  if (!r.expectPrivate) return 'public-ok'
  // Resolved private, but we chose not to dial it (monitorTargets: an AMPLS
  // member this app never calls). `ok` would claim a reachability we never
  // measured — the whole point of the row is the DNS answer.
  if (r.reachable === null) return 'dns-only'
  return 'ok'
}

/** Pure summary over classified records (exported for tests). */
export function summarize(records: NetCheckRecord[]): NetCheckReport['summary'] {
  return {
    total: records.length,
    ok: records.filter((r) => r.verdict === 'ok' || r.verdict === 'public-ok').length,
    dnsOnly: records.filter((r) => r.verdict === 'dns-only').length,
    zoneNotLinked: records.filter((r) => r.verdict === 'dns-public-zone-not-linked').length,
    unreachable: records.filter((r) => r.verdict === 'unreachable').length,
    dnsFail: records.filter((r) => r.verdict === 'dns-fail').length,
    notWired: records.filter((r) => r.verdict === 'not-wired').length,
  }
}

const DATA_PLANE_ZONE: Record<string, string> = {
  postgres: 'privatelink.postgres.database.azure.com',
  redis: 'privatelink.redis.cache.windows.net',
  keyVault: 'privatelink.vaultcore.azure.net',
}

export interface NetworkCheckOptions {
  /**
   * Max in-flight target probes. Default 1 preserves the original serial
   * behaviour for the diagnostics page; the ops-alert evaluator raises it so
   * the whole sweep fits its probe budget (ops-alerting ar-H6 — network probes
   * run with BOUNDED concurrency, never unbounded fan-out).
   */
  concurrency?: number
  /** Per-target TCP connect timeout, ms. Default 4000 (unchanged). */
  tcpTimeoutMs?: number
}

/*
 * The Azure Monitor hosts whose DNS proves the AMPLS zones are linked to this
 * VNet, and which of them we actually DIAL.
 *
 * We dial `api.monitor.azure.com` alone. It carries the private-endpoint IP the
 * Log Analytics query path resolves to (api.loganalytics.io answers with the
 * same address), so one dial proves route + NSG to the endpoint. The rest are
 * members of that same private endpoint — one NIC, one subnet, one route — so
 * dialling them adds no signal, and some do not listen at all: verified from
 * dev on 2026-08-27, `diagservices-query` times out on the central PE while
 * nine sibling addresses answer in 7-66ms. Dialling those manufactures a
 * permanent red for a service we never call, which is the noise the redis
 * not-wired ruling exists to prevent.
 *
 * `<workspace>.agentsvc.azure-automation.net` is NOT probed. It is the Log
 * Analytics agent's management endpoint (MMA/AMA, Automation hybrid workers) —
 * we run no agent, we emit OTLP to a DCE and query through the SDK. The AMPLS
 * private endpoint carries no agentsvc member either (dev, 2026-08-27: ten
 * addresses, none of them agentsvc), so it can only ever resolve public, and a
 * report asking IT to "link" that zone asks for something that cannot exist.
 */
export function monitorTargets(wsid: string): Array<{ host: string; zone: string; dial: boolean }> {
  if (!wsid) return []
  const MON = 'privatelink.monitor.azure.com'
  return [
    { host: 'api.monitor.azure.com', zone: MON, dial: true },
    { host: `${wsid}.oms.opinsights.azure.com`, zone: 'privatelink.oms.opinsights.azure.com', dial: false },
    { host: `${wsid}.ods.opinsights.azure.com`, zone: 'privatelink.ods.opinsights.azure.com', dial: false },
    { host: 'global.in.ai.monitor.azure.com', zone: MON, dial: false },
    { host: 'profiler.monitor.azure.com', zone: MON, dial: false },
    { host: 'live.monitor.azure.com', zone: MON, dial: false },
    { host: 'diagservices-query.monitor.azure.com', zone: MON, dial: false },
    { host: 'snapshot.monitor.azure.com', zone: MON, dial: false },
    { host: 'scadvisorcontentpl.blob.core.windows.net', zone: 'privatelink.blob.core.windows.net', dial: false },
    { host: 'global.handler.control.monitor.azure.com', zone: MON, dial: false },
  ]
}

/*
 * Copy-paste IT report — GROUPED BY ZONE so it stays short (one line per zone,
 * not per record). A network engineer acts on the zone, not each FQDN.
 * A private answer is evidence of a LINKED zone, never of the RIGHT endpoint:
 * the central zones are shared, so a record can point at another team's AMPLS
 * PE and resolve private while our queries fail closed. We cannot tell from in
 * here which scope an IP belongs to — say what we measured, not more.
 * Pure, and exported, so the all-clear branch is testable without live DNS.
 */
export function buildItReport(records: NetCheckRecord[], vnetHint: string): string {
  const byZone = (recs: NetCheckRecord[]) => {
    const m = new Map<string, NetCheckRecord[]>()
    for (const r of recs) {
      const list = m.get(r.expectedZone) ?? []
      list.push(r)
      m.set(r.expectedZone, list)
    }
    return [...m.entries()]
  }
  // not-wired rows enter NEITHER list — deliberately-unwired services must
  // never appear in an IT ticket.
  const linkedZones = byZone(records.filter((r) => r.expectPrivate && r.resolvesPrivate))
  // Every expected-private record WITHOUT a private answer, not just the ones
  // that answered publicly: a record that does not resolve at all classifies as
  // 'dns-fail', and filtering on 'dns-public-zone-not-linked' alone would drop
  // it — printing the all-clear when IT's hand-made records have gone missing,
  // which is the failure this report exists to catch.
  const notLinkedZones = byZone(
    records.filter((r) => r.expectPrivate && !r.resolvesPrivate && r.verdict !== 'not-wired'),
  )
  const ex = (rs: NetCheckRecord[]) => {
    const r = rs[0]!
    const n = rs.length > 1 ? `${rs.length} records, e.g. ` : ''
    return `${n}${r.host} → ${r.addresses[0] ?? '(none)'}`
  }
  const lines: string[] =
    notLinkedZones.length === 0
      ? [
          `TokenScope dev — every privatelink zone resolves to a PRIVATE address from ${vnetHint}.`,
          `(That proves the zones are LINKED. It does not prove they point at the endpoint of the scope`,
          ` holding our workspace — a record owned by another team's AMPLS resolves private too, and`,
          ` queries still fail closed with PrivateLinkValidationFailedError. Only a real query proves that.)`,
        ]
      : [
          `TokenScope dev — on ${vnetHint} these do NOT resolve to a private endpoint (a public answer, or no answer at all).`,
          `Please link these ${notLinkedZones.length} zone(s) to the VNet:`,
          '',
          ...notLinkedZones.map(([z, rs]) => `   ${z}   (e.g. ${ex(rs)} → should resolve to the AMPLS private endpoint)`),
          '',
          `(Resolving privately: ${linkedZones.map(([z]) => z).join(', ') || 'none'})`,
        ]
  return lines.join('\n')
}

export async function runNetworkCheck(
  env: NodeJS.ProcessEnv = process.env,
  opts: NetworkCheckOptions = {},
): Promise<NetCheckReport> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1))
  const tcpTimeoutMs = Math.max(1, Math.floor(opts.tcpTimeoutMs ?? 4000))
  const wsid = env.NUXT_LOG_ANALYTICS_WORKSPACE_ID ?? ''
  const vnetHint = env.NUXT_DEV_VNET_NAME ?? 'vnet-tokenscope-example'
  // `dial` is local-only: it decides whether we TCP-probe, and never reaches the
  // wire record — a non-dialled row is legible from its `dns-only` verdict.
  type Target = Pick<NetCheckRecord, 'service' | 'category' | 'host' | 'port' | 'expectedZone' | 'expectPrivate'> & {
    dial: boolean
  }
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
      dial: true,
    })
  }

  for (const t of monitorTargets(wsid)) {
    targets.push({
      service: t.host,
      category: 'azure-monitor',
      host: t.host,
      port: 443,
      expectedZone: t.zone,
      expectPrivate: true,
      dial: t.dial,
    })
  }

  // The SDK-default Log Analytics query host. On PUBLIC-query envs (sandbox) it
  // resolves public (expected). On AMPLS/private-query envs (dev) it resolves to
  // the same private endpoint as api.monitor.azure.com and the reader's DEFAULT
  // client queries fine over it. That PE need not sit in our own VNet — dev
  // reaches IT's central scope over the hub peering — so "private" here means an
  // RFC1918 address, not our /26.
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
    dial: true,
  })

  // Probe one target: DNS lookup, then (DNS permitting) a raw TCP connect.
  const probeTarget = async (t: Target): Promise<NetCheckRecord> => {
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
    if (!dnsError && t.dial) {
      const p = await probeTcp(t.host, t.port, tcpTimeoutMs)
      reachable = p.ok
      tcpLatencyMs = p.latencyMs
      if (!p.ok) tcpError = `${p.errorClass ?? 'other'}${p.error ? ` ${p.error}` : ''}`
    }
    // Strip the server-only `dial` flag before the record goes on the wire.
    const { dial, ...wire } = t
    void dial
    const partial = { ...wire, addresses, resolvesPrivate, dnsError, reachable, tcpLatencyMs, tcpError }
    return { ...partial, verdict: classify(partial) }
  }

  // Bounded-concurrency pool over the targets, results written BY INDEX so the
  // report order stays identical to the serial original whatever the finish
  // order.
  const records: NetCheckRecord[] = new Array<NetCheckRecord>(targets.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    for (;;) {
      const i = nextIndex++
      if (i >= targets.length) return
      records[i] = await probeTarget(targets[i]!)
    }
  })
  await Promise.all(workers)

  const summary = summarize(records)

  return {
    generatedNote: 'Resolved from inside the dev Container App — the only client inside the VNet perimeter.',
    vnetHint,
    records,
    summary,
    itReport: buildItReport(records, vnetHint),
  }
}
