-- 0033: hard invariant — at most ONE live emit credential per device.
--
-- provision_emit→redeem (issueInstanceEmitCredential) rotates-and-revokes the
-- prior emit credential for an instance before minting a new one, so a device
-- never accumulates credentials (mcp-client-backbone §F2.3). The rotate is
-- serialized by a per-instance advisory lock, but this partial-unique index is
-- the durable DB-level backstop (so a future code path that forgets the lock, or
-- a concurrent redeem race, can't leave two live emit credentials bound to one
-- instance — adversarial R2 F1). Only constrains instance-bound LIVE emit rows;
-- read/tag grants and legacy (instance_id NULL) emit grants are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_token_one_live_emit_per_instance
  ON oauth_token (instance_id)
  WHERE instance_id IS NOT NULL AND revoked_at IS NULL AND scope = 'tokenscope.emit';
