// @vitest-environment node
/*
 * GUARD — /api/health reports the artefact's real version.
 *
 * It read `process.env.APP_VERSION`, which NOTHING sets: no Dockerfile ARG, no
 * Bicep env var, no CI step. So the probe answered `"version":"unknown"` for
 * the life of the endpoint while `/api/v1/meta/build` had the real value from
 * runtimeConfig all along — two build-identity answers in one app, one of them
 * permanently wrong.
 *
 * Static, because the alternative is booting Nitro to assert one field.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../../..')
const health = readFileSync(resolve(ROOT, 'server/api/health.get.ts'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }

describe('/api/health build identity', () => {
  it('reads runtimeConfig, not an env var nothing sets', () => {
    /*
     * The READ, not the mention. The file explains why APP_VERSION is gone, so
     * a bare substring check fails on its own comment — the same way the
     * exit-5 negation guard once fired on the sentence written to refute it.
     */
    expect(health, 'nothing reads the env var that nothing sets').not.toMatch(
      /process\.env\.APP_VERSION/,
    )
    expect(health).toContain('useRuntimeConfig().public.appVersion')
  })

  it('uses the same source as /api/v1/meta/build', () => {
    const meta = readFileSync(resolve(ROOT, 'server/api/v1/meta/build.get.ts'), 'utf8')
    expect(meta).toContain('config.public.appVersion')
    expect(health).toContain('appVersion')
  })

  it('package.json carries a semver the app can report', () => {
    // Accepts a prerelease (1.0.0-rc.1) — the shape we ship release candidates
    // under — and rejects the absent/placeholder cases.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    expect(pkg.version).not.toBe('0.0.0')
  })
})
