-- 0127 — `context_window` becomes a GRAIN dimension on provider_usage_fact
-- (developer-pages-consolidation/01-build-design.md W0a, D4).
--
-- WHAT THIS IS. The 2026-08-02 wire capture recorded `data[].context_window`
-- present on 100% of usage-report rows and NULL only because it was not in
-- `group_by` (provider-wire-captures/README.md — "sent, and NULL; in the
-- contract, unpopulated"). The analytics poller now requests it on BOTH reports
-- (the canon clause: "add context_window and speed to both reports or neither",
-- target-state-data-architecture.md — `speed` is deliberately NOT taken), and
-- this migration is the storage half. The schema half is
-- server/anthropic/enterprise-client.ts; the derive half is
-- server/workers/provider-transform.ts.
--
-- THIS IS MORE THAN 0122 DID. `web_search_requests` was a MEASURE on the token
-- row; a new group_by dimension changes ROW CARDINALITY and the dedup key, so
-- the grain unique index moves in the same migration (below) and
-- `grainKey()` / the upsert's ON CONFLICT target move in the same change
-- (server/workers/provider-fact.ts) — the three must match exactly or in-run
-- dedup silently diverges from at-rest dedup.
--
-- NO CHECK ON VALUES, deliberately. The band vocabulary ('0-200k' / '200k+'
-- today) is the PROVIDER'S to extend — an unknown band must ride through, not
-- fail (the same no-enum rationale recorded on the Zod declaration,
-- enterprise-client.ts). The shape CHECK below is not a value constraint: it
-- only refuses whitespace masquerading as a band, exactly as
-- provider_usage_fact_shape_chk (0118:172-180) does for model and cost_type.
--
-- NULL IS NOT A BAND, and the column is nullable for that reason. History
-- older than the trailing poll window (ANTHROPIC_REVISION_WINDOW_DAYS = 30)
-- can never heal: raw stores the response, and the response contains only what
-- group_by asked. Those rows keep `context_window IS NULL` forever and the
-- read side reports them as a reason-typed un-banded remainder ("not banded —
-- before collection began"), never as standard-band. GitHub rows carry no such
-- dimension at all and stay NULL by construction.
ALTER TABLE provider_usage_fact ADD COLUMN context_window text;

-- Shape, not vocabulary: a whitespace-only band would key as a distinct grain
-- and render as a blank segment (0118's own rule for the other dimensions).
ALTER TABLE provider_usage_fact ADD CONSTRAINT provider_usage_fact_context_window_shape_chk
  CHECK (context_window IS NULL OR nullif(btrim(context_window), '') IS NOT NULL);

/*
 * THE GRAIN UNIQUE INDEX IS REPLACED, not added to: the new member gets the
 * same nullable-member COALESCE treatment 0118:107-131 documents for every
 * other grain member (Postgres treats every NULL as distinct, so an
 * un-COALESCEd member would dedupe nothing).
 *
 * Existing rows all carry NULL context_window ('' under COALESCE), so the old
 * key remains unique under the new expression — the swap cannot fail on
 * existing data. Re-polled days then land banded rows BESIDE their NULL-band
 * predecessors (a new key is a fresh INSERT), and the transform's guarded
 * prune removes the predecessors wholesale once the run has re-asserted the
 * window — the same first-stamp-then-prune convergence 0118 records for actor
 * resolution. Days outside the poll window keep their NULL-band rows.
 */
DROP INDEX provider_usage_fact_grain_uidx;
CREATE UNIQUE INDEX provider_usage_fact_grain_uidx ON provider_usage_fact (
  source,
  COALESCE(teammate_id::text, 'actor:' || lower(actor_ref)),
  date, tool, COALESCE(model, ''), COALESCE(cost_type, ''), COALESCE(context_window, '')
);

COMMENT ON COLUMN provider_usage_fact.context_window IS
  'Anthropic''s context-window band for this grain, verbatim from the wire (''0-200k'' / ''200k+'' today; the vocabulary is the provider''s to extend — no enum, no CHECK on values). A GRAIN dimension on both the token and cost rows, requested via group_by on both reports since 0127. NULL = the capture predates collection (history older than the trailing poll window can never heal — raw holds only what group_by asked) or the provider carries no such dimension (all github rows). The read side types NULL as an un-banded remainder, never as standard-band.';
