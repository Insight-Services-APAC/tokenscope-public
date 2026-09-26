#!/usr/bin/env node
/*
 * Copilot extension isolation check: run by hand on every Copilot CLI upgrade, beside
 * scripts/copilot-usage-e2e.mjs (docs/design/copilot-usage-extension.md §Risk).
 *
 * Setup turns on Copilot's EXTENSIONS feature so the CLI loads the TokenScope usage
 * extension. That also lets a repository's own `.github/extensions` run as code where
 * Copilot loads project extensions: interactive sessions, and prompt mode with
 * GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS=true. That is ACCEPTED (design §Risk: a trusted
 * repository can already run code through `.github/hooks/`, and the Copilot App loads
 * extensions by default). This check pins what the posture relies on, with a probe
 * plugin that records which extensions each session reports loaded, from a throwaway
 * repo carrying its own extension, in a throwaway COPILOT_HOME:
 *   - the feature still loads plugin extensions (else capture silently stops);
 *   - in default prompt mode, the repo's extension does not run, whether or not the
 *     repo is in Copilot's trustedFolders (a CLI change here widens exposure);
 * and it REPORTS, without failing, whether the repo's extension runs once project
 * extensions are enabled, so a change in the accepted behaviour is visible (or
 * INCONCLUSIVE, failing, when even the probe did not load). Settings are written by
 * setup's own enableExtensionsFeature, so the runs also prove extension mode
 * load_only still loads plugin extensions.
 *
 * Needs an authenticated Copilot CLI; it copies the account's Copilot config into the
 * throwaway home without printing it. Extensions load at session start, so it needs no
 * successful model call. Three short sessions.
 *
 *   node scripts/copilot-extension-isolation-check.mjs [--copilot <bin>]
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { enableExtensionsFeature } from '../plugin/scripts/copilot-redeem.mjs'
import { execFileSync, spawnSync } from 'node:child_process'

const argIdx = process.argv.indexOf('--copilot')
const copilot = argIdx > 0 ? process.argv[argIdx + 1] : process.env.COPILOT_BIN || 'copilot'

function runCase({ trusted, projectMode = false }) {
  const root = mkdtempSync(join(tmpdir(), 'ts-ext-isolation-'))
  try {
    const home = join(root, 'copilot-home')
    mkdirSync(home, { mode: 0o700 })
    const realConfig = join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'config.json')
    if (!existsSync(realConfig)) throw new Error(`no Copilot config at ${realConfig}: sign in to Copilot first`)
    mkdirSync(join(root, 'repo'))
    const repo = realpathSync(join(root, 'repo')) // Copilot matches trusted folders by real path
    // A parsed copy, never printed: this host's installed plugins must not load; keys
    // that would override settings.json are dropped; in the trusted case the throwaway
    // repo is added to trustedFolders, the risky case (a repository the developer trusts).
    const raw = readFileSync(realConfig, 'utf8')
    let cfg
    try {
      try {
        cfg = JSON.parse(raw)
      } catch {
        cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
      }
    } catch {
      throw new Error(`cannot parse ${realConfig}`) // never the parser's message: it quotes the file
    }
    cfg.installedPlugins = []
    delete cfg.enabledFeatureFlags
    delete cfg.extensions
    cfg.trustedFolders = trusted ? [...(Array.isArray(cfg.trustedFolders) ? cfg.trustedFolders : []), repo] : []
    writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
    // The settings setup writes (extensions on, load_only), by the real setup function.
    if (enableExtensionsFeature(join(home, 'settings.json')) !== 'enabled') throw new Error('setup could not enable extensions')

    const loadedLog = join(root, 'extensions-loaded.json')
    const repoMarker = join(root, 'REPO_EXTENSION_RAN')
    const plugin = join(root, 'probe-plugin')
    mkdirSync(join(plugin, 'extensions', 'probe'), { recursive: true })
    writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: 'ts-isolation-probe', version: '0.0.0', description: 'probe' }))
    writeFileSync(
      join(plugin, 'extensions', 'probe', 'extension.mjs'),
      `import { joinSession } from '@github/copilot-sdk/extension'
import fs from 'node:fs'
const session = await joinSession({})
session.on((e) => {
  if (e.type !== 'session.extensions_loaded') return
  fs.writeFileSync(${JSON.stringify(loadedLog)}, JSON.stringify((e.data?.extensions ?? []).map((x) => ({ name: x.name, source: x.source, status: x.status }))))
})
`,
    )
    mkdirSync(join(repo, '.github', 'extensions', 'repo-probe'), { recursive: true })
    writeFileSync(
      join(repo, '.github', 'extensions', 'repo-probe', 'extension.mjs'),
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(repoMarker)}, 'ran')\n`,
    )
    execFileSync('git', ['init', '-q'], { cwd: repo })

    const r = spawnSync(copilot, ['--plugin-dir', plugin, '-p', 'Reply with the single word: ok', '--allow-all-tools'], {
      cwd: repo,
      env: {
        ...process.env,
        COPILOT_HOME: home,
        GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: projectMode ? 'true' : '',
      },
      encoding: 'utf8',
      timeout: 240_000,
    })
    // Extensions load at session start, before any model call, so the verdict stands on
    // the extensions_loaded record even if the model call itself was refused.
    const loaded = existsSync(loadedLog) ? JSON.parse(readFileSync(loadedLog, 'utf8')) : null
    if (r.status !== 0 && !loaded) throw new Error(`copilot exited ${r.status}: ${(r.stderr || r.stdout || '').slice(-400)}`)
    const failures = []
    if (!loaded || !loaded.some((x) => x.name?.includes('ts-isolation-probe'))) {
      failures.push('the probe plugin extension did not load: the EXTENSIONS feature flag no longer loads plugin extensions')
    }
    if (existsSync(repoMarker)) failures.push("the repository's own .github/extensions extension RAN")
    for (const x of loaded ?? []) {
      if (x.source !== 'plugin') failures.push(`an extension from source '${x.source}' loaded: ${x.name}`)
    }
    return { trusted, projectMode, failures, loaded, repoRan: existsSync(repoMarker) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const results = [runCase({ trusted: false }), runCase({ trusted: true })]
const accepted = runCase({ trusted: true, projectMode: true })
const acceptedProbe = accepted.loaded?.some((x) => x.name?.includes('ts-isolation-probe'))
const version = spawnSync(copilot, ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]
for (const r of results) {
  const label = `default prompt mode, ${r.trusted ? 'trusted' : 'untrusted'} repository`
  if (r.failures.length) console.error(`FAIL ${label}\n  - ${r.failures.join('\n  - ')}`)
  else console.log(`PASS ${label}: only plugin extensions load. Loaded: ${JSON.stringify(r.loaded)}`)
}
if (!acceptedProbe) {
  console.log('INCONCLUSIVE project extensions enabled: the probe plugin itself did not load, so nothing is known about repository extensions.')
} else {
  console.log(
    `REPORT project extensions enabled: the repository's own extension ${accepted.repoRan ? 'RAN (the accepted posture, design §Risk)' : 'did not run (the CLI now restricts it further)'}.`,
  )
}
const ok = acceptedProbe && results.every((r) => !r.failures.length)
console.log(`${ok ? 'PASS' : 'FAIL'} (${version})`)
process.exitCode = ok ? 0 : 1
