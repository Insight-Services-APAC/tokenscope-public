-- TokenScope migration prelude — required PostgreSQL extensions.
--
-- Per docs/design/data-model.md §Required PostgreSQL extensions: this MUST
-- run before any table DDL. Drizzle-generated migrations diff schema vs
-- existing DB; they don't know about extensions.
--
-- btree_gist  — enables EXCLUDE USING gist on (text WITH =, range WITH &&)
-- ltree       — org_unit.path materialised-path queries
-- pgcrypto    — gen_random_uuid() on UUID primary keys

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
