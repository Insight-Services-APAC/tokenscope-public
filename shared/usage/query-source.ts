/*
 * query-source — classify a raw `query_source` wire value into the
 * conversation lane (`main`) vs the harness-overhead lane (`aux`).
 *
 * WHY THIS EXISTS: CLAUDE CODE does not send the word `main`. (Our own Copilot
 * plugin deliberately does — copilot-plugin/scripts/otlp-logs.mjs — which is
 * why `main` is in the allow-list below and why this must be stated per
 * emitter, not as a blanket claim.) Claude Code sends
 * its own internal query-source token (`repl_main_thread`, `agent:custom`,
 * `compact`, …) and only its *category* is ever the string `main` — a separate
 * field it does not put on the OTLP wire. Every consumer that tested
 * `query_source === 'main'` therefore classified 100% of Claude Code spend as
 * harness overhead. Full evidence + the verified vocabulary:
 * docs/development/claude-code-telemetry-contract.md §Query-source vocabulary.
 *
 * Pure TS, no imports — reachable from the server read-models and the UI alike.
 */

/**
 * Which side of the main-vs-overhead split a record sits on.
 *
 * `unknown` is NOT a third lane to be folded into either side: it means the
 * record carries no lane signal at all (pre-mig-0045 capture, or an emitter
 * that never sent the attribute). Consumers exclude it from BOTH sides — see
 * `detectAuxOverhead`.
 */
export type QuerySourceClass = 'main' | 'aux' | 'unknown'

/**
 * Exact main-lane tokens.
 *
 *  - `sdk` — Claude Code's headless / Agent-SDK entry point (`claude -p`).
 *  - `main` — the value OUR Copilot transcoder emits for an interactive turn
 *    (`plugin/scripts/otlp-logs.mjs`, derived from `github.copilot.initiator`).
 *    Kept so the Copilot lane keeps classifying as it always did.
 *  - `hook_agent` — an agent spawned by a user-configured hook. Claude's own
 *    classifier puts it in the `subagent` category, not `auxiliary`.
 */
const MAIN_EXACT: ReadonlySet<string> = new Set(['main', 'sdk', 'hook_agent'])

/**
 * Main-lane PREFIXES.
 *
 *  - `repl_main_thread` — the interactive REPL turn. Carries an output-style
 *    suffix when one is active (`repl_main_thread:outputStyle:Concise`), so it
 *    must be matched as a prefix, never by equality.
 *  - `agent:` — a Task-tool subagent (`agent:default`, `agent:builtin`,
 *    `agent:custom`). This is the teammate's OWN work, delegated — not harness
 *    overhead — and Claude classifies it `subagent`, deliberately distinct from
 *    `auxiliary`. Folded into main because this split's question is "your
 *    conversation or the harness?", and a subagent turn is the conversation.
 */
const MAIN_PREFIXES: readonly string[] = ['repl_main_thread', 'agent:']

/**
 * A stringified null/undefined that reached the column as text. Not a lane —
 * a capture defect — so it reads as "no signal" rather than as overhead.
 */
const NULLISH_TEXT: ReadonlySet<string> = new Set(['null', 'undefined'])

/**
 * Classify one raw `query_source`.
 *
 * Main is a CLOSED allow-list and everything else non-empty is auxiliary, so a
 * newly-added Anthropic overhead lane counts as overhead the day it appears
 * without a code change. The cost of that openness is that a rename on the MAIN
 * side reads as 100% overhead — which is why `detectAuxOverhead` additionally
 * refuses to publish when the main lane is empty.
 */
export function classifyQuerySource(raw: string | null | undefined): QuerySourceClass {
  if (raw == null) return 'unknown'
  const value = raw.trim().toLowerCase()
  if (!value || NULLISH_TEXT.has(value)) return 'unknown'
  if (MAIN_EXACT.has(value)) return 'main'
  for (const prefix of MAIN_PREFIXES) if (value.startsWith(prefix)) return 'main'
  return 'aux'
}

/** Display label for one raw `query_source` — the raw token stays visible for aux lanes. */
export function querySourceLabel(raw: string | null | undefined): string {
  const cls = classifyQuerySource(raw)
  if (cls === 'unknown') return 'Unknown'
  if (cls === 'main') return 'Your conversation'
  // Trimmed: classifyQuerySource tolerates surrounding whitespace, so a lane
  // that classified on the trimmed value must not render the untrimmed one.
  return (raw as string).trim()
}
