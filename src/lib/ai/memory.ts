import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { generateReply } from './generate'

/**
 * Rolling long-term memory for a conversation, scoped to
 * `conversations.id` (same scope `buildConversationContext` already
 * uses for the recent-messages window).
 *
 * The reply-time context in src/lib/ai/context.ts only ever sees the
 * last `aiContextMessageLimit()` text messages, re-read fresh on every
 * call — nothing before that window is visible to the model. This
 * module fills that gap: `ai_memory_summary` is an LLM-maintained,
 * ever-updated compaction of everything older than the current
 * window, and `ai_memory_synced_count` tracks how many of the
 * conversation's oldest text messages are already folded into it.
 *
 * Refreshed in batches (not on every message) to bound LLM cost —
 * see `refreshConversationMemoryIfDue`.
 */

const DEFAULT_REFRESH_BATCH = 10

/** New scrolled-out messages required before paying for another
 *  summarization call. Override with `AI_MEMORY_REFRESH_BATCH`. */
function memoryRefreshBatchSize(): number {
  const raw = Number(process.env.AI_MEMORY_REFRESH_BATCH)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_REFRESH_BATCH
}

/** Plain read — used wherever a prompt is built (auto-reply, and the
 *  billing/proposal-followup task sends) so a long-gap message still
 *  carries whatever the conversation last established. */
export async function getConversationMemory(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await db
    .from('conversations')
    .select('ai_memory_summary')
    .eq('id', conversationId)
    .maybeSingle()
  return (data?.ai_memory_summary as string | null) ?? null
}

/**
 * Fire-and-forget, never throws (same contract as `logAiUsage`) — call
 * after a reply send so summarization never adds latency to the
 * customer-facing message.
 */
export async function refreshConversationMemoryIfDue(
  db: SupabaseClient,
  config: AiConfig,
  conversationId: string,
  contextLimit: number,
): Promise<void> {
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('ai_memory_summary, ai_memory_synced_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv) return

    const syncedCount = (conv.ai_memory_synced_count as number) ?? 0

    const { count: totalCount } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .eq('content_type', 'text')
    if (totalCount == null) return

    // How many old messages currently sit outside the recent-messages
    // window the reply prompt actually sees.
    const pendingCutoff = totalCount - contextLimit
    if (pendingCutoff <= 0) return // nothing has scrolled out yet
    const batchSize = memoryRefreshBatchSize()
    if (pendingCutoff - syncedCount < batchSize) return // not enough new material yet

    // The chunk that's about to (or already did) scroll out of the
    // window and isn't summarized yet: [syncedCount, pendingCutoff).
    const { data: rows, error } = await db
      .from('messages')
      .select('sender_type, content_text')
      .eq('conversation_id', conversationId)
      .eq('content_type', 'text')
      .order('created_at', { ascending: true })
      .range(syncedCount, pendingCutoff - 1)
    if (error || !rows || rows.length === 0) return

    const transcript = (rows as { sender_type: string; content_text: string | null }[])
      .filter((r) => r.content_text && r.content_text.trim())
      .map((r) => `${r.sender_type === 'customer' ? 'Customer' : 'Business'}: ${r.content_text!.trim()}`)
      .join('\n')
    if (!transcript) return

    const previousSummary = (conv.ai_memory_summary as string | null) ?? null
    const systemPrompt = buildMemorySummaryPrompt(previousSummary, transcript)

    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: 'Write the updated memory summary now.' }],
    })
    if (!text.trim()) return

    await db
      .from('conversations')
      .update({
        ai_memory_summary: text.trim(),
        ai_memory_updated_at: new Date().toISOString(),
        ai_memory_synced_count: pendingCutoff,
      })
      .eq('id', conversationId)
  } catch (err) {
    console.error('[ai memory] refresh failed:', conversationId, err)
  }
}

function buildMemorySummaryPrompt(previousSummary: string | null, transcript: string): string {
  return [
    'You maintain a compact, factual memory of an ongoing WhatsApp customer conversation for a business\'s AI assistant. You are given the previous memory (if any) and a new chunk of the conversation transcript that is about to scroll out of the assistant\'s visible context. Write the updated memory: a short, dense list of durable facts, preferences, commitments, and open items worth recalling weeks later. Merge the new chunk into the previous memory rather than replacing it — drop anything no longer relevant, keep anything still open or useful. Do not include pleasantries or small talk. Output only the updated memory text — no headers, no preamble, no quotes.',
    previousSummary ? `Previous memory:\n${previousSummary}` : 'Previous memory: (none yet)',
    `New transcript chunk, oldest first:\n${transcript}`,
  ].join('\n\n')
}
