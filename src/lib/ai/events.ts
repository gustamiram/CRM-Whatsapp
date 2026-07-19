import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Booked-event availability check for the AI agent.
//
// `deals.expected_close_date` was repurposed (migration 042) into an
// event date + time — e.g. a business booking appointments through the
// CRM. This surfaces the account's upcoming booked slots as plain text
// so the auto-reply / draft system prompt can answer "is <date/time>
// free?" without inventing an answer. Same best-effort contract as
// `retrieveKnowledge`: any failure degrades to [] and never throws into
// the send path.
// ============================================================

interface EventRow {
  title: string
  expected_close_date: string
  contacts: { name: string | null }[] | { name: string | null } | null
}

/**
 * Upcoming (future, non-lost) booked events for `accountId`, formatted
 * as one line each: "<title> — <weekday>, <date> <time>". Bounded to
 * `limit` so the prompt stays a reasonable size.
 */
export async function retrieveUpcomingEvents(
  db: SupabaseClient,
  accountId: string,
  limit = 50,
): Promise<string[]> {
  try {
    const { data, error } = await db
      .from('deals')
      .select('title, expected_close_date, contacts(name)')
      .eq('account_id', accountId)
      .not('expected_close_date', 'is', null)
      .neq('status', 'lost')
      .gte('expected_close_date', new Date().toISOString())
      .order('expected_close_date', { ascending: true })
      .limit(limit)
    if (error || !data) return []

    return (data as unknown as EventRow[]).map((row) => {
      const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts
      const when = new Date(row.expected_close_date).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
      return contact?.name
        ? `${row.title} (${contact.name}) — ${when}`
        : `${row.title} — ${when}`
    })
  } catch (err) {
    console.error('[ai events] retrieval failed:', err)
    return []
  }
}
