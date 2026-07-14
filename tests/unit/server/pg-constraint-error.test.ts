// @vitest-environment node
/*
 * translatePgConstraintError — the SYS-2 SQLSTATE → HTTP translator.
 *
 * Must catch the code whether it surfaces bare (`.code`, postgres-js) or
 * wrapped (`.cause.code`, DrizzleQueryError), map to the configured
 * 409/404, and RETHROW anything unmapped untouched.
 */
import { describe, it, expect } from 'vitest'
import { isError } from 'h3'
import { translatePgConstraintError } from '../../../server/utils/pg-constraint-error'

function capture(fn: () => unknown): unknown {
  try {
    fn()
    return undefined
  } catch (err) {
    return err
  }
}

describe('translatePgConstraintError', () => {
  it('maps a bare 23P01 (exclusion violation) to 409 with an RFC-9457 body', () => {
    const err = capture(() =>
      translatePgConstraintError(
        { code: '23P01' },
        { '23P01': { title: 'Budget period overlaps', detail: 'Adjust the dates.' } },
      ),
    ) as { statusCode: number; data: Record<string, unknown> }
    expect(isError(err)).toBe(true)
    expect(err.statusCode).toBe(409)
    expect(err.data).toMatchObject({
      type: 'https://tokenscope.example.com/errors/conflict',
      status: 409,
      detail: 'Adjust the dates.',
    })
  })

  it('reads the SQLSTATE off .cause (DrizzleQueryError wrapping)', () => {
    const wrapped = Object.assign(new Error('query failed'), { cause: { code: '23505' } })
    const err = capture(() =>
      translatePgConstraintError(wrapped, {
        '23505': { title: 'Already exists', detail: 'Duplicate.' },
      }),
    ) as { statusCode: number }
    expect(isError(err)).toBe(true)
    expect(err.statusCode).toBe(409)
  })

  it('honours an explicit 404 mapping (FK target vanished)', () => {
    const err = capture(() =>
      translatePgConstraintError(
        { code: '23503' },
        { '23503': { status: 404, title: 'Region not found', detail: 'Deleted while saving.' } },
      ),
    ) as { statusCode: number; data: Record<string, unknown> }
    expect(err.statusCode).toBe(404)
    expect(err.data).toMatchObject({
      type: 'https://tokenscope.example.com/errors/not-found',
      status: 404,
    })
  })

  it('rethrows an unmapped SQLSTATE untouched', () => {
    const original = Object.assign(new Error('deadlock'), { code: '40P01' })
    const err = capture(() =>
      translatePgConstraintError(original, {
        '23505': { title: 'x', detail: 'y' },
      }),
    )
    expect(err).toBe(original)
  })

  it('rethrows a non-PG error untouched', () => {
    const original = new Error('plain failure')
    const err = capture(() => translatePgConstraintError(original, {}))
    expect(err).toBe(original)
  })
})
