-- ============================================================
-- 039: AI auto-reply debounce delay.
--
-- Customers often split one thought across several quick messages
-- ("oi" … "queria saber o preço" … "do pacote de casamento"). The bot
-- previously generated its reply the instant the FIRST message
-- arrived, so the answer ignored everything the customer was still
-- typing.
--
-- `auto_reply_delay_seconds` is how long the bot waits after an
-- inbound message before generating. If another customer message
-- lands during the wait, the earlier dispatch aborts and the newest
-- message's own dispatch replies — with the full conversation context
-- (all messages) loaded after the wait. See
-- src/lib/ai/auto-reply.ts.
--
-- Capped at 30s: the webhook route's serverless budget (maxDuration
-- 60s) must also cover the LLM call and the outbound send after the
-- wait.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_delay_seconds integer NOT NULL DEFAULT 10
    CHECK (auto_reply_delay_seconds BETWEEN 0 AND 30);
