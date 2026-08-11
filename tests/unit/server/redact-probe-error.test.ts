// @vitest-environment node
/*
 * classifyProbeError — the redaction contract every admin probe handler
 * shares (modelled on api/health.get.ts's "log raw, return static" pattern).
 * Pins the property that actually matters: NO substring of the raw error —
 * host, database, user, port, connection string — ever reaches the returned
 * value, while the raw error still reaches the server log at full fidelity
 * under a correlation id the caller also gets back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { consola } from 'consola'
import { classifyProbeError } from '../../../server/utils/redact-probe-error'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Shapes postgres-js's `Errors.connection()` factory (src/errors.js). */
function syntheticConnectionError(code: string, host: string, port: number): Error {
  return Object.assign(new Error(`write ${code} ${host}:${port}`), { code, errno: code, address: host, port })
}

/** Shapes postgres-js's PostgresError (src/errors.js `Object.assign(this, x)`). */
function syntheticPostgresError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'PostgresError', code, ...extra })
}

describe('classifyProbeError — redaction', () => {
  it('a synthetic postgres-js connection error carrying host/port maps to a reason code, and NO substring of the input appears in the output', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const result = classifyProbeError(err, 'test-probe')

    expect(result.reason).toBe('connect-refused')
    expect(typeof result.correlationId).toBe('string')
    expect(result.correlationId.length).toBeGreaterThan(0)

    const serialised = JSON.stringify(result)
    for (const secret of ['10.0.0.4', '5432', 'ECONNREFUSED', err.message]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('a synthetic postgres-js auth error carrying host/db/user maps to auth-denied, with no leak', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticPostgresError(
      '28P01',
      'password authentication failed for user "tokenscope-app"',
      { database: 'tokenscope', host: 'ts-pg-dev.postgres.database.azure.com', user: 'tokenscope-app' },
    )
    const result = classifyProbeError(err, 'test-probe')

    expect(result.reason).toBe('auth-denied')
    const serialised = JSON.stringify(result)
    for (const secret of ['tokenscope-app', 'tokenscope', 'ts-pg-dev.postgres.database.azure.com', '28P01', err.message]) {
      expect(serialised).not.toContain(secret)
    }
  })

  it('maps DNS failure, timeout/unreachable, and undefined-table codes to their reason codes', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    expect(classifyProbeError(syntheticConnectionError('ENOTFOUND', 'nope.invalid', 5432), 'x').reason).toBe('dns-fail')
    expect(classifyProbeError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), 'x').reason).toBe('driver-unreachable')
    expect(classifyProbeError(syntheticPostgresError('42P01', 'relation "foo" does not exist'), 'x').reason).toBe('relation-missing')
  })

  it('an error with no recognisable code classifies as unknown, not a guess', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    expect(classifyProbeError(new Error('something odd happened'), 'x').reason).toBe('unknown')
  })

  it('a non-Error thrown value still classifies (unknown) and still redacts', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const result = classifyProbeError('a raw string with secret-token-abc123', 'x')
    expect(result.reason).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('secret-token-abc123')
  })

  it('logs the RAW error server-side at full fidelity, tagged with the SAME correlation id returned to the caller', () => {
    const errSpy = vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const result = classifyProbeError(err, 'diagnostics:postgres')

    expect(errSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = errSpy.mock.calls[0]!
    // The correlation id ties the log line back to this exact response.
    expect(loggedArgs.some((a) => typeof a === 'string' && a.includes(result.correlationId))).toBe(true)
    // The raw error object itself (or its message) reached the log — full fidelity.
    expect(loggedArgs).toContain(err)
  })

  it('two calls for the same underlying error get DIFFERENT correlation ids (no cross-call collision)', () => {
    vi.spyOn(consola, 'error').mockImplementation(() => {})
    const err = syntheticConnectionError('ECONNREFUSED', '10.0.0.4', 5432)
    const a = classifyProbeError(err, 'x')
    const b = classifyProbeError(err, 'x')
    expect(a.correlationId).not.toBe(b.correlationId)
  })
})
