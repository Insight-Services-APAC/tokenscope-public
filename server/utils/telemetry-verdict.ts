/*
 * The client-vs-server discriminator: turn two independently-sourced facts into
 * ONE verdict an operator can act on.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE. The attribution-gap detector tells an
 * admin "this device is N days behind". Their next step used to be a shell they
 * do not have — a KQL query against a workspace that is NSP-locked to the app's
 * managed identity. So the answer to "is this the client or is this us?" was
 * unavailable to the person holding the alert. The rule below is the whole
 * decision, and it is worth being able to test it without Azure:
 *
 *   ingest has records + ledger has none  → OURS. The export landed; the join
 *                                           did not happen. Look at the joiner.
 *   ingest has none  + ledger has none    → THEIRS. Nothing reached ingest, so
 *                                           nothing could be joined. Look at the
 *                                           client: transport, auth, plugin
 *                                           version, the shim.
 *
 * This is the product form of the project's standing rule "capture the emission,
 * don't infer": it reads what ingest actually holds instead of reasoning
 * backwards from the absence of ledger rows, which is compatible with both
 * causes and therefore proves neither.
 *
 * THE HONEST FOURTH ANSWER. When the ingest side cannot be read — no reader
 * configured, the query failed, the reader cannot answer this question — the
 * verdict is `unanswerable`. It is NOT folded into "absent": a failed probe and
 * an empty workspace produce identical numbers and opposite diagnoses, and
 * quietly reporting the client's fault because our own query broke is the worst
 * available outcome.
 */

export type TelemetryVerdict =
  /** Ingest has nothing for the window → the loss is on the CLIENT side. */
  | 'absent-from-ingest'
  /**
   * Ingest has records for the device but NONE of them carry token usage → also
   * the client side, and a different fault from "nothing arrived": the transport
   * and the credential are demonstrably working, so the missing thing is the
   * usage events themselves (a CLI version that stopped emitting them, telemetry
   * config, an exporter filtering them out).
   */
  | 'ingested-without-usage'
  /** Ingest has usage records, the ledger has none → the loss is on OUR side (the joiner). */
  | 'ingested-not-attributed'
  /** Ingest has records and the ledger has them too → this window is healthy. */
  | 'attributed'
  /** Ledger rows exist but ingest shows none — see the note below. */
  | 'attributed-beyond-ingest-window'
  /** The ingest side could not be read; no conclusion is available. */
  | 'unanswerable'

export interface VerdictInput {
  /**
   * Ingest-side counts, or null when the ingest side could not be read (no
   * reader, query failure, reader cannot answer). null is NOT zero.
   *
   * `records` is EVERY record for the device; `usageRecords` only the
   * token-carrying subset. Both are load-bearing: their difference separates "the
   * device is not exporting" from "the device is exporting, but not usage".
   */
  ingest: { records: number; usageRecords: number } | null
  /** attribution_record rows for this instance within the SAME window. */
  attributedRecords: number
}

export interface VerdictOutcome {
  verdict: TelemetryVerdict
  /** Which side of the pipeline the evidence points at, or null when unknown. */
  side: 'client' | 'server' | 'none' | null
  /** One sentence stating what was observed and what to do next. */
  interpretation: string
}

/**
 * Decide the verdict from ingest presence + ledger presence over the same window.
 *
 * Pure and total: every combination of inputs yields a verdict, including the
 * ones that "should not happen" — an operator meets those during an incident,
 * and a function that only covers the tidy cases sends them back to the shell.
 */
export function classifyTelemetry(input: VerdictInput): VerdictOutcome {
  const { ingest, attributedRecords } = input

  if (ingest === null) {
    return {
      verdict: 'unanswerable',
      side: null,
      interpretation:
        'The ingest store could not be read for this window, so client-side and server-side loss cannot be told apart. Fix the read path (Admin → Diagnostics → OTel telemetry) before drawing any conclusion — an unread probe is not evidence of an absent export.',
    }
  }

  if (ingest.records === 0) {
    if (attributedRecords > 0) {
      /*
       * Ledger rows but no ingest rows. Not a contradiction: attribution_record is
       * permanent while the workspace has a retention horizon (30d dev/sandbox, 90d
       * production), and the window asked for may reach past what ingest still
       * holds. It can equally mean the device stopped exporting DURING the window
       * while older spend had already been joined. Both readings share one action —
       * narrow the window — so say that rather than pick one.
       */
      return {
        verdict: 'attributed-beyond-ingest-window',
        side: null,
        interpretation:
          'Spend was attributed for this window but ingest holds no matching records — usually the window reaches past Log Analytics retention, or the device stopped exporting part-way through it. Re-run with a shorter window before treating this as a fault.',
      }
    }
    return {
      verdict: 'absent-from-ingest',
      side: 'client',
      interpretation:
        'Nothing from this device reached ingest in the window, so there was nothing to attribute — the loss is CLIENT-side, not the joiner. Check the device: its plugin and CLI versions (reported on the mint), the OTLP transport, and the emit credential. Azure accepting an export is not the same as an export being made.',
    }
  }

  if (attributedRecords === 0) {
    if (ingest.usageRecords === 0) {
      /*
       * Records arrived, but none of them carry token usage. The transport, the
       * emit credential and the ingest endpoint are all demonstrably working —
       * this device IS exporting — so the missing thing is the usage events
       * themselves. Calling this "the joiner" would send the operator to recover
       * a backlog that does not exist: there is nothing in ingest to join.
       */
      return {
        verdict: 'ingested-without-usage',
        side: 'client',
        interpretation:
          'This device is exporting to ingest — records arrived — but none of them carry token usage, so there was nothing to attribute. The transport and credential are fine; the usage events are not being produced. Check the reported CLI version and the device’s telemetry configuration. A widened re-read will not help: there is nothing in ingest to join.',
      }
    }
    return {
      verdict: 'ingested-not-attributed',
      side: 'server',
      interpretation:
        'This device’s telemetry IS in ingest for the window but none of it became attributed spend — the loss is on OUR side, between ingest and attribution_record. The client is fine; recover the backlog with a widened re-read and investigate the joiner.',
    }
  }

  return {
    verdict: 'attributed',
    side: 'none',
    interpretation:
      'Telemetry is in ingest for this window and attributed spend exists for it. Any remaining shortfall is partial, not a stopped pipeline — compare the counts rather than treating this as an outage.',
  }
}
