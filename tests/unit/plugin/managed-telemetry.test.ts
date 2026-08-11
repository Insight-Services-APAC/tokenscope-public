/*
 * managed-telemetry.mjs — GitHub Copilot CLI enterprise-managed `telemetry`
 * detector (Workstream D §10.1). Dependency-free by design (Node builtins only,
 * no plugin/scripts/* imports) so it survives being vendored into the standalone
 * copilot-plugin distribution — see the module header.
 *
 * Covers: hostile (enabled:false, endpoint, headers) / benign (only compatible
 * fields) / none (authoritatively checked known paths, cleanly absent) / unknown
 * (unreadable/invalid-json/unsupported-to-parse); the well-known per-OS file path;
 * the Windows registry text parser; secrets (header/endpoint values) never appear
 * in any returned result.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyTelemetryBlock,
  describeTelemetryBlock,
  wellKnownFileBasedPath,
  readManagedSettingsFile,
  parseWindowsRegistryOutput,
  telemetryFromFlatKeys,
  detectManagedTelemetry,
} from '../../../plugin/scripts/managed-telemetry.mjs'

describe('classifyTelemetryBlock', () => {
  it('none: undefined / null / non-object / empty object', () => {
    expect(classifyTelemetryBlock(undefined)).toBe('none')
    expect(classifyTelemetryBlock(null)).toBe('none')
    expect(classifyTelemetryBlock('a string')).toBe('none')
    expect(classifyTelemetryBlock([1, 2, 3])).toBe('none')
    expect(classifyTelemetryBlock({})).toBe('none')
  })

  it('hostile: enabled explicitly false', () => {
    expect(classifyTelemetryBlock({ enabled: false })).toBe('hostile')
  })

  it('hostile: endpoint set (forces exporterType away from file, discards filePath)', () => {
    expect(classifyTelemetryBlock({ endpoint: 'https://otel-collector.example.com' })).toBe('hostile')
  })

  it('hostile: headers set (same exporterType-forcing branch as endpoint)', () => {
    expect(classifyTelemetryBlock({ headers: { Authorization: 'Bearer secret' } })).toBe('hostile')
  })

  it('hostile: endpoint set even when enabled is also explicitly true', () => {
    expect(classifyTelemetryBlock({ enabled: true, endpoint: 'https://x' })).toBe('hostile')
  })

  it('benign: resourceAttributes only', () => {
    expect(classifyTelemetryBlock({ resourceAttributes: { 'deployment.environment': 'prod' } })).toBe('benign')
  })

  it('benign: serviceName only', () => {
    expect(classifyTelemetryBlock({ serviceName: 'copilot' })).toBe('benign')
  })

  it('benign: captureContent / lockCaptureContent / protocol / enabled:true — none force the file exporter away', () => {
    expect(classifyTelemetryBlock({ captureContent: false })).toBe('benign')
    expect(classifyTelemetryBlock({ lockCaptureContent: true })).toBe('benign')
    expect(classifyTelemetryBlock({ protocol: 'http/json' })).toBe('benign')
    expect(classifyTelemetryBlock({ enabled: true })).toBe('benign')
  })

  it('benign: multiple compatible fields together', () => {
    expect(classifyTelemetryBlock({ resourceAttributes: { a: 1 }, serviceName: 'copilot', captureContent: true })).toBe(
      'benign',
    )
  })
})

describe('describeTelemetryBlock — VALUE-FREE booleans only', () => {
  it('never includes the actual endpoint/header values in its output', () => {
    const desc = describeTelemetryBlock({
      endpoint: 'https://otel-collector.example.com',
      headers: { Authorization: 'Bearer super-secret-token' },
    })
    const dump = JSON.stringify(desc)
    expect(dump).not.toContain('otel-collector.example.com')
    expect(dump).not.toContain('super-secret-token')
    expect(desc.endpointSet).toBe(true)
    expect(desc.headersSet).toBe(true)
  })

  it('reports every key as unset for an empty/absent block', () => {
    const desc = describeTelemetryBlock(undefined)
    expect(Object.values(desc).every((v) => v === false)).toBe(true)
  })
})

describe('wellKnownFileBasedPath — GitHub-documented per-OS well-known paths', () => {
  it('macOS', () => {
    expect(wellKnownFileBasedPath('darwin')).toBe('/Library/Application Support/GitHubCopilot/managed-settings.json')
  })
  it('Windows (default ProgramFiles)', () => {
    const orig = process.env.ProgramFiles
    delete process.env.ProgramFiles
    try {
      expect(wellKnownFileBasedPath('win32')).toBe('C:\\Program Files\\GitHubCopilot\\managed-settings.json')
    } finally {
      if (orig !== undefined) process.env.ProgramFiles = orig
    }
  })
  it('Windows honours a non-default ProgramFiles env', () => {
    const orig = process.env.ProgramFiles
    process.env.ProgramFiles = 'D:\\Program Files'
    try {
      expect(wellKnownFileBasedPath('win32')).toBe('D:\\Program Files\\GitHubCopilot\\managed-settings.json')
    } finally {
      if (orig !== undefined) process.env.ProgramFiles = orig
      else delete process.env.ProgramFiles
    }
  })
  it('Linux + any other POSIX platform', () => {
    expect(wellKnownFileBasedPath('linux')).toBe('/etc/github-copilot/managed-settings.json')
    expect(wellKnownFileBasedPath('freebsd')).toBe('/etc/github-copilot/managed-settings.json')
  })
})

describe('readManagedSettingsFile', () => {
  it('absent file (ENOENT) → present:false, a clean "not configured"', () => {
    expect(readManagedSettingsFile('/no/such/path.json', { exists: () => false })).toEqual({ present: false })
  })

  it('present + unreadable (permission denied) → error: unreadable', () => {
    const result = readManagedSettingsFile('/x.json', {
      exists: () => true,
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    expect(result).toEqual({ present: true, error: 'unreadable' })
  })

  it('present + invalid JSON → error: invalid-json', () => {
    const result = readManagedSettingsFile('/x.json', { exists: () => true, readFile: () => '{not valid json' })
    expect(result).toEqual({ present: true, error: 'invalid-json' })
  })

  it('present + a JSON array (not an object) → error: invalid-json', () => {
    const result = readManagedSettingsFile('/x.json', { exists: () => true, readFile: () => '[1,2,3]' })
    expect(result).toEqual({ present: true, error: 'invalid-json' })
  })

  it('present + valid JSON with no telemetry key → telemetry undefined (not an error)', () => {
    const result = readManagedSettingsFile('/x.json', {
      exists: () => true,
      readFile: () => JSON.stringify({ permissions: { model: 'auto' } }),
    })
    expect(result).toEqual({ present: true, telemetry: undefined })
  })

  it('present + valid JSON with a telemetry block → returned verbatim', () => {
    const result = readManagedSettingsFile('/x.json', {
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { enabled: false } }),
    })
    expect(result).toEqual({ present: true, telemetry: { enabled: false } })
  })
})

describe('parseWindowsRegistryOutput + telemetryFromFlatKeys', () => {
  it('parses a realistic `reg query /s` dump into a flat key->value map', () => {
    const sample = [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\GitHubCopilot',
      '    telemetry.enabled    REG_SZ    false',
      '    telemetry.endpoint    REG_SZ    https://otel-collector.example.com',
      '    permissions.model    REG_SZ    auto',
      '',
    ].join('\r\n')
    const flat = parseWindowsRegistryOutput(sample)
    expect(flat).toEqual({
      'telemetry.enabled': 'false',
      'telemetry.endpoint': 'https://otel-collector.example.com',
      'permissions.model': 'auto',
    })
  })

  it('telemetryFromFlatKeys builds a nested telemetry object, coercing true/false strings', () => {
    const nested = telemetryFromFlatKeys({ 'telemetry.enabled': 'false', 'telemetry.endpoint': 'https://x', 'permissions.model': 'auto' })
    expect(nested).toEqual({ enabled: false, endpoint: 'https://x' })
  })

  it('telemetryFromFlatKeys returns undefined when no telemetry.* key is present', () => {
    expect(telemetryFromFlatKeys({ 'permissions.model': 'auto' })).toBeUndefined()
  })
})

describe('detectManagedTelemetry — end-to-end, injected dependencies (no real FS/exec)', () => {
  it('none: file absent, Linux (no native-MDM channel at all)', async () => {
    const result = await detectManagedTelemetry({ platform: 'linux', exists: () => false })
    expect(result.classification).toBe('none')
    expect(result.source).toBe('none')
    expect(result.serverManagedNote).toMatch(/server-managed/i)
  })

  it('hostile: file-based, endpoint set — never leaks the endpoint value', async () => {
    const result = await detectManagedTelemetry({
      platform: 'linux',
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { endpoint: 'https://otel-collector.example.com', headers: { Authorization: 'Bearer top-secret' } } }),
    })
    expect(result.classification).toBe('hostile')
    expect(result.source).toBe('file-based')
    const dump = JSON.stringify(result)
    expect(dump).not.toContain('otel-collector.example.com')
    expect(dump).not.toContain('top-secret')
  })

  it('benign: file-based, only compatible fields', async () => {
    const result = await detectManagedTelemetry({
      platform: 'linux',
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { resourceAttributes: { 'deployment.environment': 'prod' } } }),
    })
    expect(result.classification).toBe('benign')
  })

  it('unknown: file present but invalid JSON', async () => {
    const result = await detectManagedTelemetry({ platform: 'linux', exists: () => true, readFile: () => '{bad json' })
    expect(result.classification).toBe('unknown')
  })

  it('unknown: file present but unreadable (permission denied)', async () => {
    const result = await detectManagedTelemetry({
      platform: 'linux',
      exists: () => true,
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    expect(result.classification).toBe('unknown')
  })

  it('Windows native-MDM takes precedence over file-based when both are present', async () => {
    const result = await detectManagedTelemetry({
      platform: 'win32',
      exec: () => '    telemetry.enabled    REG_SZ    false',
      // File-based would classify 'benign' if reached — proves native-MDM wins.
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { resourceAttributes: { a: '1' } } }),
    })
    expect(result.classification).toBe('hostile')
    expect(result.source).toBe('native-mdm')
  })

  it('Windows native-MDM cleanly absent (reg query exits 1) falls through to file-based', async () => {
    const result = await detectManagedTelemetry({
      platform: 'win32',
      exec: () => {
        throw Object.assign(new Error('not found'), { status: 1 })
      },
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { enabled: false } }),
    })
    expect(result.classification).toBe('hostile')
    expect(result.source).toBe('file-based')
  })

  it('Windows native-MDM genuinely unknown (reg.exe itself failed) is reported unknown, never guessed', async () => {
    const result = await detectManagedTelemetry({
      platform: 'win32',
      exec: () => {
        throw Object.assign(new Error('command not found'), { status: 127 })
      },
    })
    expect(result.classification).toBe('unknown')
  })

  it('macOS native-MDM domain does not exist — falls through to file-based', async () => {
    const result = await detectManagedTelemetry({
      platform: 'darwin',
      exec: () => {
        throw new Error("The domain/default pair of (com.github.copilot, ...) does not exist")
      },
      exists: () => true,
      readFile: () => JSON.stringify({ telemetry: { endpoint: 'https://x' } }),
    })
    expect(result.classification).toBe('hostile')
    expect(result.source).toBe('file-based')
  })

  it('macOS native-MDM domain EXISTS but we cannot safely parse the plist text — unknown, never guessed', async () => {
    const result = await detectManagedTelemetry({
      platform: 'darwin',
      exec: () => '{\n    telemetry = {\n        enabled = 0;\n    };\n}',
    })
    expect(result.classification).toBe('unknown')
  })
})
