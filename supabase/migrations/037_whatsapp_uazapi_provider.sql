-- ============================================================
-- 037: WhatsApp provider abstraction — add UAZAPI (QR-code) as a
-- second provider alongside the official Meta Cloud API.
--
-- Until now `whatsapp_config` was Meta-only: one row per account with
-- `phone_number_id` + `access_token` NOT NULL. UAZAPI connects by
-- scanning a QR code and has none of those Meta identifiers — it uses a
-- server base URL + an admin token (to create the instance) + a
-- per-instance token (to connect/send). We keep ONE row per account
-- (UNIQUE(account_id) from migration 017) and add a `provider`
-- discriminator that decides which set of columns is active. Storing
-- both providers' columns side by side lets a user switch providers
-- without re-entering the other's credentials.
-- ============================================================

-- Provider discriminator. Defaults to 'meta' so every existing row keeps
-- its current (Meta) behaviour with no data migration.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'uazapi'));

-- A UAZAPI row has neither of these Meta identifiers, so they can no
-- longer be NOT NULL. The Meta save path still requires them at the
-- application layer; this only relaxes the DB constraint so a UAZAPI
-- row (provider='uazapi', phone_number_id/access_token NULL) is valid.
-- UNIQUE(phone_number_id) from migration 013 is unaffected — Postgres
-- treats multiple NULLs as distinct, so many UAZAPI rows coexist.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- UAZAPI-specific columns (all nullable; only populated for
-- provider='uazapi'). Tokens are stored AES-256-GCM-encrypted with the
-- same encrypt()/decrypt() helper used for Meta's access_token, keyed on
-- ENCRYPTION_KEY.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_base_url        TEXT, -- e.g. https://api.uazapi.com
  ADD COLUMN IF NOT EXISTS uazapi_admin_token     TEXT, -- encrypted: creates/manages the instance
  ADD COLUMN IF NOT EXISTS uazapi_instance_id     TEXT, -- instance id returned by /instance/create
  ADD COLUMN IF NOT EXISTS uazapi_instance_token  TEXT, -- encrypted: per-instance token for connect/send/webhook
  ADD COLUMN IF NOT EXISTS uazapi_webhook_secret  TEXT, -- unguessable token that identifies the account in the inbound webhook URL (tenancy; UAZAPI does not sign payloads)
  ADD COLUMN IF NOT EXISTS uazapi_status          TEXT, -- disconnected | connecting | connected | hibernated
  ADD COLUMN IF NOT EXISTS uazapi_profile_name    TEXT, -- WhatsApp profile name (from /instance/status once connected)
  ADD COLUMN IF NOT EXISTS uazapi_phone           TEXT; -- connected number, for display

-- The webhook secret is looked up on every inbound UAZAPI POST to resolve
-- the owning account — index it. Partial (only UAZAPI rows have one).
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_uazapi_webhook_secret_idx
  ON whatsapp_config (uazapi_webhook_secret)
  WHERE uazapi_webhook_secret IS NOT NULL;
