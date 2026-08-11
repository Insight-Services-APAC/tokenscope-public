// @vitest-environment node
/*
 * DATABASE_URL TLS posture — S11 (mitm:0001-0003, config:asvs-0003/0015).
 *
 * postgres@3.4.9 only authenticates the server for the literal string
 * sslmode=verify-full (connection.js:283-286 special-cases
 * require/allow/prefer to rejectUnauthorized=false; every other string,
 * including verify-full, falls through to Node's default
 * rejectUnauthorized=true + hostname verification). scripts/preflight.ts's
 * checkDatabaseUrlTls / warnOnInsecureDatabaseTls surface a non-conforming
 * URL as a boot-time WARNING (never a throw — see the file for why).
 *
 * The second half is a static assertion over
 * infra/modules/keyvault-secrets.bicep's constructed database-url value, in
 * the style of scripts/check-persona-override-params.mjs: read the file as
 * text and assert the single upstream cause (the literal sslmode) is
 * correct, rather than only asserting the runtime guard's behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { consola } from 'consola'
import { checkDatabaseUrlTls, warnOnInsecureDatabaseTls } from '../../../scripts/preflight'

describe('checkDatabaseUrlTls', () => {
  it('silent for loopback hosts regardless of sslmode', () => {
    expect(checkDatabaseUrlTls('postgres://u:p@localhost:5432/db').insecure).toBe(false)
    expect(checkDatabaseUrlTls('postgres://u:p@127.0.0.1:5432/db').insecure).toBe(false)
    expect(checkDatabaseUrlTls('postgres://u:p@[::1]:5432/db').insecure).toBe(false)
  })

  it('silent for a non-loopback host with sslmode=verify-full', () => {
    const r = checkDatabaseUrlTls('postgres://u:p@pg.example.com:5432/db?sslmode=verify-full')
    expect(r.insecure).toBe(false)
    expect(r.host).toBe('pg.example.com')
  })

  it('warns for a non-loopback host with sslmode=require (the pre-fix default — rejectUnauthorized=false)', () => {
    const r = checkDatabaseUrlTls('postgres://u:p@pg.example.com:5432/db?sslmode=require')
    expect(r.insecure).toBe(true)
    expect(r.reason).toBe('sslmode=require')
  })

  it('warns for a non-loopback host with no sslmode at all', () => {
    const r = checkDatabaseUrlTls('postgres://u:p@pg.example.com:5432/db')
    expect(r.insecure).toBe(true)
    expect(r.reason).toBe('no sslmode set')
  })

  it('warns for a docker/compose-network hostname (not loopback, even though "local")', () => {
    // .env.example's local default — a WARN here is harmless (never blocks boot);
    // "must not break local dev" only constrains a throw, which this is not.
    const r = checkDatabaseUrlTls('postgresql://tokenscope:tokenscope@tokenscope-postgres:5432/tokenscope')
    expect(r.insecure).toBe(true)
  })

  it('silent when DATABASE_URL is unset or unparseable (a different check owns that failure mode)', () => {
    expect(checkDatabaseUrlTls(undefined).insecure).toBe(false)
    expect(checkDatabaseUrlTls('not a url').insecure).toBe(false)
  })
})

describe('warnOnInsecureDatabaseTls', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls consola.warn for an insecure non-loopback URL', () => {
    const spy = vi.spyOn(consola, 'warn').mockImplementation(() => undefined as never)
    warnOnInsecureDatabaseTls({ DATABASE_URL: 'postgres://u:p@pg.example.com:5432/db' } as NodeJS.ProcessEnv)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toMatch(/verify-full/)
  })

  it('stays silent for loopback', () => {
    const spy = vi.spyOn(consola, 'warn').mockImplementation(() => undefined as never)
    warnOnInsecureDatabaseTls({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' } as NodeJS.ProcessEnv)
    expect(spy).not.toHaveBeenCalled()
  })

  it('stays silent for verify-full', () => {
    const spy = vi.spyOn(consola, 'warn').mockImplementation(() => undefined as never)
    warnOnInsecureDatabaseTls({
      DATABASE_URL: 'postgres://u:p@pg.example.com:5432/db?sslmode=verify-full',
    } as NodeJS.ProcessEnv)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('infra/modules/keyvault-secrets.bicep — the single upstream cause', () => {
  it('constructs database-url with sslmode=verify-full, never sslmode=require', () => {
    const bicepPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'infra',
      'modules',
      'keyvault-secrets.bicep',
    )
    const body = readFileSync(bicepPath, 'utf8')
    const valueLine = body.split('\n').find((l) => l.includes("value: 'postgresql://"))
    expect(valueLine, 'database-url secret value line not found').toBeTruthy()
    expect(valueLine).toContain('sslmode=verify-full')
    expect(valueLine).not.toContain('sslmode=require')
  })
})
