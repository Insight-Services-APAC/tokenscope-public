// @vitest-environment node
/*
 * LogAnalyticsReader.instancePresence — the ingest half of the client-vs-server
 * discriminator, against a mocked Azure SDK.
 *
 * The property that matters here is not "it returns a number". It is that a
 * query which did NOT run must THROW rather than return zeroes. A failed query
 * and an empty workspace produce identical counts and opposite diagnoses, so a
 * fail-soft here would quietly convert our own outage into a confident verdict
 * that the user's device is broken. Nothing downstream can recover that
 * distinction once it is lost, which is why it is pinned at the source.
 *
 * The window is the other one: the query duration must cover the whole window
 * the KQL asks for. If our own clamp narrowed it, "absent from ingest" would be
 * an artefact of the clamp — the same silent-narrowing that made a recoverable
 * backlog look unrecoverable during the dead-zone incident.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryWorkspace = vi.fn(async () => ({
  status: 'Success',
  tables: [
    {
      columnDescriptors: [
        { name: 'Records' },
        { name: 'UsageRecords' },
        { name: 'FirstSeen' },
        { name: 'LastSeen' },
      ],
      rows: [[912, 900, new Date('2026-07-16T01:00:00Z'), new Date('2026-07-24T09:30:00Z')]],
    },
  ],
}))

vi.mock('@azure/monitor-query', () => ({
  LogsQueryClient: class {
    queryWorkspace = queryWorkspace
  },
  LogsQueryResultStatus: { Success: 'Success' },
  Durations: { oneDay: 'P1D', sevenDays: 'P7D' },
}))
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: vi.fn() }))

/* eslint-disable import/first */
import { LocalCollectorReader, LogAnalyticsReader, type UsageRecord } from '../../../server/azure/reader'
/* eslint-enable import/first */

const ID = '11111111-1111-4111-8111-111111111111'

/** The `duration` of the last query the reader sent. */
function lastDuration(): string {
  const calls = queryWorkspace.mock.calls as unknown as Array<[string, string, { duration: string }]>
  return calls[calls.length - 1]![2].duration
}
function lastKql(): string {
  const calls = queryWorkspace.mock.calls as unknown as Array<[string, string, { duration: string }]>
  return calls[calls.length - 1]![1]
}

beforeEach(() => {
  queryWorkspace.mockClear()
  queryWorkspace.mockResolvedValue({
    status: 'Success',
    tables: [
      {
        columnDescriptors: [
          { name: 'Records' },
          { name: 'UsageRecords' },
          { name: 'FirstSeen' },
          { name: 'LastSeen' },
        ],
        rows: [[912, 900, new Date('2026-07-16T01:00:00Z'), new Date('2026-07-24T09:30:00Z')]],
      },
    ],
  })
})

describe('LogAnalyticsReader.instancePresence', () => {
  it('returns the counts and the seen-range', async () => {
    const reader = new LogAnalyticsReader('ws', {})
    expect(await reader.instancePresence(ID, 168)).toEqual({
      records: 912,
      usageRecords: 900,
      firstSeen: '2026-07-16T01:00:00.000Z',
      lastSeen: '2026-07-24T09:30:00.000Z',
    })
  })

  it('sends a query duration covering the WHOLE requested window', async () => {
    // If the outer duration were narrower than the KQL window, an absence would
    // be produced by our clamp rather than observed on the device.
    const reader = new LogAnalyticsReader('ws', {})
    await reader.instancePresence(ID, 168)
    expect(lastDuration()).toBe('PT168H')
    expect(lastKql()).toContain('ago(168h)')
  })

  it('ignores the reader\'s configured lookbackDays — the caller\'s window wins', async () => {
    // instancePresence is a probe, not a joiner read: it must answer the question
    // that was ASKED, not the one the scheduled tick happens to be configured for.
    const reader = new LogAnalyticsReader('ws', { lookbackDays: 7 })
    await reader.instancePresence(ID, 720)
    expect(lastDuration()).toBe('PT720H')
  })

  it('clamps an absurd window to the retention ceiling rather than sending it', async () => {
    const reader = new LogAnalyticsReader('ws', {})
    await reader.instancePresence(ID, 99_999)
    expect(lastDuration()).toBe(`PT${24 * 90}H`)
  })

  it('THROWS on a non-success status — never degrades to zeroes', async () => {
    // The single most important behaviour in this file. Returning
    // {records: 0} here would make a broken query indistinguishable from a
    // device that exported nothing, and the verdict would blame the device.
    queryWorkspace.mockResolvedValue({ status: 'PartialFailure', tables: [] } as never)
    const reader = new LogAnalyticsReader('ws', {})
    await expect(reader.instancePresence(ID, 24)).rejects.toThrow(/did not succeed/)
  })

  it('THROWS when the result carries no table — also not evidence of absence', async () => {
    queryWorkspace.mockResolvedValue({ status: 'Success', tables: [] } as never)
    const reader = new LogAnalyticsReader('ws', {})
    await expect(reader.instancePresence(ID, 24)).rejects.toThrow(/no result table/)
  })

  it('reads a genuine empty workspace as zeroes (a row of zeroes IS an answer)', async () => {
    // The complement of the two throws above: KQL scalar aggregation returns one
    // row even for empty input, and THAT is the honest "nothing arrived".
    queryWorkspace.mockResolvedValue({
      status: 'Success',
      tables: [
        {
          columnDescriptors: [
            { name: 'Records' },
            { name: 'UsageRecords' },
            { name: 'FirstSeen' },
            { name: 'LastSeen' },
          ],
          rows: [[0, 0, null, null]],
        },
      ],
    } as never)
    const reader = new LogAnalyticsReader('ws', {})
    expect(await reader.instancePresence(ID, 24)).toEqual({
      records: 0,
      usageRecords: 0,
      firstSeen: null,
      lastSeen: null,
    })
  })

  it('falls back to the positional projection when the table carries no column names', async () => {
    queryWorkspace.mockResolvedValue({
      status: 'Success',
      tables: [{ columnDescriptors: [], rows: [[7, 3, null, null]] }],
    } as never)
    const reader = new LogAnalyticsReader('ws', {})
    const r = await reader.instancePresence(ID, 24)
    expect(r.records).toBe(7)
    expect(r.usageRecords).toBe(3)
  })

  it('falls back when descriptors EXIST but carry no usable names — a zero here is a verdict', async () => {
    // The dangerous near-miss: four descriptors with undefined names pass a
    // length check, every column lookup misses, and the probe reports zeroes —
    // which renders as a confident 'absent-from-ingest' blaming the device for a
    // deserialisation quirk on our side. Falling back on USABILITY, not length.
    queryWorkspace.mockResolvedValue({
      status: 'Success',
      tables: [
        {
          columnDescriptors: [{ name: undefined }, { name: undefined }, { name: undefined }, { name: undefined }],
          rows: [[7, 3, null, null]],
        },
      ],
    } as never)
    const reader = new LogAnalyticsReader('ws', {})
    const r = await reader.instancePresence(ID, 24)
    expect(r.records).toBe(7)
    expect(r.usageRecords).toBe(3)
  })

  it('refuses a non-UUID-shaped instance id before it can reach the KQL', async () => {
    const reader = new LogAnalyticsReader('ws', {})
    await expect(reader.instancePresence("' or '1'='1", 24)).rejects.toThrow(/UUID-shaped/)
    expect(queryWorkspace).not.toHaveBeenCalled()
  })
})

/*
 * LocalCollectorReader.instancePresence — the dev/local implementation.
 *
 * It exists so local and test runs exercise the SAME code path as production
 * rather than a stub, and its only real logic is the WINDOW: the local store
 * returns an instance's full history, so the window has to be applied here. Get
 * that wrong and a local operator reads an "absent from ingest" that is purely an
 * artefact of the filter. The HTTP fetch is bypassed by shadowing
 * getSessionUsage on the instance — this is a test of the windowing, not of the
 * store protocol (which the route integration test covers end to end).
 */
function localReaderReturning(usage: UsageRecord[]): LocalCollectorReader {
  const reader = new LocalCollectorReader('http://unused.invalid')
  Object.defineProperty(reader, 'getSessionUsage', { value: async () => usage })
  return reader
}
function usageAt(hoursAgo: number): UsageRecord {
  return {
    tokens: 10,
    tokenType: 'input',
    model: 'm',
    tsEvent: new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
  }
}

describe('LocalCollectorReader.instancePresence', () => {
  it('counts only records INSIDE the window', async () => {
    const reader = localReaderReturning([usageAt(1), usageAt(5), usageAt(200)])
    const r = await reader.instancePresence(ID, 24)
    expect(r.records).toBe(2)
  })

  it('widening the window brings the older records back', async () => {
    // The mirror of the test above: proves the boundary is the WINDOW and not an
    // unrelated filter that happens to drop rows.
    const reader = localReaderReturning([usageAt(1), usageAt(5), usageAt(200)])
    expect((await reader.instancePresence(ID, 336)).records).toBe(3)
  })

  it('reports the first and last seen times across the window', async () => {
    const reader = localReaderReturning([usageAt(5), usageAt(1), usageAt(3)])
    const r = await reader.instancePresence(ID, 24)
    expect(new Date(r.firstSeen!).getTime()).toBeLessThan(new Date(r.lastSeen!).getTime())
  })

  it('reports zeroes and null times for an instance with nothing in the window', async () => {
    const reader = localReaderReturning([usageAt(200)])
    expect(await reader.instancePresence(ID, 24)).toEqual({
      records: 0,
      usageRecords: 0,
      firstSeen: null,
      lastSeen: null,
    })
  })

  it('drops a record with an unparseable timestamp rather than counting it', async () => {
    // A record we cannot place in time cannot answer "was it in the window",
    // and counting it would inflate the evidence behind a verdict.
    const reader = localReaderReturning([usageAt(1), { ...usageAt(1), tsEvent: 'not-a-date' }])
    expect((await reader.instancePresence(ID, 24)).records).toBe(1)
  })

  it('refuses a non-UUID-shaped instance id', async () => {
    const reader = localReaderReturning([])
    await expect(reader.instancePresence("' or '1'='1", 24)).rejects.toThrow(/UUID-shaped/)
  })
})
