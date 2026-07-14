-- R2: the teammate_identity_map uniqueness backstop must be case-INSENSITIVE
-- to match the case-insensitive read path (resolveMyEmails lowercases; the
-- reader matches with KQL `in~`). With a case-sensitive index, 'Foo@x.com' and
-- 'foo@x.com' could coexist on two teammates and both resolve to the same
-- ownership set — the "one identity maps to at most one teammate" invariant
-- the attribution trust model relies on would not hold. (adversarial-review R2)

-- Collapse any case-variant duplicates first (keep one row per
-- (system, lower(identifier)); the surviving row is the highest id).
DELETE FROM teammate_identity_map a
USING teammate_identity_map b
WHERE a.id < b.id
  AND a.system = b.system
  AND lower(a.identifier) = lower(b.identifier);

DROP INDEX IF EXISTS teammate_identity_map_identity_unique;
CREATE UNIQUE INDEX IF NOT EXISTS teammate_identity_map_identity_unique
  ON teammate_identity_map (system, lower(identifier));
