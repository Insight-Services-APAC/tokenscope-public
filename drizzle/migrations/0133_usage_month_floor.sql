-- The month-picker's usage floor, as a view the reporting lane may read.
--
-- /reports/meta computed it as MIN(ts_event) over v_complete_usage — a 4-arm
-- UNION whose CTEs GROUP BY, so the MIN could use no index and Postgres
-- materialised the whole estate on EVERY load of the reporting shell. That was
-- the ~2 minute /reporting load.
--
-- FIVE sources, because that is what v_complete_usage's arms can emit:
--   arm 1      attribution_record.ts_event
--   arms 2a/2b unaccounted_usage.day
--   arms 3a/3b v_teammate_usage_daily.day, which is itself
--              actual_spend.date UNION reconciliation_record.period_date
--              (mig 0101) — NOT provider_usage_fact
--   arm 3      joins provider_usage_fact for the per-model split
-- Omitting the two v_teammate_usage_daily sources made the floor LATER than
-- reality when an ingest-only lane started earliest, which HIDES that month
-- from the picker. Earlier is harmless; later is not.
--
-- It lives in a VIEW rather than inline in the handler because the reporting
-- lane must not read attribution_record directly (build-design §7(7),
-- tests/unit/server/reports-lane-firewall).
--
-- COST, stated honestly: these are five plain MINs. unaccounted_usage(day) and
-- actual_spend(date) have leading indexes; the other three are scans. That is
-- linear in table size and still far cheaper than materialising an aggregating
-- union per request. If it becomes the bottleneck at volume, an index is its
-- own change with its own evidence (mig 0118 takes the same position).
--
-- LEAST ignores NULLs — a PostgreSQL-specific behaviour, and the opposite of
-- MySQL/Oracle, so it reads like a bug and has already been reported as one.
-- MEASURED on 16.13: LEAST(MIN(<empty table>), MIN(<populated>)) returns the
-- populated MIN; the result is NULL only when EVERY argument is. An empty
-- source therefore drops out rather than blanking the floor, which
-- tests/integration/reports/regional.test.ts pins. Do not "fix" this into a
-- COALESCE chain.
--
-- security_invoker, like v_complete_usage: the view runs
-- as its caller, so after the RLS cutover the floor is scoped to what that
-- caller can see — the same semantics the reporting lane already has.
CREATE OR REPLACE VIEW v_usage_month_floor
WITH (security_invoker = true) AS
SELECT to_char(
         LEAST(
           (SELECT MIN(ts_event) FROM attribution_record),
           (SELECT MIN(day::timestamp AT TIME ZONE 'UTC') FROM unaccounted_usage),
           (SELECT MIN(date::timestamp AT TIME ZONE 'UTC') FROM provider_usage_fact),
           (SELECT MIN(date::timestamp AT TIME ZONE 'UTC') FROM actual_spend),
           (SELECT MIN(period_date::timestamp AT TIME ZONE 'UTC') FROM reconciliation_record)
         ),
         'YYYY-MM'
       ) AS month_floor;
