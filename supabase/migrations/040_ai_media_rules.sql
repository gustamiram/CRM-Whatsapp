-- ============================================================
-- 040_ai_media_rules.sql — AI Agents keyword → media (file + voice
-- note) rules
--
-- Dedicated to the AI Agents module (Settings > Agentes de IA), kept
-- independent from the Automations module's own `send_media` step
-- type (added in the same feature) — the user explicitly wants both
-- modules usable on their own, even though they overlap in purpose.
--
-- When a customer's inbound message matches one of these rules, the
-- AI auto-reply dispatcher (src/lib/ai/auto-reply.ts) sends the
-- configured document/image + audio pair instead of generating an LLM
-- reply for that message. `document_url` and `audio_url` are NOT NULL
-- — a rule only exists once both files are attached, matching "the
-- file is always a PDF/image plus an audio."
--
-- RLS mirrors ai_knowledge_documents (030_ai_knowledge.sql): any
-- account member may read (auto-reply reads via the service-role
-- client anyway), only admin+ may write.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_media_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name               text NOT NULL,
  keywords           text[] NOT NULL,
  match_type         text NOT NULL DEFAULT 'contains' CHECK (match_type IN ('exact', 'contains')),
  case_sensitive     boolean NOT NULL DEFAULT false,
  document_url       text NOT NULL,
  document_kind      text NOT NULL CHECK (document_kind IN ('image', 'document')),
  document_filename  text,
  audio_url          text NOT NULL,
  audio_filename     text,
  is_active          boolean NOT NULL DEFAULT true,
  position           integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_media_rules_account_id_idx
  ON ai_media_rules (account_id);

ALTER TABLE ai_media_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_media_rules_select ON ai_media_rules;
CREATE POLICY ai_media_rules_select ON ai_media_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS ai_media_rules_insert ON ai_media_rules;
CREATE POLICY ai_media_rules_insert ON ai_media_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_media_rules_update ON ai_media_rules;
CREATE POLICY ai_media_rules_update ON ai_media_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS ai_media_rules_delete ON ai_media_rules;
CREATE POLICY ai_media_rules_delete ON ai_media_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_ai_media_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_media_rules_updated_at ON ai_media_rules;
CREATE TRIGGER ai_media_rules_updated_at
  BEFORE UPDATE ON ai_media_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_media_rules_updated_at();
