/*
 * DCR ingest-pipeline coverage probe — the INDEPENDENT work-evidence signal
 * behind the two stall alerts (read-path-health STALL + attribution-stall).
 *
 * Why this exists: both stall alerts decide "is there usage the joiner has not
 * landed?" from the reader's OWN output (rows_affected + a bearer heartbeat).
 * That cannot tell an idle-but-open editor (a fresh bearer, nothing to attribute)
 * from a stuck reader (usage arriving, nothing landing) — and PR #316's
 * reader-derived `newEventsSeen` gate turned that false positive into a false
 * NEGATIVE (a reader that returns empty ON SUCCESS reads healthy). See
 * docs/design/read-path-attribution-coverage-signal.md and PR #319.
 *
 * The signal: Azure Monitor PLATFORM METRICS on the OTLP Data Collection Rule
 * (namespace `Microsoft.Insights/dataCollectionRules`). `RowsReceived_Count` is
 * how many rows physically arrived at the ingest pipeline for transformation —
 * UPSTREAM of Log Analytics storage and the joiner, and reached over the Azure
 * Monitor METRICS API (management plane), NOT a Log Analytics KQL query. So it
 * survives a Log-Analytics-QUERY-path outage (the exact class #316's fix went
 * blind to), needs no watermark, no per-instance selection, no parser and no
 * write path between the source and the number. `RowsDropped_Count` /
 * `TransformationErrors_Count` catch the residual that is accepted at the DCE
 * but lost after it (surfaced as diagnostics).
 *
 * Verdict (SourceCoverage.status):
 *   - 'rows-arrived' — RowsReceived summed > 0 over the window: the pipeline
 *     received work. If the joiner wrote nothing, that is a real backlog → page.
 *   - 'no-rows'      — the RowsReceived metric answered and summed to 0: nothing
 *     arrived, the idle estate → never a stall.
 *   - 'unknown'      — no DCR configured, a 403 (the app MI lacks Monitoring
 *     Reader on the DCR), a timeout, a throw, or the metric absent from the
 *     response. NEVER a zero: an unknown falls the decision back to today's
 *     bearer gate, which fails toward PAGING.
 *
 * Every failure of the probe ITSELF is 'unknown', never a fabricated 0 — the one
 * direction a coverage signal is allowed to be wrong in.
 */
/** Namespace to query the RowsReceived_Count et al. platform metrics on. */
const DCR_METRIC_NAMESPACE = 'Microsoft.Insights/dataCollectionRules'
/** Rows physically received at the ingest pipeline — THE work-evidence metric. */
export const ROWS_RECEIVED_METRIC = 'RowsReceived_Count'
/** Accepted at the DCE, dropped after it (post-accept residual; diagnostics). */
export const ROWS_DROPPED_METRIC = 'RowsDropped_Count'
/** Transformation (KQL) failures after accept (post-accept residual; diagnostics). */
export const TRANSFORMATION_ERRORS_METRIC = 'TransformationErrors_Count'

const PROBE_METRICS = [ROWS_RECEIVED_METRIC, ROWS_DROPPED_METRIC, TRANSFORMATION_ERRORS_METRIC] as const

/** How far back the probe sums, in minutes. Wider than the 5-min reader tick so
 *  a few minutes of metric-ingestion latency cannot read a busy estate as empty. */
export const SOURCE_COVERAGE_WINDOW_MINUTES = 15
/** Request budget on BOTH ends (ar-H6): the probe can never hold the reader tick
 *  past the gateway. A blown budget is 'unknown' → bearer fallback → pages. */
const PROBE_TIMEOUT_MS = 10_000

export type SourceCoverageStatus = 'rows-arrived' | 'no-rows' | 'unknown'

/** WHY a probe could not produce a verdict. Internal (never on the ntfy wire);
 *  reaches worker_run.result + the admin diagnostics page so an operator paged
 *  on the bearer fallback can see the probe could not measure. */
export type SourceCoverageUnknownReason =
  | 'no-config' // NUXT_AZURE_DCR_RESOURCE_ID unset (local, or the metric-probe not yet wired)
  | 'forbidden' // 403 — the app MI lacks Monitoring Reader on the DCR (the role dependency)
  | 'no-metric' // no USABLE RowsReceived metric: absent from the response, or present with a per-metric errorCode fault
  | 'probe-timeout'
  | 'probe-threw'

export interface SourceCoverage {
  status: SourceCoverageStatus
  /** RowsReceived_Count summed over the window; null when status is 'unknown'. */
  rowsReceived: number | null
  /** RowsDropped_Count summed over the window (post-accept residual). null unknown. */
  rowsDropped: number | null
  /** TransformationErrors_Count summed over the window. null unknown. */
  transformationErrors: number | null
  windowMinutes: number
  /** Present only when status === 'unknown'. */
  reason?: SourceCoverageUnknownReason
}

/** Minimal structural shape of an @azure/monitor-query MetricsQueryResult — kept
 *  local so the Azure SDK stays a dynamic import and the probe is mockable at the
 *  client boundary (never hits Azure in tests). */
interface RawMetricDataPoint {
  total?: number | null
}
interface RawMetric {
  name: string
  errorCode?: string
  timeseries?: Array<{ data?: RawMetricDataPoint[] }>
}
export interface RawMetricsResult {
  metrics: RawMetric[]
}

/** The query seam: resourceId + metric names → a metrics result. Defaults to a
 *  real MetricsQueryClient; injected in tests. */
export type MetricsQueryFn = (
  resourceId: string,
  metricNames: readonly string[],
  opts: { granularity: string; timespanMs: number; timeoutMs: number },
) => Promise<RawMetricsResult>

/** Sum a metric's `total` across every data point, treating null/absent as 0.
 *  A metric that is PRESENT with a Success errorCode and all-null points sums to
 *  0 — a real "nothing arrived", distinct from an absent metric OR a metric that
 *  FAULTED (non-Success errorCode), both of which return null so the caller reads
 *  them as unknown, never as a fabricated 0. A per-metric fault while the overall
 *  call succeeds must NOT be able to silence a page. */
export function sumMetricTotal(result: RawMetricsResult, metricName: string): number | null {
  const metric = result.metrics.find((m) => m.name === metricName)
  if (!metric) return null
  // errorCode is 'Success' or an error detail on a per-metric failure. Anything
  // other than Success/absent means the number below is not a measurement.
  if (metric.errorCode !== undefined && metric.errorCode !== 'Success') return null
  let sum = 0
  for (const series of metric.timeseries ?? []) {
    for (const point of series.data ?? []) {
      if (typeof point.total === 'number' && Number.isFinite(point.total)) sum += point.total
    }
  }
  return sum
}

/** Turn a raw metrics result into the coverage verdict. Pure — unit-tested. The
 *  RowsReceived metric being PRESENT is the "we measured" signal: sum > 0 →
 *  rows-arrived, sum 0 → no-rows. Absent → unknown('no-metric'). */
export function verdictFromMetrics(result: RawMetricsResult, windowMinutes: number): SourceCoverage {
  const rowsReceived = sumMetricTotal(result, ROWS_RECEIVED_METRIC)
  const rowsDropped = sumMetricTotal(result, ROWS_DROPPED_METRIC)
  const transformationErrors = sumMetricTotal(result, TRANSFORMATION_ERRORS_METRIC)
  if (rowsReceived === null) {
    return {
      status: 'unknown',
      rowsReceived: null,
      rowsDropped: null,
      transformationErrors: null,
      windowMinutes,
      reason: 'no-metric',
    }
  }
  return {
    status: rowsReceived > 0 ? 'rows-arrived' : 'no-rows',
    rowsReceived,
    rowsDropped,
    transformationErrors,
    windowMinutes,
  }
}

function unknown(
  reason: SourceCoverageUnknownReason,
  windowMinutes = SOURCE_COVERAGE_WINDOW_MINUTES,
): SourceCoverage {
  return {
    status: 'unknown',
    rowsReceived: null,
    rowsDropped: null,
    transformationErrors: null,
    windowMinutes,
    reason,
  }
}

/** Build the default query seam over a real MetricsQueryClient. The credential
 *  is the SAME selection the LogAnalyticsReader uses (DefaultAzureCredential with
 *  the user-assigned MI clientId when set) — but the MetricsQueryClient targets
 *  the MANAGEMENT plane (`https://management.azure.com/.default`) by default,
 *  which is what platform metrics live behind. Dynamic import keeps the Azure
 *  SDK out of the local/test bundle (the reader's getClient() precedent). */
function defaultMetricsQuery(miClientId: string | undefined): MetricsQueryFn {
  return async (resourceId, metricNames, opts) => {
    const { MetricsQueryClient } = await import('@azure/monitor-query')
    const { DefaultAzureCredential } = await import('@azure/identity')
    const credential = new DefaultAzureCredential(
      miClientId ? { managedIdentityClientId: miClientId } : {},
    )
    const client = new MetricsQueryClient(credential)
    const result = await client.queryResource(resourceId, [...metricNames], {
      granularity: 'PT1M',
      timespan: { duration: `PT${Math.round(opts.timespanMs / 60_000)}M` },
      aggregations: ['Total'],
      metricNamespace: DCR_METRIC_NAMESPACE,
      abortSignal: AbortSignal.timeout(opts.timeoutMs),
    })
    return { metrics: result.metrics as RawMetric[] }
  }
}

/** Is this a 403 from the management plane (MI missing Monitoring Reader)? */
function isForbidden(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { statusCode?: number; status?: number }
  return e.statusCode === 403 || e.status === 403
}

/** AbortSignal.timeout throws a TimeoutError; a manual abort an AbortError. */
function isTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

export interface ReadSourceCoverageOpts {
  /** The DCR ARM resource id (NUXT_AZURE_DCR_RESOURCE_ID). Unset → unknown('no-config'). */
  dcrResourceId?: string
  /** The user-assigned MI clientId (NUXT_AZURE_MI_CLIENT_ID). */
  miClientId?: string
  /** Injected in tests; defaults to a real MetricsQueryClient. */
  query?: MetricsQueryFn
  windowMinutes?: number
  timeoutMs?: number
}

/**
 * Read the DCR ingest coverage for the recent window. NEVER throws into the
 * caller: every failure — no config, 403, timeout, any throw — resolves to a
 * 'unknown' verdict so the tick records a measurement and the decision falls
 * back to the bearer gate (fails toward paging).
 */
export async function readSourceCoverage(opts: ReadSourceCoverageOpts): Promise<SourceCoverage> {
  const windowMinutes = opts.windowMinutes ?? SOURCE_COVERAGE_WINDOW_MINUTES
  const dcrResourceId = opts.dcrResourceId?.trim()
  if (!dcrResourceId) return unknown('no-config', windowMinutes)

  const query = opts.query ?? defaultMetricsQuery(opts.miClientId)
  try {
    const result = await query(dcrResourceId, PROBE_METRICS, {
      granularity: 'PT1M',
      timespanMs: windowMinutes * 60_000,
      timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    })
    return verdictFromMetrics(result, windowMinutes)
  } catch (err) {
    if (isForbidden(err)) return unknown('forbidden', windowMinutes)
    return unknown(isTimeout(err) ? 'probe-timeout' : 'probe-threw', windowMinutes)
  }
}
