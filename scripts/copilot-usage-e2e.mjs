#!/usr/bin/env node
/*
 * Copilot usage end-to-end check — run by hand on every Copilot CLI upgrade, beside
 * scripts/copilot-extension-isolation-check.mjs (docs/design/copilot-usage-extension.md
 * §Coexistence). Unit tests inject the environment each lane sees; only a real CLI
 * shows what it actually passes (it hides COPILOT_OTEL_FILE_EXPORTER_PATH from hooks
 * and tools, which a unit test cannot know).
 *
 * Runs one real `copilot -p` per case with this checkout's plugin, in a throwaway
 * COPILOT_HOME, against a loopback stub for the token, bearer and ingest endpoints, and
 * a throwaway TOKENSCOPE_STATE_DIR:
 *   - after setup, new terminal: extensions enabled by the real setup function; the
 *     extension posts protobuf carrying the instance and tool, the spool drains, no
 *     drift, the forwarder idles;
 *   - after setup, old terminal (span variable still exported): the extension still
 *     posts everything; the forwarder idles;
 *   - before setup, old terminal: no extension loads; the forwarder posts.
 * Every case fails on any failed plugin hook, or on a post from the wrong lane.
 *
 * Needs an authenticated Copilot CLI. It copies the account's Copilot config into the
 * throwaway home without printing it, dropping the host's installed plugins so only
 * this checkout's plugin loads. Two short model calls.
 *
 *   node scripts/copilot-usage-e2e.mjs [--copilot <bin>]
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { enableExtensionsFeature } from '../plugin/scripts/copilot-redeem.mjs'
import { readUsageDrift } from '../plugin/scripts/copilot-usage.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const argIdx = process.argv.indexOf('--copilot')
const copilot = argIdx > 0 ? process.argv[argIdx + 1] : process.env.COPILOT_BIN || 'copilot'
const INSTANCE = '9a1e0000-0000-4000-8000-00000000e2e1'
const SPAN_PATH = '.tokenscope.local/copilot-otel.jsonl'

async function runLane({ name, migrated, legacy }) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'ts-usage-e2e-'))
  const posts = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const json = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)))
      if (req.url === '/oauth/token') return json({ access_token: 'e2e-access', expires_in: 3600 })
      if (req.url === `/api/v1/instances/${INSTANCE}/bearer`) return json({ Authorization: 'Bearer e2e-bearer' })
      if (req.url === '/v1/logs') {
        posts.push({ auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks) })
        res.writeHead(204)
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const home = join(root, 'copilot-home')
    fs.mkdirSync(home, { mode: 0o700 })
    const realCfg = join(process.env.COPILOT_HOME || join(os.homedir(), '.copilot'), 'config.json')
    if (!fs.existsSync(realCfg)) throw new Error(`no Copilot config at ${realCfg}: sign in to Copilot first`)
    const raw = fs.readFileSync(realCfg, 'utf8')
    let cfg
    try {
      cfg = JSON.parse(raw)
    } catch {
      cfg = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
    }
    cfg.installedPlugins = []
    fs.writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
    const armed = migrated ? enableExtensionsFeature(join(home, 'settings.json')) : 'not-migrated'

    const state = join(root, 'state')
    fs.mkdirSync(state, { mode: 0o700 })
    fs.writeFileSync(
      join(state, 'config.copilot-cli.json'),
      JSON.stringify({
        version: 2,
        tool: 'copilot-cli',
        instance_id: INSTANCE,
        bearer_endpoint: `${base}/api/v1/instances/${INSTANCE}/bearer`,
        logs_endpoint: `${base}/v1/logs`,
        oauth_token_endpoint: `${base}/oauth/token`,
        oauth_client_id: 'e2e-client',
        oauth_refresh_token: 'e2e-refresh',
        otel_resource_attributes: `tokenscope.instance_id=${INSTANCE},tool=copilot-cli`,
      }),
      { mode: 0o600 },
    )
    const repo = join(root, 'repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })

    const env = { ...process.env, COPILOT_HOME: home, TOKENSCOPE_STATE_DIR: state }
    if (legacy) env.COPILOT_OTEL_FILE_EXPORTER_PATH = SPAN_PATH
    else delete env.COPILOT_OTEL_FILE_EXPORTER_PATH
    // Async: the stub answers from this process, so a blocking spawn would starve it.
    const status = await new Promise((resolve) => {
      const c = spawn(copilot, ['--plugin-dir', join(REPO, 'copilot-plugin'), '-p', 'Reply with the single word: ok', '--allow-all-tools'], {
        cwd: repo,
        env,
        stdio: 'ignore',
      })
      const t = setTimeout(() => c.kill('SIGKILL'), 300_000)
      c.on('close', (code) => (clearTimeout(t), resolve(code)))
    })
    await new Promise((r) => setTimeout(r, 3000))

    const logsDir = join(home, 'logs')
    const hookFailures = fs.existsSync(logsDir)
      ? fs
          .readdirSync(logsDir)
          .flatMap((f) => fs.readFileSync(join(logsDir, f), 'utf8').split('\n'))
          .filter((l) => /Hook from .* failed|force-killing/.test(l))
      : []
    const count = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')).length : 0)
    const ext = posts.filter((p) => p.body.includes('tokenscope.emitter'))
    const all = posts.map((p) => p.body.toString('latin1')).join('\n')
    const failures = []
    if (status !== 0) failures.push(`copilot exited ${status}`)
    if (armed === 'manual') failures.push('setup could not enable the EXTENSIONS feature')
    if (hookFailures.length) failures.push(`plugin hook failures: ${hookFailures.map((l) => l.slice(0, 120)).join(' | ')}`)
    if (!posts.length) failures.push('nothing reached the ingest endpoint')
    if (!posts.every((p) => p.auth === 'Bearer e2e-bearer' && p.type === 'application/x-protobuf')) failures.push('a post lacked the bearer or protobuf type')
    if (!all.includes(INSTANCE) || !all.includes('copilot-cli')) failures.push('posts lack the instance or tool stamp')
    if (!migrated) {
      if (ext.length) failures.push(`the extension posted ${ext.length} batch(es) on a device not yet migrated`)
    } else {
      if (ext.length !== posts.length) failures.push('the forwarder posted on a migrated device (double count)')
      if (count(join(state, 'copilot-usage-spool'))) failures.push('the spool did not drain')
      if (readUsageDrift(state)) failures.push(`drift reported: ${JSON.stringify(readUsageDrift(state))}`)
    }
    return { lane: name, posts: posts.length, extensionPosts: ext.length, failures }
  } finally {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const results = []
for (const c of [
  { name: 'after setup, new terminal', migrated: true, legacy: false },
  { name: 'after setup, old terminal', migrated: true, legacy: true },
  { name: 'before setup, old terminal', migrated: false, legacy: true },
]) {
  results.push(await runLane(c))
}
let version = ''
try {
  version = execFileSync(copilot, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]
} catch {
  /* reported as blank */
}
for (const r of results) {
  console.log(`${r.failures.length ? 'FAIL' : 'PASS'} ${r.lane}: ${r.posts} post(s), ${r.extensionPosts} from the extension`)
  for (const f of r.failures) console.log(`  - ${f}`)
}
const ok = results.every((r) => !r.failures.length)
console.log(`${ok ? 'PASS' : 'FAIL'} (${version})`)
process.exitCode = ok ? 0 : 1
