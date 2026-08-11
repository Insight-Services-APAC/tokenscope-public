-- 0102 — finance_period (Workstream B, Required outcome 1).
--
-- Design: docs/design/usage-completeness-and-provider-governance.md §4.1, §8.4.
-- Absence of a row for a month means OPEN (the implicit default) — a row only
-- ever needs to exist once a month is CLOSED, so this never needs pre-seeding
-- for future months. state='closed' freezes every actual_spend row's
-- governance verdict for that calendar month (enforced in application code —
-- server/governance/recompute.ts structurally excludes closed-period rows from
-- its UPDATE; see server/governance/finance-period.ts for close/reopen/restate).
--
-- period_month is always the FIRST-OF-MONTH date (e.g. 2026-07-01) — a CHECK
-- pins that so a caller can never accidentally key a row on a mid-month date
-- and silently split one calendar month across two rows.
CREATE TABLE finance_period (
  period_month   date PRIMARY KEY,
  state          text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_at      timestamptz,
  closed_by      uuid REFERENCES teammate(id),
  reopened_at    timestamptz,
  reopened_by    uuid REFERENCES teammate(id),
  reopen_reason  text,
  restated_at    timestamptz,
  restated_by    uuid REFERENCES teammate(id),
  restate_reason text,
  CONSTRAINT finance_period_month_is_first_of_month CHECK (period_month = date_trunc('month', period_month)::date)
);

COMMENT ON TABLE finance_period IS
  'Per-calendar-month finance close state (Workstream B). Absent row = open (implicit default). Closed freezes actual_spend.chargeback_exempt for that month — see server/governance/recompute.ts + server/governance/finance-period.ts. usage-completeness-and-provider-governance.md §4.1/§8.4.';
