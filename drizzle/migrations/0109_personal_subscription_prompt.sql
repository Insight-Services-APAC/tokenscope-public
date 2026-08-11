-- 0109 — likely-personal usage prompts (ADR-0011 D4).
--
-- The usage-reconciliation worker can overlap with an admin backfill, and both
-- may observe the same settled no-bill usage before either inserts its inbox
-- prompt. Keep one prompt per teammate/tool/signal-month at the database layer.
-- The key is intentionally permanent rather than open-item-only: dismissing or
-- resolving a prompt must not make the hourly worker recreate it immediately.
-- A later month remains eligible for a fresh prompt if the signal persists.
CREATE UNIQUE INDEX inbox_personal_subscription_prompt_month_unique
  ON inbox_item (
    recipient_teammate_id,
    ((body ->> 'tool')),
    ((body ->> 'signalMonth'))
  )
  WHERE category = 'personal-subscription-prompt';
