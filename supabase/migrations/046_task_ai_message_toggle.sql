-- ============================================================
-- 046_task_ai_message_toggle.sql
--
-- Per-task on/off switch for the AI-auto-send poller
-- (src/lib/tasks/engine.ts's processDueBillingTasks /
-- processDueProposalFollowupTasks). Until now, every `billing` or
-- `proposal_followup` task was unconditionally picked up once due —
-- this lets the user pre-empt that per task (e.g. "I'll handle this
-- collection myself, don't let the AI message this customer") while
-- still keeping the task itself as a plain reminder.
--
-- Defaults to true so every existing billing/proposal_followup task
-- keeps behaving exactly as it did before this migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS ai_message_enabled BOOLEAN NOT NULL DEFAULT true;

DROP INDEX IF EXISTS tasks_due_ai_message_idx;
CREATE INDEX IF NOT EXISTS tasks_due_ai_message_idx
  ON tasks (due_at)
  WHERE task_type IN ('billing', 'proposal_followup')
    AND status = 'pending'
    AND reminder_sent_at IS NULL
    AND ai_message_enabled = true;
