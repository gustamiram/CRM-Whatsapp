-- ============================================================
-- 042_deal_event_datetime
--
-- Repurpose `deals.expected_close_date` (previously a date-only,
-- purely cosmetic field — no query, report, or automation reads it)
-- into an event date + time. Businesses using this CRM to book
-- appointments/events can now record the exact slot (e.g.
-- 2026-10-02 14:00), which the new Dashboard events calendar and the
-- AI auto-reply agent's availability check both read.
--
-- Widening DATE -> TIMESTAMPTZ is lossless: existing values become
-- midnight UTC on the same calendar day.
-- ============================================================

ALTER TABLE deals
  ALTER COLUMN expected_close_date TYPE TIMESTAMPTZ
  USING (expected_close_date AT TIME ZONE 'UTC');
