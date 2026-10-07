// @vitest-environment node
/*
 * runReadJoiner — lanes, the deadline and the run result
 * (docs/design/scaling-to-1000-users.md, Phase 1 item 2).
 *
 * The joiner reads a tick's devices in JOINER_CONCURRENCY lanes, grouped by
 * teammate because span keys omit the device, and starts no device after
 * JOINER_DEADLINE_MS. The DB is faked by SQL text (the selection, the watermark
 * reads and the rotation stamp are what these tests look at); the reader is a
 * stub that records what was in flight. The SQL behaviour itself (rotation,
 * stamp contents, the watermark bound) is pinned against real Postgres in
 * tests/integration/azure/joiner-rotation.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { TelemetryReader, UsageRecord, SessionSummary, ReaderHealth } from '../../../server/azure/reader'
import {
  runReadJoiner,
  JOINER_CONCURRENCY,
  JOINER_DEADLINE_MS,
  JOINER_PROVISIONAL_EVERY,
} from '../../../server/workers/azure-monitor-reader'

const dialect = new PgDialect()

interface Device {
  instance: string
  teammate: string
  readAgeS?: string | null
  provisional?: boolean
}

const id = (n: number) => `9a1e0000-0000-4000-8000-${n.toString().padStart(12, '0')}`

/** n devices for each teammate in `perTeammate`, ids in teammate-major order. */
function fleet(perTeammate: number[]): Device[] {
  const out: Device[] = []
  let n = 1
  perTeammate.forEach((count, t) => {
    for (let i = 0; i < count; i++) out.push({ instance: id(n++), teammate: id(1000 + t) })
  })
  return out
}

function sessionRow(d: Device) {
  return {
    instance_id: d.instance,
    teammate_id: d.teammate,
    region_id: id(9001),
    org_unit_id: id(9002),
    cost_owning_unit_id: id(9003),
    project_code_hash: null,
    tool: 'claude-code',
    identity_state: d.provisional ? 'provisional' : 'confirmed',
    read_age_s: d.readAgeS ?? null,
  }
}

/**
 * Fake db: answers the selection with `rows` (in the order given, which tests
 * use to prove the joiner restores the caller's order), records every executed
 * statement, and can be told to fail the rotation stamp.
 */
function fakeDb(rows: Device[], opts: { failStamp?: boolean } = {}) {
  const statements: { sql: string; params: unknown[] }[] = []
  const execute = async (q: SQL) => {
    const { sql, params } = dialect.sqlToQuery(q)
    statements.push({ sql, params })
    if (/UPDATE instance_attestation\s+SET joiner_read_at/.test(sql)) {
      if (opts.failStamp) throw new Error('stamp failed')
      return []
    }
    if (/FROM instance_attestation/.test(sql) && /read_age_s/.test(sql)) return rows.map(sessionRow)
    return []
  }
  // The stale-dismissal sweep runs in a transaction; it is not under test here.
  const transaction = async (cb: (tx: { execute: typeof execute }) => Promise<unknown>) => cb({ execute })
  return { db: { execute, transaction } as never, statements }
}

/** Reader that holds each call open for a tick and records concurrency. */
class InstrumentedReader implements TelemetryReader {
  readonly order: string[] = []
  inFlight = 0
  maxInFlight = 0
  readonly perTeammate = new Map<string, number>()
  maxPerTeammate = 0
  constructor(
    private readonly teammateOf: Map<string, string>,
    private readonly opts: { failFor?: Set<string>; onCall?: () => void } = {},
  ) {}
  async getSessionUsage(sessionId: string): Promise<UsageRecord[]> {
    this.order.push(sessionId)
    this.opts.onCall?.()
    const t = this.teammateOf.get(sessionId)!
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    const n = (this.perTeammate.get(t) ?? 0) + 1
    this.perTeammate.set(t, n)
    this.maxPerTeammate = Math.max(this.maxPerTeammate, n)
    try {
      await new Promise((r) => setTimeout(r, 2))
      if (this.opts.failFor?.has(sessionId)) throw new Error('Log Analytics query timed out')
      return []
    } finally {
      this.inFlight -= 1
      this.perTeammate.set(t, (this.perTeammate.get(t) ?? 1) - 1)
    }
  }
  async listSessions(): Promise<SessionSummary[]> {
    return []
  }
  async healthCheck(): Promise<ReaderHealth> {
    return { ok: true, kind: 'local', latencyMs: 0 }
  }
}

const teammateMap = (devices: Device[]) => new Map(devices.map((d) => [d.instance, d.teammate]))

describe('runReadJoiner — lanes', () => {
  it(`never runs more than ${JOINER_CONCURRENCY} devices at once, nor two of one teammate`, async () => {
    // 6 teammates, one with 4 devices: enough groups to fill every lane, and a
    // teammate whose devices would overlap if grouping were lost.
    const devices = fleet([4, 1, 2, 1, 3, 1])
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices))
    const res = await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance) })
    expect(reader.maxInFlight).toBe(JOINER_CONCURRENCY) // really concurrent, and bounded
    expect(reader.maxPerTeammate).toBe(1)
    expect(res.devicesAttempted).toBe(devices.length)
    expect(res.deadlineHit).toBe(false)
  })

  it('a failing device stops neither its own lane nor the others', async () => {
    const devices = fleet([3, 2, 2])
    const failing = new Set([devices[0]!.instance, devices[3]!.instance])
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { failFor: failing })
    const res = await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance) })
    expect(new Set(reader.order)).toEqual(new Set(devices.map((d) => d.instance)))
    expect(res.errors).toBe(2)
    expect(res.devicesAttempted).toBe(devices.length)
  })

  it("keeps the caller's order: a teammate group goes where its first device was selected", async () => {
    // Selection order c1, a1, b1, a2 (a = one teammate). The DB returns rows in
    // another order, as an IN (...) query may.
    const a = id(1001)
    const b = id(1002)
    const c = id(1003)
    const a1 = { instance: id(1), teammate: a }
    const a2 = { instance: id(2), teammate: a }
    const b1 = { instance: id(3), teammate: b }
    const c1 = { instance: id(4), teammate: c }
    const { db } = fakeDb([a1, a2, b1, c1])
    const reader = new InstrumentedReader(teammateMap([a1, a2, b1, c1]))
    await runReadJoiner(db, reader, { sessionIds: [c1.instance, a1.instance, b1.instance, a2.instance] })
    // Lanes start c's, a's and b's groups in that order; a2 follows a1 in a's lane.
    expect(reader.order.slice(0, 3)).toEqual([c1.instance, a1.instance, b1.instance])
    expect(reader.order.indexOf(a2.instance)).toBeGreaterThan(reader.order.indexOf(a1.instance))
  })
})

describe('runReadJoiner — the deadline', () => {
  it('starts no device after JOINER_DEADLINE_MS, checked before every device, not only every group', async () => {
    // One teammate, ten devices: a single group, so a per-group check would run
    // all ten. Each read takes 30 s of the injected clock.
    const devices = fleet([10])
    let nowMs = 1_000_000
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { onCall: () => (nowMs += 30_000) })
    const res = await runReadJoiner(db, reader, {
      sessionIds: devices.map((d) => d.instance),
      clock: () => nowMs,
    })
    // Started at +0, +30 s, +60 s; the fourth would start at +90 s > 80 s.
    expect(reader.order).toHaveLength(3)
    expect(res.devicesAttempted).toBe(3)
    expect(res.devicesSelected).toBe(10)
    expect(res.sessionsProcessed).toBe(10)
    expect(res.deadlineHit).toBe(true)
    expect(JOINER_DEADLINE_MS).toBe(80_000)
  })

  it('stops every lane at the deadline', async () => {
    const devices = fleet([1, 1, 1, 1, 1, 1])
    let nowMs = 0
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { onCall: () => (nowMs += 30_000) })
    const res = await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance), clock: () => nowMs })
    expect(reader.order).toHaveLength(3) // +0, +30, +60; nothing at +90
    expect(res.deadlineHit).toBe(true)
  })

  it("measures the deadline from the caller's tick start, not from its own", async () => {
    // The registry spent 75 s (coverage probe, selection) before calling in.
    const devices = fleet([1, 1, 1])
    let nowMs = 1_075_000
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { onCall: () => (nowMs += 10_000) })
    const res = await runReadJoiner(db, reader, {
      sessionIds: devices.map((d) => d.instance),
      clock: () => nowMs,
      startedAtMs: 1_000_000,
    })
    // +75 s from the tick start: one device; the next would start at +85 s.
    expect(res.devicesAttempted).toBe(1)
    expect(res.deadlineHit).toBe(true)
  })

  it('a run that fits reports no deadline hit', async () => {
    const devices = fleet([2, 2])
    const { db } = fakeDb(devices)
    const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
      sessionIds: devices.map((d) => d.instance),
    })
    expect(res.deadlineHit).toBe(false)
    expect(res.devicesAttempted).toBe(4)
    expect(res.heapUsedPeakMb).toBeGreaterThan(0)
  })
})

describe('runReadJoiner — the rotation stamp', () => {
  function stampedIds(statements: { sql: string; params: unknown[] }[]): unknown[][] {
    return statements.filter((s) => /UPDATE instance_attestation\s+SET joiner_read_at/.test(s.sql)).map((s) => s.params)
  }

  it('stamps exactly the attempted devices, in one statement, when the deadline cut the run short', async () => {
    const devices = fleet([10])
    let nowMs = 0
    const { db, statements } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { onCall: () => (nowMs += 30_000) })
    await runReadJoiner(db, reader, {
      sessionIds: devices.map((d) => d.instance),
      clock: () => nowMs,
      stampReadAt: true,
    })
    const stamps = stampedIds(statements)
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toEqual(devices.slice(0, 3).map((d) => d.instance))
  })

  it('stamps a device whose read failed', async () => {
    const devices = fleet([1, 1])
    const { db, statements } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { failFor: new Set([devices[0]!.instance]) })
    await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance), stampReadAt: true })
    expect(new Set(stampedIds(statements)[0])).toEqual(new Set(devices.map((d) => d.instance)))
  })

  it('does not stamp unless asked (explicit, operator and recovery runs)', async () => {
    const devices = fleet([1, 1])
    const { db, statements } = fakeDb(devices)
    await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), { sessionIds: devices.map((d) => d.instance) })
    expect(stampedIds(statements)).toHaveLength(0)
  })

  it('a failed stamp never fails the run, and is reported', async () => {
    const devices = fleet([1])
    const { db } = fakeDb(devices, { failStamp: true })
    const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
      sessionIds: devices.map((d) => d.instance),
      stampReadAt: true,
    })
    expect(res.devicesAttempted).toBe(1)
    expect(res.rotationStampFailed).toBe(true)
  })

  it('a stamp that succeeds, or is not asked for, reports no failure', async () => {
    const devices = fleet([1])
    for (const stampReadAt of [true, false]) {
      const { db } = fakeDb(devices)
      const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
        sessionIds: devices.map((d) => d.instance),
        stampReadAt,
      })
      expect(res.rotationStampFailed).toBe(false)
    }
  })
})

describe('runReadJoiner — oldestReadAgeMinutes', () => {
  it('is the largest read age among selected devices, ignoring never-read ones', async () => {
    const devices = fleet([1, 1, 1]).map((d, i) => ({ ...d, readAgeS: ['7259.9', null, '600.4'][i] }))
    const { db } = fakeDb(devices)
    const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
      sessionIds: devices.map((d) => d.instance),
    })
    expect(res.oldestReadAgeMinutes).toBe(120)
  })

  it('is null when no selected device has been read', async () => {
    const devices = fleet([1, 1])
    const { db } = fakeDb(devices)
    const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
      sessionIds: devices.map((d) => d.instance),
    })
    expect(res.oldestReadAgeMinutes).toBeNull()
  })

  it('never-read selected devices are counted in devicesNeverRead, which the age cannot show', async () => {
    const devices = fleet([1, 1, 1]).map((d, i) => ({ ...d, readAgeS: ['600', null, null][i] }))
    const { db } = fakeDb(devices)
    const res = await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), {
      sessionIds: devices.map((d) => d.instance),
    })
    expect(res.oldestReadAgeMinutes).toBe(10)
    expect(res.devicesNeverRead).toBe(2)
  })
})

describe('runReadJoiner — provisional devices are not starved by the deadline', () => {
  it(`gives every ${JOINER_PROVISIONAL_EVERY}th group to a provisional teammate while any remain`, async () => {
    // 40 confirmed teammates then 3 provisional, in selection order (confirmed
    // first, as selectJoinableInstances returns them). Each read costs 3 s of
    // the clock across three lanes: about 27 devices start before 80 s, so in
    // selection order no provisional device would ever be reached.
    const confirmed = fleet(new Array(40).fill(1))
    const provisional = [41, 42, 43].map((n) => ({ instance: id(n), teammate: id(2000 + n), provisional: true }))
    const devices = [...confirmed, ...provisional]
    let nowMs = 0
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices), { onCall: () => (nowMs += 3_000) })
    const res = await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance), clock: () => nowMs })

    expect(res.deadlineHit).toBe(true)
    expect(res.devicesAttempted).toBeLessThan(confirmed.length)
    const provisionalIds = new Set(provisional.map((d) => d.instance))
    const startedProvisional = reader.order.filter((i) => provisionalIds.has(i))
    expect(startedProvisional.length).toBeGreaterThan(0)
    // Exactly at the 10th, 20th, ... take.
    expect(reader.order[JOINER_PROVISIONAL_EVERY - 1]).toBe(provisional[0]!.instance)
    expect(reader.order[2 * JOINER_PROVISIONAL_EVERY - 1]).toBe(provisional[1]!.instance)
  })

  it('a run that fits still reads every device once, provisional ones included', async () => {
    const devices = [
      ...fleet([1, 1, 1]),
      { instance: id(50), teammate: id(3050), provisional: true },
    ]
    const { db } = fakeDb(devices)
    const reader = new InstrumentedReader(teammateMap(devices))
    const res = await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance) })
    expect(res.devicesAttempted).toBe(4)
    expect(new Set(reader.order)).toEqual(new Set(devices.map((d) => d.instance)))
  })
})

describe('runReadJoiner — the watermark bound follows the reader', () => {
  function watermarkSql(statements: { sql: string; params: unknown[] }[]) {
    return statements.filter((s) => /MAX\(ts_event\)/.test(s.sql))
  }

  it("bounds both watermark reads by the reader's applied lookback", async () => {
    const devices = fleet([1])
    const { db, statements } = fakeDb(devices)
    const reader = Object.assign(new InstrumentedReader(teammateMap(devices)), {
      appliedLookbackDays: 30,
      getSignalUsage: async () => [],
    })
    await runReadJoiner(db, reader, { sessionIds: devices.map((d) => d.instance) })
    const wm = watermarkSql(statements)
    expect(wm).toHaveLength(2) // attribution_record and usage_signal_record
    for (const s of wm) {
      expect(s.sql).toMatch(/ts_event >= now\(\) - make_interval\(days => \$\d+::int\)/)
      expect(s.params).toContain(30)
    }
  })

  it('leaves the watermark unbounded for a reader with no outer bound (the local collector)', async () => {
    const devices = fleet([1])
    const { db, statements } = fakeDb(devices)
    await runReadJoiner(db, new InstrumentedReader(teammateMap(devices)), { sessionIds: devices.map((d) => d.instance) })
    for (const s of watermarkSql(statements)) expect(s.sql).not.toMatch(/make_interval/)
  })
})
