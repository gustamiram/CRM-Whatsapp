-- ============================================================
-- 045_conversation_memory_and_proposal_followup.sql
--
-- Two additions:
--
-- 1. Conversation memory — the AI's reply context today is just the
--    last N text messages (see src/lib/ai/context.ts's
--    aiContextMessageLimit(), default 20), re-read fresh on every
--    call. Nothing is retained beyond that rolling window, so a long
--    conversation silently loses its older turns. `ai_memory_summary`
--    holds a rolling, LLM-maintained compaction of everything older
--    than the current window; `ai_memory_synced_count` tracks how
--    many of the conversation's oldest text messages are already
--    folded into it, so src/lib/ai/memory.ts knows how much new
--    material to fold in next time. See that file for the refresh
--    logic (batched — not recomputed on every message).
--
-- 2. `proposal_followup` task type — a second AI-auto-send task type
--    alongside `billing` (migration 044), generalizing
--    src/lib/tasks/engine.ts's poller: instead of a payment reminder,
--    it asks the customer what they thought of a proposal, on a
--    user-configured due date.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_memory_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_memory_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_memory_synced_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_type_check
  CHECK (task_type IN ('general', 'event_reminder', 'billing', 'proposal_followup'));

-- Replaces 044's billing-only partial index — the poller now selects
-- both AI-auto-send task types the same way.
DROP INDEX IF EXISTS tasks_due_billing_idx;
CREATE INDEX IF NOT EXISTS tasks_due_ai_message_idx
  ON tasks (due_at)
  WHERE task_type IN ('billing', 'proposal_followup') AND status = 'pending' AND reminder_sent_at IS NULL;
