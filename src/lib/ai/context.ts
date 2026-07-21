import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  /** One-time image caption / voice-note transcript, cached at
   *  ingestion — see src/lib/ai/media-interpret.ts. */
  ai_media_description: string | null
}

/**
 * Fetch the last N text-bearing messages of a conversation and map them
 * to the provider-neutral chat shape. Customer messages become `user`;
 * agent and bot messages become `assistant`.
 *
 * `text` rows use `content_text` as before. `image`/`audio` rows use
 * `ai_media_description` instead — the model never sees the media
 * itself, only its cached interpretation (already prefixed so it reads
 * as a media summary, not a literal quote) — rows with neither (AI
 * wasn't configured when the message arrived, or interpretation
 * failed) are dropped, same as an empty text message. Video/document
 * messages carry no text to model and stay excluded entirely.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, ai_media_description')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'image', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  const messages: ChatMessage[] = []
  for (const m of rows) {
    const content = m.content_type === 'text' ? m.content_text : m.ai_media_description
    if (!content || !content.trim()) continue
    messages.push({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: content.trim(),
    })
  }
  return messages
}
