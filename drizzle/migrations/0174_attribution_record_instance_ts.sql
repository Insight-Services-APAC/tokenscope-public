-- 0174: the parent index over 0173's per-partition indexes (#619, #611).
--
-- ON ONLY creates the parent index without building anything (invalid until
-- every partition's index is attached). Each partition's 0173 index is then
-- attached; ATTACH changes catalog rows only. A partition with no index yet
-- (one created after 0173 ran) gets it built here, in this transaction. Only
-- such a partition can need it, and nothing in the app creates partitions
-- (0055 made them through 2027-12, plus the default).
--
-- Locks: ON ONLY takes SHARE on attribution_record until this transaction
-- commits, so inserts wait for it: the catalog work of ~32 attaches, plus any
-- build above (which would hold every insert, not only that partition's).
--
-- Once all are attached the parent index is valid, and a partition created
-- later gets the index from it. The DO block at the end refuses to finish with
-- the parent index still invalid.
CREATE INDEX IF NOT EXISTS attribution_record_instance_ts
  ON ONLY attribution_record (instance_id, ts_event) INCLUDE (cost_usd);

DO $$
DECLARE part text;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'attribution_record'::regclass AND c.relkind = 'r'
     ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (instance_id, ts_event) INCLUDE (cost_usd)',
                   part || '_instance_ts', part);
    IF NOT EXISTS (SELECT 1 FROM pg_inherits ii
                    WHERE ii.inhrelid = (quote_ident(part || '_instance_ts'))::regclass
                      AND ii.inhparent = 'attribution_record_instance_ts'::regclass) THEN
      EXECUTE format('ALTER INDEX attribution_record_instance_ts ATTACH PARTITION %I', part || '_instance_ts');
    END IF;
  END LOOP;

  IF NOT (SELECT x.indisvalid FROM pg_index x
           WHERE x.indexrelid = 'attribution_record_instance_ts'::regclass) THEN
    RAISE EXCEPTION '0174: attribution_record_instance_ts is still invalid after attaching every partition';
  END IF;
END $$;
