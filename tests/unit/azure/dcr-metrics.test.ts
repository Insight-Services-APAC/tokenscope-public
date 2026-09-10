// @vitest-environment node
/*
 * dcr-metrics — the ingest-side coverage probe (PR #319). The metrics HTTP is
 * mocked at the CLIENT BOUNDARY (the injected MetricsQueryFn seam); this never
 * hits Azure. Pins: the request shape, the verdict mapping (value → rows-arrived,
 * empty → no-rows, absent metric / 403 / throw / no-config → unknown), and the
 * pure parsers.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  readSourceCoverage,
  verdictFromMetrics,
  sumMetricTotal,
  ROWS_RECEIVED_METRIC,
  ROWS_DROPPED_METRIC,
  TRANSFORMATION_ERRORS_METRIC,
  SOURCE_COVERAGE_WINDOW_MINUTES,
  type RawMetricsResult,
  type MetricsQueryFn,
} from '../../../server/azure/dcr-metrics'

const DCR = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr-x-otlp'

function metric(name: string, totals: Array<number | null>): RawMetricsResult['metrics'][number] {
  return { name, timeseries: [{ data: totals.map((t) => ({ total: t })) }] }
}

describe('sumMetricTotal / verdictFromMetrics — pure parsers', () => {
  it('sums a metric total across points, treating null as 0; absent metric = null', () => {
    const r: RawMetricsResult = { metrics: [metric(ROWS_RECEIVED_METRIC, [100, null, 8])] }
    expect(sumMetricTotal(r, ROWS_RECEIVED_METRIC)).toBe(108)
    expect(sumMetricTotal(r, ROWS_DROPPED_METRIC)).toBeNull()
  })

  it('RowsReceived summed > 0 → rows-arrived', () => {
    const v = verdictFromMetrics({ metrics: [metric(ROWS_RECEIVED_METRIC, [700, 8]), metric(ROWS_DROPPED_METRIC, [2])] }, 15)
    expect(v.status).toBe('rows-arrived')
    expect(v.rowsReceived).toBe(708)
    expect(v.rowsDropped).toBe(2)
  })

  it('RowsReceived PRESENT but summing to 0 (all null / all 0) → no-rows (a real idle measurement)', () => {
    expect(verdictFromMetrics({ metrics: [metric(ROWS_RECEIVED_METRIC, [null, null])] }, 15).status).toBe('no-rows')
    expect(verdictFromMetrics({ metrics: [metric(ROWS_RECEIVED_METRIC, [0])] }, 15).status).toBe('no-rows')
  })

  it('RowsReceived metric ABSENT from the response → unknown(no-metric), never a fabricated 0', () => {
    const v = verdictFromMetrics({ metrics: [metric(TRANSFORMATION_ERRORS_METRIC, [0])] }, 15)
    expect(v).toMatchObject({ status: 'unknown', reason: 'no-metric', rowsReceived: null })
  })

  it('RowsReceived PRESENT but with a per-metric errorCode fault → unknown, NOT a fabricated no-rows (external review #1)', () => {
    // Azure can return the metric object with a non-Success errorCode and an
    // empty timeseries while the overall call succeeds. Summing that to 0 would
    // silence a real outage — it must read unknown, so the alert pages.
    const faulted: RawMetricsResult = { metrics: [{ name: ROWS_RECEIVED_METRIC, errorCode: 'InternalError', timeseries: [] }] }
    expect(sumMetricTotal(faulted, ROWS_RECEIVED_METRIC)).toBeNull()
    expect(verdictFromMetrics(faulted, 15)).toMatchObject({ status: 'unknown', reason: 'no-metric' })
  })

  it("a metric with errorCode 'Success' is a real measurement", () => {
    const ok: RawMetricsResult = { metrics: [{ name: ROWS_RECEIVED_METRIC, errorCode: 'Success', timeseries: [{ data: [{ total: 5 }] }] }] }
    expect(verdictFromMetrics(ok, 15).status).toBe('rows-arrived')
  })
})

describe('readSourceCoverage — the probe wrapper (mocked at the client boundary)', () => {
  it('no DCR config → unknown(no-config); the query seam is never called', async () => {
    const query = vi.fn()
    const v = await readSourceCoverage({ dcrResourceId: undefined, query: query as unknown as MetricsQueryFn })
    expect(v).toMatchObject({ status: 'unknown', reason: 'no-config' })
    expect(query).not.toHaveBeenCalled()
  })

  it('requests RowsReceived + residual metrics for the configured DCR over the window', async () => {
    const query: MetricsQueryFn = vi.fn(async (resourceId, metricNames) => {
      expect(resourceId).toBe(DCR)
      expect(metricNames).toEqual([ROWS_RECEIVED_METRIC, ROWS_DROPPED_METRIC, TRANSFORMATION_ERRORS_METRIC])
      return { metrics: [metric(ROWS_RECEIVED_METRIC, [708])] }
    })
    const v = await readSourceCoverage({ dcrResourceId: DCR, query })
    expect(v.status).toBe('rows-arrived')
    expect(v.windowMinutes).toBe(SOURCE_COVERAGE_WINDOW_MINUTES)
  })

  it('empty measurement → no-rows', async () => {
    const query: MetricsQueryFn = async () => ({ metrics: [metric(ROWS_RECEIVED_METRIC, [0])] })
    expect((await readSourceCoverage({ dcrResourceId: DCR, query })).status).toBe('no-rows')
  })

  it('a 403 (MI lacks Monitoring Reader) → unknown(forbidden), NEVER a zero', async () => {
    const query: MetricsQueryFn = async () => {
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    }
    expect(await readSourceCoverage({ dcrResourceId: DCR, query })).toMatchObject({
      status: 'unknown',
      reason: 'forbidden',
      rowsReceived: null,
    })
  })

  it('a timeout (AbortSignal) → unknown(probe-timeout)', async () => {
    const query: MetricsQueryFn = async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    }
    expect((await readSourceCoverage({ dcrResourceId: DCR, query })).reason).toBe('probe-timeout')
  })

  it('any other throw → unknown(probe-threw), never propagated to the caller', async () => {
    const query: MetricsQueryFn = async () => {
      throw new Error('network kaput')
    }
    expect((await readSourceCoverage({ dcrResourceId: DCR, query })).reason).toBe('probe-threw')
  })
})
