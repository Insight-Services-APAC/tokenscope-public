/*
 * /tokenscope:backfill — transcript-parsing + windowing + cap + dry-run unit
 * tests (ADR-0005 slice 3). Pure: no network, no live OTLP endpoint (per the
 * task, we do NOT attempt a live-emit integration test).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseArgs,
  resolveBound,
  resolveWindow,
  recordFromTranscriptLine,
  collectRecords,
  listTranscriptFiles,
  parseResourceAttrs,
  buildOtlpLogsPayload,
  cwdProjectSlug,
  run,
} from '../../../plugin/scripts/backfill.mjs'
import { safeProcessEnv, REPO_UNTRUSTED_ENV_KEYS } from '../../../plugin/scripts/plugin-runtime.mjs'

const NOW = new Date('2026-05-15T12:00:00Z')

function assistantLine(
  tsIso: string,
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: tsIso,
    requestId: 'req_test',
    sessionId: 'sess-abc',
    message: { model: 'claude-opus-4-8', id: 'msg_x', usage },
    ...extra,
  })
}

describe('parseArgs', () => {
  it('parses flags with defaults', () => {
    const o = parseArgs(['--since', '12h', '--max-records', '10', '--dry-run'])
    expect(o.since).toBe('12h')
    expect(o.maxRecords).toBe(10)
    expect(o.dryRun).toBe(true)
    expect(o.maxWindowHours).toBe(48)
  })
  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/)
  })
  it('--all-projects defaults off, opts in to host-wide sweep', () => {
    expect(parseArgs([]).allProjects).toBe(false)
    expect(parseArgs(['--all-projects']).allProjects).toBe(true)
  })
})

describe('cwdProjectSlug — scope guard (this project, not the whole host)', () => {
  it("folds the cwd to Claude Code's transcript-dir slug", () => {
    expect(cwdProjectSlug('/workspace')).toBe('-workspace')
    expect(cwdProjectSlug('/home/velluv/projects/claude-vault')).toBe(
      '-home-velluv-projects-claude-vault',
    )
    // folds ALL non-alphanumerics (underscore, space, @), matching Claude Code.
    expect(cwdProjectSlug('/home/a_b/my project@x')).toBe('-home-a-b-my-project-x')
  })
})

describe('run — default scope is this project only (multi-CW host guard)', () => {
  it('errors rather than silently sweeping the host-wide root when the cwd dir is absent', async () => {
    // No --projects-dir, no --all-projects, and a cwd whose derived slug dir
    // does not exist → must throw with guidance, NOT fall back to ~/.claude/projects.
    await expect(
      run({ maxRecords: 10, maxWindowHours: 48, dryRun: true, cwd: '/no/such/cwd/xyz' }, {}, NOW),
    ).rejects.toThrow(/No transcript dir for the current project/)
  })
})

describe('resolveBound / resolveWindow', () => {
  it('treats "Nh" and bare "N" as hours-ago', () => {
    expect(resolveBound('6h', null, NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 6 * 3600_000).toISOString(),
    )
    expect(resolveBound('6', null, NOW).toISOString()).toBe(
      new Date(NOW.getTime() - 6 * 3600_000).toISOString(),
    )
  })
  it('parses ISO bounds', () => {
    expect(resolveBound('2026-05-15T00:00:00Z', null, NOW).toISOString()).toBe(
      '2026-05-15T00:00:00.000Z',
    )
  })
  it('defaults to 24h window', () => {
    const { since, until } = resolveWindow({ maxWindowHours: 48 }, NOW)
    expect(until.toISOString()).toBe(NOW.toISOString())
    expect(since.toISOString()).toBe(new Date(NOW.getTime() - 24 * 3600_000).toISOString())
  })
  it('clamps a window wider than the max-window cap', () => {
    const { since, until, windowClamped } = resolveWindow(
      { since: '2026-01-01T00:00:00Z', until: NOW.toISOString(), maxWindowHours: 48 },
      NOW,
    )
    expect(windowClamped).toBe(true)
    expect(until.getTime() - since.getTime()).toBe(48 * 3600_000)
  })
  it('rejects since-after-until', () => {
    expect(() =>
      resolveWindow(
        { since: NOW.toISOString(), until: '2026-05-14T00:00:00Z', maxWindowHours: 48 },
        NOW,
      ),
    ).toThrow(/after/)
  })
})

describe('recordFromTranscriptLine', () => {
  it('maps usage to OTLP token attrs, renaming cache_*_input_tokens', () => {
    const rec = recordFromTranscriptLine(
      assistantLine('2026-05-15T11:00:00Z', {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      }),
    )
    expect(rec).not.toBeNull()
    expect(rec!.tokens).toEqual({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_creation_tokens: 40,
    })
    expect(rec!.model).toBe('claude-opus-4-8')
    expect(rec!.claudeSessionId).toBe('sess-abc')
    expect(rec!.requestId).toBe('req_test')
  })
  it('ignores non-assistant lines and lines without usage', () => {
    expect(
      recordFromTranscriptLine(JSON.stringify({ type: 'user', timestamp: '2026-05-15T11:00:00Z' })),
    ).toBeNull()
    expect(recordFromTranscriptLine(assistantLine('2026-05-15T11:00:00Z', {}))).toBeNull()
    expect(recordFromTranscriptLine('not json')).toBeNull()
  })
  it('ignores all-zero usage', () => {
    expect(
      recordFromTranscriptLine(
        assistantLine('2026-05-15T11:00:00Z', { input_tokens: 0, output_tokens: 0 }),
      ),
    ).toBeNull()
  })
})

describe('collectRecords — window selection + cap', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ts-backfill-'))
    const projDir = join(root, 'cw-Some-Project')
    mkdirSync(projDir, { recursive: true })
    const lines = [
      assistantLine('2026-05-14T06:00:00Z', { output_tokens: 5 }), // 30h before NOW — outside default 24h
      assistantLine('2026-05-15T00:00:00Z', { output_tokens: 5 }), // 12h before — inside
      assistantLine('2026-05-15T06:00:00Z', { output_tokens: 5 }), // 6h before — inside
      assistantLine('2026-05-15T11:30:00Z', { output_tokens: 5 }), // 30m before — inside
      assistantLine('2026-05-15T13:00:00Z', { output_tokens: 5 }), // 1h AFTER NOW — outside (until)
    ]
    writeFileSync(join(projDir, 'sess-1.jsonl'), lines.join('\n') + '\n')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('selects only in-window records, sorted ascending', () => {
    const files = listTranscriptFiles(root)
    expect(files.length).toBe(1)
    const since = new Date(NOW.getTime() - 24 * 3600_000)
    const { selected, found, capped } = collectRecords(files, since, NOW, 5000)
    expect(found).toBe(3) // the three inside the 24h window, before NOW
    expect(capped).toBe(0)
    const ts = selected.map((r) => r.ts)
    expect(ts).toEqual([...ts].sort())
  })

  it('respects the record cap and reports the overflow', () => {
    const files = listTranscriptFiles(root)
    const since = new Date(NOW.getTime() - 24 * 3600_000)
    const { selected, found, capped } = collectRecords(files, since, NOW, 2)
    expect(found).toBe(3)
    expect(selected.length).toBe(2)
    expect(capped).toBe(1)
  })
})

describe('listTranscriptFiles — unreadable project dir is skipped, not fatal (PLG-8)', () => {
  it('skips a permission-denied subdir and still returns the readable files', () => {
    // As root every dir is readable regardless of mode — the guard can't be
    // exercised; skip rather than pass vacuously.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    const root = mkdtempSync(join(tmpdir(), 'ts-backfill-denied-'))
    try {
      const okDir = join(root, 'cw-readable')
      const deniedDir = join(root, 'cw-denied')
      mkdirSync(okDir, { recursive: true })
      mkdirSync(deniedDir, { recursive: true })
      writeFileSync(
        join(okDir, 'sess-ok.jsonl'),
        assistantLine('2026-05-15T11:00:00Z', { output_tokens: 5 }) + '\n',
      )
      writeFileSync(
        join(deniedDir, 'sess-hidden.jsonl'),
        assistantLine('2026-05-15T11:00:00Z', { output_tokens: 5 }) + '\n',
      )
      chmodSync(deniedDir, 0o000)

      let files: string[]
      try {
        files = listTranscriptFiles(root) // must NOT throw (was: one EACCES aborted --all-projects entirely)
      } finally {
        chmodSync(deniedDir, 0o755) // restore so afterEach rm succeeds
      }
      expect(files).toEqual([join(okDir, 'sess-ok.jsonl')])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('parseResourceAttrs / buildOtlpLogsPayload', () => {
  it('parses k=v resource attrs', () => {
    const attrs = parseResourceAttrs(
      'tokenscope.instance_id=inst-1,project.code_hash=h1,tool=claude-code',
    )
    expect(attrs['tokenscope.instance_id']).toBe('inst-1')
    expect(attrs['project.code_hash']).toBe('h1')
  })
  it('stamps tokenscope.backfill=true and mirrors the api_request event shape', () => {
    const rec = recordFromTranscriptLine(
      assistantLine('2026-05-15T11:00:00Z', {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    )!
    const payload = buildOtlpLogsPayload([rec], {
      'tokenscope.instance_id': 'inst-1',
      tool: 'claude-code',
    })
    const resourceAttrs = payload.resourceLogs[0].resource.attributes
    const backfillAttr = resourceAttrs.find((a: { key: string }) => a.key === 'tokenscope.backfill')
    expect(backfillAttr.value.stringValue).toBe('true')
    const logRecord = payload.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(logRecord.body.stringValue).toBe('api_request')
    const attrKeys = logRecord.attributes.map((a: { key: string }) => a.key)
    expect(attrKeys).toContain('event.name')
    expect(attrKeys).toContain('input_tokens')
    expect(attrKeys).toContain('cache_read_tokens')
    expect(attrKeys).toContain('cache_creation_tokens')
    // original timestamp preserved as unix-nanos
    expect(logRecord.timeUnixNano).toBe(
      String(BigInt(new Date('2026-05-15T11:00:00Z').getTime()) * 1000000n),
    )
  })
})

describe('run — dry-run emits nothing', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ts-backfill-run-'))
    const projDir = join(root, 'proj')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(
      join(projDir, 's.jsonl'),
      assistantLine('2026-05-15T11:00:00Z', { output_tokens: 100 }) + '\n',
    )
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('reports records but never calls fetch in --dry-run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const summary = await run(
      {
        dryRun: true,
        projectsDir: root,
        maxRecords: 5000,
        maxWindowHours: 48,
        since: null,
        until: null,
      },
      {
        OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://example/ingest',
      },
      NOW,
    )
    expect(summary.dry_run).toBe(true)
    expect(summary.records_selected).toBe(1)
    expect(summary.records_emitted).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('clamps max-records above the hard ceiling', async () => {
    const summary = await run(
      {
        dryRun: true,
        projectsDir: root,
        maxRecords: 999999,
        maxWindowHours: 48,
        since: null,
        until: null,
      },
      { OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code' },
      NOW,
    )
    expect(summary.max_records).toBe(50000)
    expect(summary.max_records_clamped).toBe(true)
  })
})

describe('run — S1 fix 3: the ingest endpoint is validated BEFORE any network call', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ts-backfill-endpoint-'))
    const projDir = join(root, 'proj')
    mkdirSync(projDir, { recursive: true })
    writeFileSync(
      join(projDir, 's.jsonl'),
      assistantLine('2026-05-15T11:00:00Z', { output_tokens: 100 }) + '\n',
    )
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('a plaintext off-box endpoint is rejected before mintBearer / fetch ever run (no fetch issued)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(
      run(
        {
          projectsDir: root,
          maxRecords: 5000,
          maxWindowHours: 48,
          since: null,
          until: null,
          dryRun: false,
        },
        {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://evil.example/v1/logs',
        },
        NOW,
      ),
      // Classification, not the rejected value: this throw is caught by the
      // CLI's top-level handler, which prints err.message into the JSON summary
      // on stdout. The endpoint comes from OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, so
      // it is not necessarily something the reader supplied, and echoing it is
      // the CodeQL js/clear-text-logging class.
    ).rejects.toThrow(/insecure-scheme/)
    await expect(
      run(
        {
          projectsDir: root,
          maxRecords: 5000,
          maxWindowHours: 48,
          since: null,
          until: null,
          dryRun: false,
        },
        {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://evil.example/v1/logs',
        },
        NOW,
      ),
    ).rejects.toThrow(
      // Explicit capture rather than `.rejects.not.toThrow(...)`, which can pass
      // for the wrong reason (no rejection at all still satisfies "did not
      // throw THIS"). This asserts a rejection happened AND that its full
      // inspected form is free of the endpoint.
      expect.objectContaining({
        message: expect.not.stringContaining('evil.example') as unknown as string,
      }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("a value starting with '-' is rejected (would be read as a curl/exec flag downstream)", async () => {
    await expect(
      run(
        {
          projectsDir: root,
          maxRecords: 5000,
          maxWindowHours: 48,
          since: null,
          until: null,
          dryRun: false,
        },
        {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '-K/tmp/x',
        },
        NOW,
      ),
    ).rejects.toThrow(/-/)
  })

  it('a loopback http endpoint (the CC #72671 local forwarder) PASSES validation — fails at the next gate instead', async () => {
    // Can't drive a full emit in a unit test (no real helper/network); what
    // matters here is that it does NOT fail at the endpoint-validation step.
    // It fails at the NEXT gate (missing otel-headers-helper.sh), proving
    // loopback cleared assertSafeEndpoint.
    await expect(
      run(
        {
          projectsDir: root,
          maxRecords: 5000,
          maxWindowHours: 48,
          since: null,
          until: null,
          dryRun: false,
        },
        {
          OTEL_RESOURCE_ATTRIBUTES: 'tokenscope.instance_id=inst-1,tool=claude-code',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:14318/v1/logs',
          CLAUDE_PLUGIN_ROOT: join(root, 'no-such-plugin-root'),
        },
        NOW,
      ),
    ).rejects.toThrow(/otel-headers-helper\.sh not found/)
  })
})

describe('safeProcessEnv — S1 fix 2: the hostile-repo fixture, mirrored from session-start-warn.test.ts', () => {
  // backfill.mjs's CLI entry now calls safeProcessEnv() instead of passing raw
  // process.env to run() — Claude Code has already applied a TAGGED repo's
  // settings.local.json onto process.env by REPLACEMENT before spawning this
  // script (ADR-0006 §2), so process.env may be entirely repo-controlled.
  //
  // NOTE: globalSettingsEnv() reads the REAL ~/.claude/settings.json (no test
  // seam) — this container carries a live device enrolment, so these
  // assertions deliberately do not depend on its exact content; see the
  // identical note in status-probe.test.ts.
  const hostileProcessEnv = {
    PATH: '/usr/bin',
    OTEL_RESOURCE_ATTRIBUTES:
      'tokenscope.instance_id=real-device-sid,project.code_hash=abc123,tool=claude-code',
    TOKENSCOPE_OAUTH_TOKEN_ENDPOINT: 'https://attacker.example.com/oauth/token',
    TOKENSCOPE_BEARER_ENDPOINT: 'https://attacker.example.com/bearer',
    TOKENSCOPE_API_BASE: 'https://attacker.example.com',
    TOKENSCOPE_STATE_DIR: '/home/dev/hostile-repo/.tokenscope-exfil',
    TOKENSCOPE_OAUTH_REFRESH_TOKEN: 'attacker-supplied-value-should-never-win',
  }

  it('NO repo-supplied value for ANY untrusted key survives, enrolled or not', () => {
    const safe = safeProcessEnv(hostileProcessEnv)
    // The machine-independent invariant: for every key a repo must not be able
    // to contribute, whatever comes out is either absent (no global source) or
    // the device's OWN global value — never the one the repo supplied. Driving
    // this off the exported key list means a key added to the list without a
    // strip is caught here, rather than by the next CI runner that happens to
    // lack a global settings file.
    for (const k of REPO_UNTRUSTED_ENV_KEYS) {
      if (hostileProcessEnv[k] === undefined) continue
      expect(safe[k], `repo-supplied ${k} survived safeProcessEnv`).not.toBe(hostileProcessEnv[k])
    }
    expect(safe.PATH).toBe('/usr/bin') // ordinary keys untouched
  })

  it('TOKENSCOPE_API_BASE and TOKENSCOPE_STATE_DIR are ALWAYS absent', () => {
    const safe = safeProcessEnv(hostileProcessEnv)
    expect(safe.TOKENSCOPE_API_BASE).toBeUndefined()
    expect(safe.TOKENSCOPE_STATE_DIR).toBeUndefined()
  })

  it('an ordinary, non-credential key survives the spread untouched', () => {
    const safe = safeProcessEnv(hostileProcessEnv)
    expect(safe.PATH).toBe('/usr/bin')
  })
})
