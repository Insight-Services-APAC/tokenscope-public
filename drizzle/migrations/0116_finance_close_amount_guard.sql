-- 0116 — a closed month's MONEY cannot move, enforced where the data lives.
--
-- THE GAP. 0102 introduced finance close and froze the governance VERDICT:
-- `closeFinancePeriod` stamps `actual_spend.governance_verdict_locked_at`, and
-- `recompute.ts` structurally excludes closed-period rows. Amounts were never
-- covered. `upsertActualSpend`'s ON CONFLICT gates exactly two columns behind
-- that lock (chargeback_exempt, governance_verdict_source) and updates
-- cost_usd / input_tokens / output_tokens UNCONDITIONALLY.
--
-- Concrete failure: 2026-06 closes on 07-05. On 08-01 the poller re-runs a June
-- date (a backfill, a retry, a provider revision inside Anthropic's documented
-- 30-day window) and cost_usd is silently overwritten. No error, no audit event,
-- no restatement. The verdict stays frozen while the money moves, which is the
-- inverse of what close is for.
--
-- WHY A TRIGGER AND NOT A CASE IN THE UPSERT. There are six-plus writers to
-- actual_spend today -- the Anthropic poller's upsert, its stale-row convergence
-- DELETE, copilot-bill's INSERT and its seat-convergence DELETE, three UPDATEs in
-- governance-key-backfill, and placement-store's INSERT. Two of those are
-- DELETEs, which no amount of care in an ON CONFLICT clause can reach. A guard
-- in one statement is not an invariant; it is a patch on one path, and it
-- protects nothing written next year by someone who never read this comment.
--
-- REOPEN AND RESTATE ARE NOT SPECIAL-CASED, DELIBERATELY. Both set
-- finance_period.state = 'open' -- `reopenFinancePeriod` persistently,
-- `restateFinancePeriod` transiently within its own transaction, invisible to
-- other callers because it holds the advisory lock. So keying the guard on that
-- state means the sanctioned paths pass unchanged and need no exemption.
--
-- ORDERING, PRECISELY, because an earlier version of this comment had it
-- backwards and a future guard expansion built on that would break reopen:
-- reopenFinancePeriod clears actual_spend.governance_verdict_locked_at FIRST
-- and flips the period state AFTER. That row UPDATE survives this guard only
-- because it is NON-MONETARY -- it touches none of the three amount columns.
-- Widening the guard to freeze any column would therefore break the documented
-- reopen path, and the fix would be to reorder finance-period.ts, not to carve
-- an exemption here. An exemption is a hole; a state check is a
-- rule. If a future correction path needs to move a closed month's money, it
-- flips the state like the existing two do, and is therefore audited by
-- construction.
--
-- ABSENT ROW = OPEN, matching 0102's own convention: a finance_period row only
-- exists once a month has been closed, so this never needs pre-seeding.

CREATE OR REPLACE FUNCTION actual_spend_finance_close_guard()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  row_month    date;
  old_month    date;
  period_state text;
BEGIN
  -- OLD is NULL on INSERT, NEW is NULL on DELETE.
  row_month := date_trunc('month', COALESCE(NEW.date, OLD.date))::date;
  old_month := date_trunc('month', COALESCE(OLD.date, NEW.date))::date;

  /*
   * AN UPDATE IS CHECKED AGAINST BOTH MONTHS, not just the row's new one.
   * Resolving the month from NEW alone leaves a closed month drainable by
   * re-dating: `UPDATE actual_spend SET date = <an open month> WHERE ...`
   * carries the charge out from under the guard, and the guard -- reading the
   * destination -- waves it through. Moving spend INTO a closed month is the
   * same defect pointed the other way. Either direction is a restatement and
   * belongs on the audited path.
   */
  IF TG_OP = 'UPDATE' AND NEW.date IS DISTINCT FROM OLD.date THEN
    IF EXISTS (SELECT 1 FROM finance_period
                WHERE period_month IN (old_month, row_month) AND state = 'closed') THEN
      RAISE EXCEPTION
        'finance period is closed: refusing to move actual_spend row % between % and %',
        OLD.id, old_month, row_month
        USING ERRCODE = 'raise_exception',
              HINT = 'REOPEN the period to change money (server/governance/finance-period.ts). Restate re-runs governance verdicts only -- it opens the period transiently inside its own transaction, so it cannot admit an external amount change.';
    END IF;
  END IF;

  SELECT state INTO period_state
    FROM finance_period
   WHERE period_month = row_month;

  -- No row, or 'open' -> nothing to enforce. This is the overwhelmingly common
  -- path, and it is one indexed lookup on a table with at most one row per
  -- calendar month.
  IF period_state IS DISTINCT FROM 'closed' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'finance period % is closed: refusing to DELETE actual_spend row % (%, %, %)',
      row_month, OLD.id, OLD.teammate_id, OLD.date, OLD.tool
      USING ERRCODE = 'raise_exception',
            HINT = 'REOPEN the period to change money (server/governance/finance-period.ts). Restate re-runs governance verdicts only -- it opens the period transiently inside its own transaction, so it cannot admit an external amount change.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    /*
     * A BEFORE INSERT trigger fires BEFORE Postgres resolves ON CONFLICT, so it
     * cannot tell a genuinely new row from one that is about to become an
     * UPDATE. Every writer here is an upsert (analytics-poller, copilot-bill,
     * placement-store), which means a blanket refusal would reject a routine
     * re-poll of a closed month even when the amount is identical -- and the
     * poller's per-org catch turns that into "poll failed" and stops the org
     * writing rows AT ALL. A guard against silent money movement that causes a
     * silent ingestion outage is a worse bug than the one it fixes.
     *
     * So: if the unique key already exists, this INSERT is an upsert in
     * disguise. Let it through and let the UPDATE branch below judge it on
     * whether the money actually changes. A genuinely NEW row in a closed month
     * is still refused, which is the case that matters -- late spend is a
     * restatement, not a silent top-up.
     *
     * The key mirrors actual_spend_teammate_date_tool_source_unique. If that
     * index changes, this must change with it.
     */
    IF EXISTS (
      SELECT 1 FROM actual_spend a
       WHERE a.teammate_id = NEW.teammate_id
         AND a.date        = NEW.date
         AND a.tool        = NEW.tool
         AND a.source      = NEW.source
    ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'finance period % is closed: refusing to INSERT a NEW actual_spend row (%, %, %)',
      row_month, NEW.teammate_id, NEW.date, NEW.tool
      USING ERRCODE = 'raise_exception',
            HINT = 'REOPEN the period to change money (server/governance/finance-period.ts). Restate re-runs governance verdicts only -- it opens the period transiently inside its own transaction, so it cannot admit an external amount change.';
  END IF;

  -- UPDATE: only the money is frozen. Everything else -- governance keys,
  -- denormalised dimensions, raw_payload -- stays writable, because maintenance
  -- like governance-key-backfill legitimately touches closed rows without
  -- changing what anyone is charged.
  IF NEW.cost_usd     IS DISTINCT FROM OLD.cost_usd
  OR NEW.input_tokens  IS DISTINCT FROM OLD.input_tokens
  OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens THEN
    RAISE EXCEPTION
      -- PL/pgSQL RAISE has ONE placeholder, bare `%`. There is no printf format
      -- spec: `%.4f` substitutes at the `%` and then emits ".4f" literally, so
      -- the old text read "cost_usd 10.0000.4f -> 99.0000.4f". numeric already
      -- renders at full precision.
      'finance period % is closed: refusing to change amounts on actual_spend row % (cost_usd % -> %)',
      row_month, OLD.id, OLD.cost_usd, NEW.cost_usd
      USING ERRCODE = 'raise_exception',
            HINT = 'REOPEN the period to change money (server/governance/finance-period.ts). Restate re-runs governance verdicts only -- it opens the period transiently inside its own transaction, so it cannot admit an external amount change.';
  END IF;

  RETURN NEW;
END;
$$;

-- NOT COVERED, stated rather than implied: a table owner can
-- ALTER TABLE ... DISABLE TRIGGER. That is a deliberate act by someone with
-- owner rights, not a path an ordinary writer reaches by accident. TRUNCATE is
-- covered below -- it does not fire ROW-level triggers, so it gets a
-- STATEMENT-level one rather than a paragraph excusing it.

COMMENT ON FUNCTION actual_spend_finance_close_guard() IS
  'Refuses INSERT/DELETE, and amount-changing UPDATEs, against actual_spend rows in a CLOSED finance period. Reopen/restate need no exemption: both set finance_period.state=open before touching rows. See 0116.';

CREATE TRIGGER actual_spend_finance_close_guard
  BEFORE INSERT OR UPDATE OR DELETE ON actual_spend
  FOR EACH ROW
  EXECUTE FUNCTION actual_spend_finance_close_guard();

/*
 * TRUNCATE does not fire row-level triggers, so the guard above would not see
 * it. Nothing in this codebase truncates actual_spend today, which is exactly
 * why this is cheap to close now rather than after someone adds a cleanup
 * helper. A statement-level trigger cannot inspect rows, so this refuses
 * outright whenever ANY period is closed: truncating a table that holds
 * signed-off months is never routine.
 */
CREATE OR REPLACE FUNCTION actual_spend_finance_close_guard_truncate()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_period WHERE state = 'closed') THEN
    RAISE EXCEPTION
      'refusing to TRUNCATE actual_spend while at least one finance period is closed'
      USING ERRCODE = 'raise_exception',
            HINT = 'Reopen the closed period(s) first (server/governance/finance-period.ts).';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER actual_spend_finance_close_guard_truncate
  BEFORE TRUNCATE ON actual_spend
  FOR EACH STATEMENT
  EXECUTE FUNCTION actual_spend_finance_close_guard_truncate();
