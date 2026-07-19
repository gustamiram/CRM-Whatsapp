-- ============================================================
-- 041_account_default_pipeline
--
-- Lets an account designate one pipeline as the "default pipeline for
-- new contacts": the first time a contact's conversation is created
-- (findOrCreateConversation in src/lib/whatsapp/inbound-core.ts — this
-- fires exactly once per contact, ever, per the unique
-- (account_id, contact_id) constraint from migration 036), a deal is
-- auto-created for that contact in this pipeline's first stage
-- (lowest pipeline_stages.position).
--
-- NULL means the feature is off — no separate enable/disable toggle
-- needed. ON DELETE SET NULL so deleting the pipeline just turns the
-- feature off rather than blocking the delete or orphaning a dangling
-- reference.
--
-- RLS: no change needed. The existing `accounts_update` policy (017)
-- already restricts writes to admins+, matching default_currency (021).
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS default_pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL;
