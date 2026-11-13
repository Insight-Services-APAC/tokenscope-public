import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseConcurrentPerPartition } from '../../../drizzle/concurrent-index'

const MIGRATION = resolve(__dirname, '../../../drizzle/migrations/0173_attribution_record_instance_ts_parts.sql')

describe('parseConcurrentPerPartition (drizzle/concurrent-index.ts)', () => {
  it('reads 0173 as a per-partition build on attribution_record', () => {
    const m = parseConcurrentPerPartition('0173', readFileSync(MIGRATION, 'utf8'))
    expect(m).toEqual({
      table: 'attribution_record',
      unique: false,
      indexTemplate: '{partition}_instance_ts',
      tail: '(instance_id, ts_event) INCLUDE (cost_usd)',
    })
  })

  it('leaves an ordinary migration to the transactional path', () => {
    expect(parseConcurrentPerPartition('x', '-- 0100: something\nCREATE TABLE t (id int);\n')).toBeNull()
    // The directive counts only on the first line.
    expect(
      parseConcurrentPerPartition('x', '-- intro\n-- migrate: concurrent-index-per-partition t\nSELECT 1;'),
    ).toBeNull()
  })

  it('keeps UNIQUE and a quoted name', () => {
    const m = parseConcurrentPerPartition(
      'x',
      '-- migrate: concurrent-index-per-partition t\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "{partition}_u" ON {partition} (a) WHERE b;',
    )
    expect(m).toMatchObject({ table: 't', unique: true, indexTemplate: '{partition}_u', tail: '(a) WHERE b' })
  })

  it.each([
    ['no CONCURRENTLY', 'CREATE INDEX IF NOT EXISTS {partition}_i ON {partition} (a);'],
    ['no IF NOT EXISTS', 'CREATE INDEX CONCURRENTLY {partition}_i ON {partition} (a);'],
    ['a fixed index name', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON {partition} (a);'],
    ['a fixed table', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS {partition}_i ON t (a);'],
    ['an upper-case name', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "{partition}_Idx" ON {partition} (a);'],
    ['two statements', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS {partition}_i ON {partition} (a); SELECT 1;'],
    ['{partition} after ON', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS {partition}_i ON {partition} (a) WHERE x = \'{partition}\';'],
  ])('refuses a file with %s', (_label, statement) => {
    expect(() =>
      parseConcurrentPerPartition('bad.sql', `-- migrate: concurrent-index-per-partition t\n${statement}\n`),
    ).toThrow(/bad\.sql: expected one CREATE INDEX CONCURRENTLY/)
  })
})
