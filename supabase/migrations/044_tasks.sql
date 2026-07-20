-- ============================================================
-- 044_tasks.sql — Tasks (reminders), optionally linked to a deal
--
-- A task is a simple checklist item — "remind about payment", "event
-- reminder", or anything freeform — that can either hang off a deal
-- (deal_id set) or stand alone (deal_id null, e.g. a generic admin
-- reminder). `status` is only ever changed by a human ticking the
-- "mark done" checkbox — it is NOT touched by the automated billing
-- reminder below, so "did we message them" and "is this resolved"
-- stay two separate questions.
--
-- The `billing` task_type is the one synced with the AI agent: when
-- src/lib/tasks/engine.ts's processDueBillingTasks() finds one past
-- due with no reminder sent yet, it drafts and sends a payment
-- reminder to the task's contact. `reminder_sent_at`/`reminder_status`
-- track that side effect independently of `status`, and gate the
-- poller to send at most once per due occurrence.
--
-- RLS mirrors ai_media_rules (040): any account member reads; agent+
-- writes (tasks are operational, not an admin-only setting, unlike
-- ai_media_rules).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deal_id           uuid REFERENCES deals(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  title             text NOT NULL,
  notes             text,
  task_type         text NOT NULL DEFAULT 'general'
                      CHECK (task_type IN ('general', 'event_reminder', 'billing')),
  due_at            timestamptz,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  completed_at      timestamptz,
  reminder_sent_at  timestamptz,
  reminder_status   text CHECK (reminder_status IN ('sent', 'blocked_window', 'failed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_account_id_idx ON tasks (account_id);
CREATE INDEX IF NOT EXISTS tasks_deal_id_idx ON tasks (deal_id);
-- Poller lookup: due, pending, not-yet-reminded billing tasks.
CREATE INDEX IF NOT EXISTS tasks_due_billing_idx
  ON tasks (due_at)
  WHERE task_type = 'billing' AND status = 'pending' AND reminder_sent_at IS NULL;
-- General "what's due" listing for the dashboard panel.
CREATE INDEX IF NOT EXISTS tasks_account_status_due_idx
  ON tasks (account_id, status, due_at);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (is_account_member(account_id, 'agent'));

CREATE OR REPLACE FUNCTION public.update_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_tasks_updated_at();
