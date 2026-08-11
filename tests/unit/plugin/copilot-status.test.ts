// @vitest-environment node
/*
 * copilot status — unit tests for the pure interpreters in
 * copilot-plugin/scripts/status.mjs.
 *
 *   - interpretEmissionProbe: the emit-path verdict tree (mirrors the Claude
 *     status-probe contract; Copilot-flavoured wording).
 *   - interpretLanded: the /health verdict, fail-open to "unconfirmed".
 *   - parseNeedsTaggingCount: the my_usage unbound-signal parse (unknown vs 0 vs N).
 *   - interpretAttribution: landed-AND-attributed vs landed-but-unbound (P0-5).
 *   - composeStatus: the JSON shape — pins that mcp_authed is null (omitted for
 *     Copilot) with an explanatory note, AND the new attribution block.
 *
 * No helper spawn, no network — these are pure over their inputs.
 */
import { describe, it, expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { interpretEmissionProbe, interpretLanded, parseNeedsTaggingCount, interpretAttribution, interpretManagedTelemetry, composeStatus } =
  await import('../../../copilot-plugin/scripts/status.mjs')

describe('interpretEmissionProbe', () => {
  it('exit 0 + Authorization header → emitting', () => {
    const v = interpretEmissionProbe({ status: 0, stdoutHasAuth: true, sentinel: null })
    expect(v.emitting).toBe(true)
    expect(v.probe_status).toBe(200)
  })

  it('exit 0 but NO Authorization header → not emitting (unexpected, not a false-OK)', () => {
    const v = interpretEmissionProbe({ status: 0, stdoutHasAuth: false, sentinel: null })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBeNull()
    expect(v.message).toMatch(/tokenscope-setup/i)
  })

  it('non-zero + 401 sentinel → DROPPED, steer to re-provision (setup skill)', () => {
    const v = interpretEmissionProbe({
      status: 1,
      stdoutHasAuth: false,
      sentinel: { http_status: 401, message: 'Session expired' },
    })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(401)
    expect(v.message).toMatch(/DROPPED/)
    expect(v.message).toMatch(/tokenscope-setup/i)
    expect(v.message).toMatch(/Session expired/)
  })

  it('non-zero + 403 sentinel → auth failure', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: { http_status: 403, message: 'revoked' } })
    expect(v.probe_status).toBe(403)
    expect(v.message).toMatch(/tokenscope-setup/i)
  })

  it('non-zero + 404 sentinel (instance unknown) → re-provision', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: { http_status: 404, message: 'instance not found' } })
    expect(v.probe_status).toBe(404)
    expect(v.message).toMatch(/tokenscope-setup/i)
  })

  it('non-zero + network sentinel (http 0) → unverifiable, NOT a hard "dropped"/re-provision', () => {
    const v = interpretEmissionProbe({
      status: 1,
      stdoutHasAuth: false,
      sentinel: { http_status: 0, message: 'network error reaching bearer endpoint' },
    })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBe(0)
    expect(v.message).toMatch(/could not be verified|transient/i)
    expect(v.message).not.toMatch(/re-provision/i)
  })

  it('non-zero + NO sentinel → hard failure with no detail, steers to setup (not "transient")', () => {
    const v = interpretEmissionProbe({ status: 1, stdoutHasAuth: false, sentinel: null })
    expect(v.emitting).toBe(false)
    expect(v.probe_status).toBeNull()
    expect(v.message).toMatch(/no detail recorded/i)
    expect(v.message).toMatch(/tokenscope-setup/i)
    expect(v.message).not.toMatch(/transient/i)
  })
})

describe('interpretLanded', () => {
  it('ok + recent last_emission, not silent → landed', () => {
    const v = interpretLanded({ ok: true, lastEmission: '2026-06-22T08:14:03Z', silent: false, revoked: false })
    expect(v.landed).toBe(true)
    expect(v.state).toBe('landed')
    expect(v.last_emission).toBe('2026-06-22T08:14:03Z')
  })

  it('ok + null last_emission → silent (never landed yet), not red', () => {
    const v = interpretLanded({ ok: true, lastEmission: null, silent: true, revoked: false })
    expect(v.landed).toBe(false)
    expect(v.state).toBe('silent')
    expect(v.message).toMatch(/ingest lag|No record/i)
  })

  it('ok + last_emission but silent now → silent (stale), surfaces last landed', () => {
    const v = interpretLanded({ ok: true, lastEmission: '2026-06-19T00:00:00Z', silent: true, revoked: false })
    expect(v.state).toBe('silent')
    expect(v.message).toMatch(/2026-06-19/)
  })

  it('ok + revoked → revoked verdict, steer to setup', () => {
    const v = interpretLanded({ ok: true, lastEmission: '2026-06-19T00:00:00Z', silent: true, revoked: true })
    expect(v.landed).toBe(false)
    expect(v.state).toBe('revoked')
    expect(v.message).toMatch(/tokenscope-setup/i)
  })

  it('not-ok fetch-failed → unconfirmed (fail-open, never red)', () => {
    const v = interpretLanded({ ok: false, reason: 'fetch-failed' })
    expect(v.landed).toBe(false)
    expect(v.state).toBe('unconfirmed')
    expect(v.message).toMatch(/UNCONFIRMED/)
  })

  it('not-ok http-500 → unconfirmed', () => {
    const v = interpretLanded({ ok: false, reason: 'http-500' })
    expect(v.state).toBe('unconfirmed')
    expect(v.message).toMatch(/UNCONFIRMED/)
  })

  it('not-ok not-configured → unconfirmed, steer to setup', () => {
    const v = interpretLanded({ ok: false, reason: 'not-configured' })
    expect(v.state).toBe('unconfirmed')
    expect(v.message).toMatch(/tokenscope-setup/i)
  })

  it('null/garbage input → unconfirmed (defensive)', () => {
    expect(interpretLanded(null as never).state).toBe('unconfirmed')
    expect(interpretLanded(undefined as never).state).toBe('unconfirmed')
  })
})

describe('parseNeedsTaggingCount', () => {
  it('absent / blank → null (UNKNOWN, not zero)', () => {
    expect(parseNeedsTaggingCount(undefined)).toBeNull()
    expect(parseNeedsTaggingCount(null)).toBeNull()
    expect(parseNeedsTaggingCount('')).toBeNull()
    expect(parseNeedsTaggingCount('   ')).toBeNull()
  })

  it('"0" → 0 (a real, distinct "attributed" signal — NOT unknown)', () => {
    expect(parseNeedsTaggingCount('0')).toBe(0)
    expect(parseNeedsTaggingCount(' 0 ')).toBe(0)
  })

  it('positive integer string → the integer', () => {
    expect(parseNeedsTaggingCount('3')).toBe(3)
    expect(parseNeedsTaggingCount(' 12 ')).toBe(12)
  })

  it('non-numeric / negative / non-integer → null (defensive)', () => {
    expect(parseNeedsTaggingCount('abc')).toBeNull()
    expect(parseNeedsTaggingCount('-1')).toBeNull()
    expect(parseNeedsTaggingCount('1.5')).toBeNull()
    expect(parseNeedsTaggingCount('NaN')).toBeNull()
  })
})

describe('interpretAttribution', () => {
  const landedTrue = { landed: true, state: 'landed', last_emission: '2026-06-22T08:14:03Z', message: 'landed' }

  it('landed + needs_tagging_count > 0 → WARN unbound (the silent-failure branch), NOT healthy', () => {
    const v = interpretAttribution({ landed: landedTrue, needsTaggingCount: 3 })
    expect(v.attributed).toBe(false)
    expect(v.state).toBe('unbound')
    expect(v.needs_tagging_count).toBe(3)
    expect(v.message).toMatch(/UNBOUND/)
    expect(v.message).toMatch(/landing is not attribution/i)
    expect(v.message).toMatch(/tokenscope-project|tag_session/)
  })

  it('unbound message singularises for a count of 1', () => {
    const v = interpretAttribution({ landed: landedTrue, needsTaggingCount: 1 })
    expect(v.state).toBe('unbound')
    expect(v.message).toMatch(/1 session needs tagging/)
  })

  it('landed + needs_tagging_count === 0 → landed-AND-attributed (healthy)', () => {
    const v = interpretAttribution({ landed: landedTrue, needsTaggingCount: 0 })
    expect(v.attributed).toBe(true)
    expect(v.state).toBe('attributed')
    expect(v.needs_tagging_count).toBe(0)
    expect(v.message).toMatch(/landed AND attributed/i)
  })

  it('landed but no count passed (null) → unknown, NEVER asserts healthy on landed alone', () => {
    const v = interpretAttribution({ landed: landedTrue, needsTaggingCount: null })
    expect(v.attributed).toBeNull()
    expect(v.state).toBe('unknown')
    expect(v.needs_tagging_count).toBeNull()
    expect(v.message).toMatch(/UNKNOWN/)
    expect(v.message).toMatch(/my_usage/)
    expect(v.message).toMatch(/needs_tagging_count/)
  })

  it('not landed → attribution n/a (defers to the landed verdict), even if a count is present', () => {
    const notLanded = { landed: false, state: 'silent', last_emission: null, message: 'silent' }
    const v = interpretAttribution({ landed: notLanded, needsTaggingCount: 5 })
    expect(v.attributed).toBeNull()
    expect(v.state).toBe('n/a')
  })

  it('missing landed verdict → n/a (defensive)', () => {
    expect(interpretAttribution({ landed: undefined, needsTaggingCount: 0 }).state).toBe('n/a')
    expect(interpretAttribution({ landed: null, needsTaggingCount: 0 }).state).toBe('n/a')
  })
})

describe('composeStatus', () => {
  const probe = { emitting: true, probe_status: 200, message: 'ok' }
  const landed = { landed: true, state: 'landed', last_emission: '2026-06-22T08:14:03Z', message: 'landed' }

  it('mirrors the inputs into the documented JSON shape', () => {
    const out = composeStatus({ probe, landed, sentinel: null })
    expect(out.tool).toBe('copilot-cli')
    expect(out.emitting).toBe(true)
    expect(out.probe).toEqual({ status: 200, message: 'ok' })
    expect(out.landed).toBe(true)
    expect(out.landed_check).toEqual({ state: 'landed', last_emission: '2026-06-22T08:14:03Z', message: 'landed' })
    expect(out.last_failure).toBeNull()
  })

  it('mcp_authed is null (OMITTED for Copilot) with an explanatory note', () => {
    const out = composeStatus({ probe, landed, sentinel: null })
    expect(out.mcp_authed).toBeNull()
    expect(out.mcp_authed_note).toMatch(/not script-readable for Copilot/i)
    expect(out.mcp_authed_note).toMatch(/my_usage/)
  })

  it('passes a failure sentinel through to last_failure', () => {
    const sentinel = { http_status: 401, message: 'Session expired' }
    const out = composeStatus({ probe: { emitting: false, probe_status: 401, message: 'fail' }, landed, sentinel })
    expect(out.last_failure).toEqual(sentinel)
    expect(out.emitting).toBe(false)
  })

  it('carries the attribution block through verbatim', () => {
    const attribution = interpretAttribution({ landed, needsTaggingCount: 3 })
    const out = composeStatus({ probe, landed, attribution, sentinel: null })
    expect(out.attributed).toBe(false)
    expect(out.attribution.state).toBe('unbound')
    expect(out.attribution.needs_tagging_count).toBe(3)
    expect(out.attribution.message).toMatch(/UNBOUND/)
  })

  it('landed + attributed (count 0) → attributed:true in the composed shape', () => {
    const attribution = interpretAttribution({ landed, needsTaggingCount: 0 })
    const out = composeStatus({ probe, landed, attribution, sentinel: null })
    expect(out.attributed).toBe(true)
    expect(out.attribution.state).toBe('attributed')
  })

  it('omitting attribution defaults to UNKNOWN — landed alone NEVER composes to attributed:true', () => {
    const out = composeStatus({ probe, landed, sentinel: null })
    expect(out.landed).toBe(true)
    expect(out.attributed).toBeNull()
    expect(out.attribution.state).toBe('unknown')
    expect(out.attribution.message).toMatch(/my_usage/)
  })
})

describe('interpretManagedTelemetry (Workstream D §10.1)', () => {
  it('hostile classification → hostile:true, names the source, never echoes a raw value', () => {
    const v = interpretManagedTelemetry({ classification: 'hostile', source: 'file-based', checkedPaths: ['/etc/x'], serverManagedNote: 'note' })
    expect(v.hostile).toBe(true)
    expect(v.state).toBe('hostile')
    expect(v.message).toMatch(/POLICY block, not a credential problem/)
  })

  it('benign classification → hostile:false', () => {
    const v = interpretManagedTelemetry({ classification: 'benign', source: 'native-mdm', checkedPaths: [], serverManagedNote: 'note' })
    expect(v.hostile).toBe(false)
    expect(v.state).toBe('benign')
  })

  it('none classification → hostile:false, authoritative "no setting found"', () => {
    const v = interpretManagedTelemetry({ classification: 'none', source: 'none', checkedPaths: ['/etc/x'], serverManagedNote: 'note' })
    expect(v.hostile).toBe(false)
    expect(v.state).toBe('none')
  })

  it('unknown classification → hostile:null (never true, never false — an honest "cannot confirm")', () => {
    const v = interpretManagedTelemetry({ classification: 'unknown', source: 'unknown', checkedPaths: [], serverManagedNote: 'server-managed cannot be read here' })
    expect(v.hostile).toBeNull()
    expect(v.state).toBe('unknown')
    expect(v.message).toMatch(/server-managed cannot be read here/)
  })
})

describe('composeStatus — emission_healthy (credential-valid is NEVER emission-healthy when hostile)', () => {
  const landed = { landed: true, state: 'landed', last_emission: '2026-06-22T08:14:03Z', message: 'landed' }

  it('credential valid + no managed telemetry → emission_healthy true', () => {
    const managedTelemetry = interpretManagedTelemetry({ classification: 'none', source: 'none', checkedPaths: [], serverManagedNote: '' })
    const out = composeStatus({ probe: { emitting: true, probe_status: 200, message: 'ok' }, landed, sentinel: null, managedTelemetry })
    expect(out.emitting).toBe(true)
    expect(out.emission_healthy).toBe(true)
  })

  it('credential valid + HOSTILE managed telemetry → emission_healthy FALSE despite emitting:true (the core contract)', () => {
    const managedTelemetry = interpretManagedTelemetry({ classification: 'hostile', source: 'file-based', checkedPaths: ['/etc/x'], serverManagedNote: '' })
    const out = composeStatus({ probe: { emitting: true, probe_status: 200, message: 'ok' }, landed, sentinel: null, managedTelemetry })
    expect(out.emitting).toBe(true) // the credential probe itself is unaffected
    expect(out.emission_healthy).toBe(false) // but emission_healthy is NOT fooled
    expect(out.managed_telemetry.state).toBe('hostile')
  })

  it('credential invalid → emission_healthy false regardless of managed telemetry', () => {
    const managedTelemetry = interpretManagedTelemetry({ classification: 'none', source: 'none', checkedPaths: [], serverManagedNote: '' })
    const out = composeStatus({ probe: { emitting: false, probe_status: 401, message: 'fail' }, landed, sentinel: null, managedTelemetry })
    expect(out.emission_healthy).toBe(false)
  })

  it('managed telemetry UNKNOWN → emission_healthy still reflects the credential (unknown is not treated as hostile)', () => {
    const managedTelemetry = interpretManagedTelemetry({ classification: 'unknown', source: 'unknown', checkedPaths: [], serverManagedNote: '' })
    const out = composeStatus({ probe: { emitting: true, probe_status: 200, message: 'ok' }, landed, sentinel: null, managedTelemetry })
    expect(out.emission_healthy).toBe(true)
    expect(out.managed_telemetry.state).toBe('unknown')
  })

  it('omitting managedTelemetry entirely defaults to unknown — never silently "none"', () => {
    const out = composeStatus({ probe: { emitting: true, probe_status: 200, message: 'ok' }, landed, sentinel: null })
    expect(out.managed_telemetry.state).toBe('unknown')
    expect(out.emission_healthy).toBe(true) // unknown ≠ hostile, so the credential signal still stands
  })
})
