-- 0139 — audit_event (ts_recorded DESC, id DESC) for the admin Audit log page.
-- Consumer: server/api/v1/admin/audit/index.get.ts, whose DEFAULT query has no
-- WHERE clause and runs `ORDER BY ae.ts_recorded DESC, ae.id DESC LIMIT 50` —
-- every existing audit_event index (0001) leads on a filter column, so the
-- unfiltered newest-first page sorts the whole table. Design:
-- docs/design/admin-nav-responsiveness.md (D5).
--
-- LOCK WINDOW: plain CREATE INDEX holds SHARE on audit_event for the WHOLE
-- build — reads proceed, every INSERT waits until the index exists. CREATE
-- INDEX CONCURRENTLY cannot be used: drizzle/migrate.ts runs each file inside
-- one transaction and CONCURRENTLY refuses to run in one. audit_event is the
-- table this index exists to sort, so it is not small: the build is a scan and
-- sort of the full history, and its duration grows with the table. What waits
-- during it is every recordAuditEvent writer — admin mutations, auth/OAuth/
-- setup flows, instance end and the worker runs that audit their outcome — a
-- build-duration pause of those writes, not an outage of anything read, and
-- acceptable at this table's size. lock_timeout bounds only lock ACQUISITION:
-- if a writer holds the table when this runs, the migration aborts and retries
-- at the next deploy rather than queuing; it does not shorten the build once
-- the lock is held. The audit handler's COUNT(*) (audit/index.get.ts) is still
-- O(N) and out of scope here.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS audit_event_recorded_desc
  ON audit_event (ts_recorded DESC, id DESC);

ANALYZE audit_event;
