// @vitest-environment node
/*
 * POST /api/v1/setup/enroll — the no-login emit-on-install enroll path (slice 3).
 *
 * docs/design/emit-on-install-provisional-attribution.md §Flows 1. Covers the
 * threat-model invariants: secret gate (the ONLY distinguishable outcome →
 * 401), provisional-only shadow teammate + server-chosen instance, emit-only
 * credential, idempotent reuse, constant-shape (known vs unknown email), and the
 * provisional caps (429).
 *
 * Real DB via testcontainers (AGENTS.md: never mock Drizzle). The h3 handler is
 * driven directly through the same ev() harness as
 * tests/integration/setup/provision-redeem-robustness.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import * as schema from '../../../drizzle/schema'
import { hashSessionToken } from '../../../server/auth/hmac'
import enrollHandler from '../../../server/api/v1/setup/enroll.post'

let t: TestDb
let regionId: string
let ouId: string

const BOOTSTRAP_SECRET = 'enroll-bootstrap-secret-value-123456'

beforeAll(async () => {
  t = await startTestDb()
  process.env.DATABASE_URL = t.url
  process.env.NUXT_SESSION_SECRET = 'enroll-test-padded-to-thirty-two-chars!!!'
  process.env.NUXT_HMAC_SESSION_KEY = 'enroll-test-hmac-key-padded-well-beyond-32-chars'
  process.env.NUXT_ENROLLMENT_SECRET = BOOTSTRAP_SECRET

  const [r] = await t.db.insert(schema.region).values({ code: 'en', displayName: 'EN Region' }).returning()
  regionId = r!.id
  const [ou] = await t.db
    .insert(schema.orgUnit)
    .values({ regionId, path: 'en.svc', code: 'en-svc', displayName: 'EN Svc', unitType: 'bu', isCostOwningUnit: true })
    .returning()
  ouId = ou!.id
  // A REAL (provisional=false) teammate whose email an attacker might claim — used
  // to assert constant-shape (known vs unknown) + that enroll never touches it.
  await t.db
    .insert(schema.teammate)
    .values({ entraOid: 'en-oid-real', email: 'known@example.com', displayName: 'Known', role: 'developer', regionId, orgUnitId: ouId })
    .returning()
}, 90_000)

afterAll(async () => {
  await stopTestDb(t)
}, 30_000)

// ── harness (mirrors provision-redeem-robustness.test.ts ev()) ────────────────

function ev(body: unknown) {
  const headers: Record<string, string> = { host: 'localhost:3450' }
  return {
    method: 'POST',
    path: '/x',
    context: { params: {} },
    node: {
      req: {
        method: 'POST',
        url: '/x',
        body,
        get headers() {
          return { ...headers, 'content-type': 'application/json' }
        },
      },
      res: {
        _headers: {} as Record<string, string | string[]>,
        statusCode: 200,
        getHeader(n: string) { return this._headers[n.toLowerCase()] },
        setHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        removeHeader(n: string) { this._headers[n.toLowerCase()] = '' },
        appendHeader(n: string, v: string | string[]) { this._headers[n.toLowerCase()] = v },
        get headersSent() { return false },
      },
    },
  }
}

interface EnrollResponse {
  instance_id: string
  session_id: string
  bearer_endpoint: string
  oauth_refresh_token: string
  oauth_token_endpoint: string
  oauth_client_id: string
  project_code: null
  unassigned: boolean
  tool: string
  // claude-code → { claude }, copilot-cli → { copilot } (P1-5 discriminator).
  telemetry: { claude?: Record<string, unknown>; copilot?: Record<string, unknown> }
}

async function enroll(body: unknown): Promise<EnrollResponse> {
  return (await enrollHandler(ev(body) as unknown as Parameters<typeof enrollHandler>[0])) as EnrollResponse
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    enrollment_secret: BOOTSTRAP_SECRET,
    claimed_email: 'alice@example.com',
    device_binding: 'device-aaa',
    ...overrides,
  }
}

async function emitScopesForInstance(instanceId: string): Promise<string[]> {
  const rows = await t.client<{ scope: string }[]>`
    SELECT scope FROM oauth_token
     WHERE instance_id = ${instanceId}::uuid AND revoked_at IS NULL`
  return rows.map((r) => r.scope)
}

// ── secret gate ───────────────────────────────────────────────────────────────

describe('enroll — secret gate', () => {
  it('a valid bootstrap secret mints a provisional instance bound to a provisional teammate', async () => {
    const out = await enroll(validBody({ claimed_email: 'gate-ok@example.com', device_binding: 'dev-gate-ok' }))
    expect(out.instance_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.oauth_refresh_token).toMatch(/.{20,}/)

    const att = await t.client<{ identity_state: string; claimed_email: string; teammate_id: string; principal_email: string | null }[]>`
      SELECT identity_state, claimed_email, teammate_id::text AS teammate_id, principal_email
        FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.identity_state).toBe('provisional')
    expect(att[0]!.claimed_email).toBe('gate-ok@example.com')
    expect(att[0]!.principal_email).toBeNull()

    const tm = await t.client<{ provisional: boolean; entra_oid: string; email: string }[]>`
      SELECT provisional, entra_oid, email FROM teammate WHERE id = ${att[0]!.teammate_id}::uuid`
    expect(tm[0]!.provisional).toBe(true)
    expect(tm[0]!.entra_oid).toMatch(/^provisional:/)
    expect(tm[0]!.email).toBe('gate-ok@example.com')
  })

  it('accepts a secret from a live enrollment_secret row (the durable accept-list)', async () => {
    const rowSecret = 'table-secret-rotation-cohort-A-7777'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, label, not_before, not_after)
      VALUES (${hashSessionToken(rowSecret)}, 'cohort-A', now() - interval '1 hour', now() + interval '1 hour')`
    const out = await enroll(validBody({ enrollment_secret: rowSecret, claimed_email: 'table@example.com', device_binding: 'dev-table' }))
    expect(out.instance_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects a bad secret with 401 (the only distinguishable failure)', async () => {
    await expect(enroll(validBody({ enrollment_secret: 'totally-wrong-secret' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects a revoked enrollment_secret row with 401', async () => {
    const revoked = 'revoked-secret-value-999'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, revoked_at) VALUES (${hashSessionToken(revoked)}, now())`
    await expect(enroll(validBody({ enrollment_secret: revoked }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects an expired (not_after in the past) enrollment_secret row with 401', async () => {
    const expired = 'expired-secret-value-888'
    await t.client`
      INSERT INTO enrollment_secret (secret_hash, not_after) VALUES (${hashSessionToken(expired)}, now() - interval '1 minute')`
    await expect(enroll(validBody({ enrollment_secret: expired }))).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ── emit-only credential ───────────────────────────────────────────────────────

describe('enroll — emit-only credential', () => {
  it('mints a credential carrying tokenscope.emit ONLY (never read/tag)', async () => {
    const out = await enroll(validBody({ claimed_email: 'emit-only@example.com', device_binding: 'dev-emit-only' }))
    const scopes = await emitScopesForInstance(out.instance_id)
    expect(scopes).toEqual(['tokenscope.emit'])
  })
})

// ── tool discriminator (P1-5 / gap #16) ─────────────────────────────────────────

describe('enroll — tool discriminator', () => {
  it('defaults to claude-code (no tool field) → claude bundle + attestation.tool=claude-code', async () => {
    const out = await enroll(validBody({ claimed_email: 'tool-default@example.com', device_binding: 'dev-tool-default' }))
    expect(out.tool).toBe('claude-code')
    expect(out.telemetry.claude).toBeDefined()
    expect(out.telemetry.copilot).toBeUndefined()
    // The claude bundle's resource attrs carry tool=claude-code, no copilot keys.
    const claude = out.telemetry.claude as Record<string, unknown>
    expect(claude.OTEL_RESOURCE_ATTRIBUTES).toContain(`tokenscope.instance_id=${out.instance_id}`)
    expect(claude.OTEL_RESOURCE_ATTRIBUTES).toContain('tool=claude-code')
    expect(claude.OTEL_LOGS_EXPORTER).toBe('otlp')

    const att = await t.client<{ tool: string }[]>`
      SELECT tool FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.tool).toBe('claude-code')
  })

  it('tool=copilot-cli → copilot bundle (telemetry.copilot, tool=copilot-cli) + attestation.tool=copilot-cli', async () => {
    const out = await enroll(
      validBody({ claimed_email: 'tool-copilot@example.com', device_binding: 'dev-tool-copilot', tool: 'copilot-cli' }),
    )
    expect(out.tool).toBe('copilot-cli')
    expect(out.telemetry.copilot).toBeDefined()
    expect(out.telemetry.claude).toBeUndefined()

    // The copilot bundle is the CopilotBundle shape — TOKENSCOPE_* endpoints + the
    // baked tool=copilot-cli resource attrs (no client-side rewrite needed).
    const copilot = out.telemetry.copilot as Record<string, unknown>
    expect(copilot.instance_id).toBe(out.instance_id)
    expect(copilot.TOKENSCOPE_BEARER_ENDPOINT).toBe(out.bearer_endpoint)
    expect(copilot.TOKENSCOPE_OAUTH_TOKEN_ENDPOINT).toBe(out.oauth_token_endpoint)
    expect(typeof copilot.TOKENSCOPE_LOGS_ENDPOINT).toBe('string')
    expect(copilot.OTEL_RESOURCE_ATTRIBUTES).toBe(`tokenscope.instance_id=${out.instance_id},tool=copilot-cli`)
    // No claude-only keys leaked into the copilot bundle.
    expect(copilot.OTEL_LOGS_EXPORTER).toBeUndefined()

    // The attestation row is stamped copilot-cli (so the instance's spend groups right).
    const att = await t.client<{ tool: string }[]>`
      SELECT tool FROM instance_attestation WHERE instance_id = ${out.instance_id}::uuid`
    expect(att[0]!.tool).toBe('copilot-cli')
  })

  it('rejects an unknown tool value (the enum is closed)', async () => {
    await expect(
      enroll(validBody({ claimed_email: 'tool-bad@example.com', device_binding: 'dev-tool-bad', tool: 'gemini-cli' })),
    ).rejects.toBeTruthy()
  })

  it('emit-only credential is identical regardless of tool (copilot enroll is still tokenscope.emit ONLY)', async () => {
    const out = await enroll(
      validBody({ claimed_email: 'copilot-emit@example.com', device_binding: 'dev-copilot-emit', tool: 'copilot-cli' }),
    )
    expect(await emitScopesForInstance(out.instance_id)).toEqual(['tokenscope.emit'])
  })
})

// ── idempotency ────────────────────────────────────────────────────────────────

describe('enroll — idempotent re-enroll', () => {
  it('a re-enroll from the same (claimed_email, device_binding) reuses the instance + teammate', async () => {
    const body = validBody({ claimed_email: 'idem@example.com', device_binding: 'dev-idem' })
    const first = await enroll(body)
    const second = await enroll(body)
    expect(second.instance_id).toBe(first.instance_id)

    const insts = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE claimed_email = 'idem@example.com'`
    expect(Number(insts[0]!.n)).toBe(1)
    const tms = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM teammate WHERE provisional AND email = 'idem@example.com'`
    expect(Number(tms[0]!.n)).toBe(1)

    // Rotation: still exactly one live emit credential for the device.
    const live = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM oauth_token
       WHERE instance_id = ${first.instance_id}::uuid AND scope = 'tokenscope.emit' AND revoked_at IS NULL`
    expect(Number(live[0]!.n)).toBe(1)
  })

  it('CONCURRENT enrolls for the same (email, device) dedup to ONE instance + teammate (FIX 4 TOCTOU)', async () => {
    const body = validBody({ claimed_email: 'race@example.com', device_binding: 'dev-race' })
    // Fire two enrolls at once. Without the advisory xact lock both SELECTs miss and
    // each mints a duplicate shadow teammate + instance; with it the second blocks,
    // then reuses the first's freshly-committed row.
    const [a, b] = await Promise.all([enroll(body), enroll(body)])
    expect(a.instance_id).toBe(b.instance_id)

    const insts = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE claimed_email = 'race@example.com'`
    expect(Number(insts[0]!.n)).toBe(1)
    const tms = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM teammate WHERE provisional AND email = 'race@example.com'`
    expect(Number(tms[0]!.n)).toBe(1)
  })

  it('a different device for the same email mints a SEPARATE instance + provisional teammate', async () => {
    await enroll(validBody({ claimed_email: 'multi@example.com', device_binding: 'dev-1' }))
    await enroll(validBody({ claimed_email: 'multi@example.com', device_binding: 'dev-2' }))
    const insts = await t.client<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM instance_attestation WHERE claimed_email = 'multi@example.com'`
    expect(Number(insts[0]!.n)).toBe(2)
  })
})

// ── constant-shape / no existence oracle ──────────────────────────────────────

describe('enroll — constant-shape (no existence oracle)', () => {
  it('a known real email and an unknown email return the identical response shape', async () => {
    const known = await enroll(validBody({ claimed_email: 'known@example.com', device_binding: 'dev-known' }))
    const unknown = await enroll(validBody({ claimed_email: 'nobody-here@example.com', device_binding: 'dev-unknown' }))

    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort())
    // No teammate field / canonicalised email leaks into the body.
    expect(JSON.stringify(known)).not.toContain('known@example.com')
    expect((known as Record<string, unknown>).reused).toBeUndefined()

    // The real teammate was NOT touched (enroll minted a provisional shadow instead).
    const real = await t.client<{ provisional: boolean }[]>`
      SELECT provisional FROM teammate WHERE email = 'known@example.com' AND NOT provisional`
    expect(real.length).toBe(1)
    const att = await t.client<{ identity_state: string }[]>`
      SELECT identity_state FROM instance_attestation WHERE instance_id = ${known.instance_id}::uuid`
    expect(att[0]!.identity_state).toBe('provisional')
  })
})

// ── caps ────────────────────────────────────────────────────────────────────

describe('enroll — provisional caps return 429', () => {
  it('the per-claimed_email cap returns 429 once exceeded (reuse never consumes quota)', async () => {
    process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL = '1'
    try {
      await enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-1' }))
      // A second DISTINCT device for the same email trips the cap.
      await expect(
        enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-2' })),
      ).rejects.toMatchObject({ statusCode: 429 })
      // But an idempotent re-enroll of the FIRST device still succeeds (no new row).
      const again = await enroll(validBody({ claimed_email: 'capped@example.com', device_binding: 'cap-dev-1' }))
      expect(again.instance_id).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      delete process.env.MAX_PROVISIONAL_INSTANCES_PER_EMAIL
    }
  })

  it('the global provisional cap returns 429 once exceeded', async () => {
    // Many provisional instances already exist from the cases above, so a cap of 1
    // is already exceeded. (A cap of '0' is deliberately treated as garbage and
    // falls back to the default — the guard rejects non-positive values.)
    process.env.MAX_PROVISIONAL_INSTANCES = '1'
    try {
      await expect(
        enroll(validBody({ claimed_email: `global-${randomUUID()}@example.com`, device_binding: 'global-dev' })),
      ).rejects.toMatchObject({ statusCode: 429 })
    } finally {
      delete process.env.MAX_PROVISIONAL_INSTANCES
    }
  })
})
