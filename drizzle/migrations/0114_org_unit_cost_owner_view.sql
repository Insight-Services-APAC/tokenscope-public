-- 0114 — v_org_unit_cost_owner: resolve the nearest cost-owning ancestor ONCE
-- per org_unit, instead of once per usage row.
--
-- THE PROBLEM. Five places resolved "which cost-owning unit does this org_unit
-- roll up to" with the same correlated LATERAL:
--
--   LEFT JOIN LATERAL (
--     SELECT anc.id FROM org_unit home JOIN org_unit anc ON home.path <@ anc.path
--     WHERE home.id = <outer>.org_unit_id
--       AND anc.is_cost_owning_unit AND anc.retired_at IS NULL
--     ORDER BY nlevel(anc.path) DESC LIMIT 1) cc ON TRUE
--
-- Correlating on the outer row collapses the inner side to one row, so the GiST
-- index on path is never used and each evaluation does two sequential scans of
-- org_unit. It fires once per VIEW ROW — 49,140 times for a one-month regional
-- window, 294,840 buffer hits — to compute a mapping with 8 distinct outputs
-- over a 132-row table. Measured at 613ms of an 1183ms endpoint (52%).
--
-- Worse, one copy lives inside v_finance_bill_chargeback, where it runs per
-- actual_spend row for EVERY §B query in the application. Its cost scales with
-- rows in the window, so it grows linearly with ledger volume forever.
--
-- WHY DISTINCT ON RATHER THAN LATERAL. A view whose body is a correlated
-- LATERAL can be inlined and re-correlated by the planner against the caller's
-- outer row — which would reproduce the exact per-row evaluation this migration
-- exists to remove, while looking like it had been fixed. DISTINCT ON has no
-- outer reference to push down: the mapping is computed once (132 rows, joined
-- to at most 132 candidate ancestors) and hash-joined. The formulation is the
-- fix; the view alone is not.
--
-- SEMANTICS ARE UNCHANGED, deliberately and exactly:
--   * `home.path <@ anc.path` — anc is home itself or an ancestor of it. A unit
--     that is ITSELF cost-owning resolves to itself (<@ is reflexive).
--   * deepest wins (ORDER BY nlevel DESC) — the NEAREST such ancestor.
--   * `anc.id` is the final ORDER BY key, NOT decoration. Two live cost-owning
--     ancestors can sit at the SAME depth (nothing constrains org_unit.path to
--     be globally unique — the only uniqueness is (region_id, code)), and
--     without a total order both DISTINCT ON here and the `LIMIT 1` this
--     replaced pick an arbitrary winner that can differ between plans. For a
--     view that decides which cost centre is BILLED, "arbitrary but stable" is
--     the least we should offer.
--   * retired ancestors are skipped, so a retired cost centre hands its
--     descendants up to the next live one rather than stranding them.
--   * LEFT JOIN: an org_unit under no live cost-owning ancestor keeps a row
--     with a NULL cost_owning_unit_id. That TOTALITY — one row per org_unit,
--     always — is what keeps unhomed spend visible as "Unattributed" rather
--     than vanishing from a total, and it is the property callers depend on.
--     (Note for readers of 0115: because this view is total, a caller joining
--     it with INNER vs LEFT selects the same rows today. The totality is the
--     guarantee; the LEFT at each call site is defence-in-depth.)
--
-- KNOWN LIMIT, PRE-EXISTING AND DELIBERATELY UNCHANGED HERE. `home.path <@
-- anc.path` has no region clamp, and org_unit.path is not globally unique, so
-- in principle a unit could resolve to a same-named ancestor in ANOTHER region.
-- The LATERAL this replaces had exactly the same predicate, so behaviour is
-- unchanged either way — but it is a real hazard and fixing it MOVES MONEY
-- between cost centres, which is a billing decision, not a refactor. Left as a
-- separate change rather than smuggled into a performance one.
--
-- security_invoker = true, matching every other v_* view: the view must not
-- become a privilege-escalation path around RLS.
CREATE OR REPLACE VIEW v_org_unit_cost_owner WITH (security_invoker = true) AS
SELECT DISTINCT ON (home.id)
       home.id                AS org_unit_id,
       anc.id                 AS cost_owning_unit_id,
       anc.display_name       AS cost_owning_unit_name,
       anc.code               AS cost_owning_unit_code,
       anc.region_id          AS cost_owning_unit_region_id
FROM org_unit home
LEFT JOIN org_unit anc
       ON home.path <@ anc.path
      AND anc.is_cost_owning_unit = TRUE
      AND anc.retired_at IS NULL
ORDER BY home.id, nlevel(anc.path) DESC, anc.id;

COMMENT ON VIEW v_org_unit_cost_owner IS
  'Nearest live cost-owning ancestor of each org_unit (reflexive: a cost-owning unit maps to itself), one row per org_unit, cost_owning_unit_id NULL when there is none. THE single implementation of that resolution — do not re-inline the correlated LATERAL it replaced (it fired once per usage row to answer a 132-row question). Join as `LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = <row>.org_unit_id`; a LEFT join is required, since an INNER one drops unhomed spend out of totals.';
