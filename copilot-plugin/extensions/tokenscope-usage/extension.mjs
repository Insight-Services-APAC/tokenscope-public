// TokenScope usage extension — loaded by the Copilot runtime (App, and the CLI with the
// EXTENSIONS feature). Wiring only; the logic is scripts/copilot-usage.mjs.
// Registers NO hooks, tools or permission handlers: any of those makes the runtime
// demand an extension-permission grant (and -p mode denies it). Delivery relies on the
// idle flush plus the durable spool instead. Design: docs/design/copilot-usage-extension.md.
import { joinSession } from '@github/copilot-sdk/extension'
import { createUsageEmitter } from '../../scripts/copilot-usage.mjs'

const log = (msg) => process.stderr.write(`[tokenscope-usage] ${msg}\n`)
const emitter = createUsageEmitter({ log })

const session = await joinSession({})
emitter.attach(session.sessionId)
session.on((event) => {
  try {
    emitter.onEvent(event)
  } catch (err) {
    log(err?.message ?? String(err))
  }
})
process.once('SIGTERM', () => {
  emitter.close().finally(() => process.exit(0))
})
emitter.flush().catch(() => {})
