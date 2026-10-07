// @vitest-environment node
/*
 * The telemetry-cap read (docs/design/scaling-to-1000-users.md 0.5): one typed,
 * bounded method on the reader that returns the trailing 24 hours' billable
 * ingestion in MB (always at least the usage since the cap's last reset).
 *
 * Pinned: the exact KQL, the bound on both ends (client abort + server timeout,
 * as healthCheck does), and that every way of not knowing the number comes back
 * as `megabytes: null` rather than 0. A 0 would read as "a quiet day" and clear a
 * held cap warning.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryWorkspace = vi.fn()
vi.mock('@azure/monitor-query', () => ({
  LogsQueryClient: class {
    queryWorkspace = queryWorkspace
  },
  LogsQueryResultStatus: { Success: 'Success', PartialFailure: 'PartialFailure' },
  Durations: { oneDay: 'P1D', sevenDays: 'P7D' },
}))
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
}))

/* eslint-disable import/first */
import {
  BILLABLE_INGESTION_LAST_24H_KQL,
  LocalCollectorReader,
  LogAnalyticsReader,
} from '../../../server/azure/reader'
/* eslint-enable import/first */

const success = (value: unknown) => ({ status: 'Success', tables: [{ rows: [[value]], columnDescriptors: [] }] })

beforeEach(() => {
  queryWorkspace.mockReset()
})

describe('BILLABLE_INGESTION_LAST_24H_KQL', () => {
  it('is the query the scaling plan names, verbatim', () => {
    expect(BILLABLE_INGESTION_LAST_24H_KQL).toBe(
      'Usage | where TimeGenerated > ago(24h) | where IsBillable == true | summarize sum(Quantity)',
    )
  })
})

describe('LogAnalyticsReader.billableIngestionLast24h', () => {
  it('sends the KQL to its workspace, bounded on both ends by the caller timeout', async () => {
    queryWorkspace.mockResolvedValueOnce(success(1234.5))
    const reading = await new LogAnalyticsReader('ws-telemetry').billableIngestionLast24h({ timeoutMs: 20_000 })
    expect(reading).toMatchObject({ megabytes: 1234.5, kind: 'log-analytics' })
    expect(reading.error).toBeUndefined()

    const [workspace, query, timespan, options] = queryWorkspace.mock.calls[0]!
    expect(workspace).toBe('ws-telemetry')
    expect(query).toBe(BILLABLE_INGESTION_LAST_24H_KQL)
    expect(timespan).toEqual({ duration: 'P1D' })
    expect(options.serverTimeoutInSeconds).toBe(20)
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('a real zero is zero', async () => {
    queryWorkspace.mockResolvedValueOnce(success(0))
    expect((await new LogAnalyticsReader('ws').billableIngestionLast24h()).megabytes).toBe(0)
  })

  it.each([
    ['a partial result', { status: 'PartialFailure', partialTables: [], partialError: {} }],
    ['an empty cell', success(null)],
    ['no rows', { status: 'Success', tables: [{ rows: [], columnDescriptors: [] }] }],
    ['a negative value', success(-1)],
    ['a non-numeric value', success('lots')],
  ])('%s is no number, not zero', async (_label, response) => {
    queryWorkspace.mockResolvedValueOnce(response)
    const reading = await new LogAnalyticsReader('ws').billableIngestionLast24h()
    expect(reading.megabytes).toBeNull()
    expect(reading.error).toBeDefined()
  })

  it('a thrown SDK error resolves as no number, redacted, with a correlation id', async () => {
    queryWorkspace.mockRejectedValueOnce(new Error('Forbidden: workspace 8f19c2ad-secret-guid'))
    const reading = await new LogAnalyticsReader('ws').billableIngestionLast24h()
    expect(reading.megabytes).toBeNull()
    expect(reading.error).not.toMatch(/8f19c2ad/)
    expect(typeof reading.correlationId).toBe('string')
  })
})

describe('LocalCollectorReader.billableIngestionLast24h', () => {
  it('is unsupported: no number, never zero', async () => {
    const reading = await new LocalCollectorReader('http://127.0.0.1:1').billableIngestionLast24h()
    expect(reading).toEqual({ megabytes: null, kind: 'local', latencyMs: 0, error: 'unsupported' })
  })
})
