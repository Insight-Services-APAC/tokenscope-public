-- 0072: chargeback-exempt FLAG on the bill + Copilot flat-seat/allowance config.
--
-- Intent: ADR-0010. Two model corrections land here:
--
-- 1. chargeback_exempt is a FLAG on the bill row, NOT a visibility class. The old
--    model overloaded reconciliation_record.spend_class='indicative' to mean BOTH
--    "advisory/pre-billing" AND "chargeback-exempt", which hid exempt cost from
--    SHOWBACK as a side effect. ADR-0010 rule 3: showback shows ALL genuine cost;
--    rule 5: chargeback is the SINGLE place exempt is excluded. So the bill carries a
--    boolean the chargeback view filters on, and showback ignores. Default false →
--    every existing (Anthropic) row is chargeable exactly as before.
--
-- 2. Copilot's real billing structure (ADR-0010 rule 4 / D1 / D2): a whole-month flat
--    per-seat license + a per-user included AI-credit allowance, overage above the
--    allowance assumed billable. Prices/allowances are CONFIGURATION (region/enterprise-
--    configurable, cf. region-configurable vocabulary), not hardcoded constants. NULL =
--    that component disabled (NULL flat price → no flat row; NULL allowance → overage
--    disabled, NOT "allowance = 0").
ALTER TABLE actual_spend
  ADD COLUMN chargeback_exempt boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN actual_spend.chargeback_exempt IS
  'ADR-0010 rule 5: row is excluded from the finance chargeback view (v_finance_bill_chargeback) but NOT from showback (v_finance_bill_showback). Set true for NFR/exempt license-orgs. Anthropic bill rows are always false.';

ALTER TABLE provider_enterprise
  ADD COLUMN flat_seat_price_usd numeric(14, 6),
  ADD COLUMN included_allowance_usd numeric(14, 6);

COMMENT ON COLUMN provider_enterprise.flat_seat_price_usd IS
  'ADR-0010 D1: whole-month flat per-seat license price (e.g. 39.00). NULL = no flat row written.';
COMMENT ON COLUMN provider_enterprise.included_allowance_usd IS
  'ADR-0010 D2: per-user included AI-credit allowance in USD (e.g. 70.00). NULL = overage disabled (no overage rows).';
