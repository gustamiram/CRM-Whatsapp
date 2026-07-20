-- ============================================================
-- 043_deal_attachment
--
-- Lets a deal carry one file attachment (photo or PDF) alongside its
-- freeform notes — e.g. a signed contract, a reference photo for an
-- event booking. Reuses the same `chat-media` Storage bucket + upload
-- helper already used by automations' send_media step and the inbox
-- composer (account-scoped RLS, PDF + image MIME types allow-listed).
--
-- No RLS change needed: `deals` is already covered by the account-
-- scoped policies from migration 017.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS attachment_filename TEXT;
