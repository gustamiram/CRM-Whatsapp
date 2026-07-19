import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendMedia } from '@/lib/flows/meta-send'

/**
 * A row from `ai_media_rules` (migration 040) — the AI Agents module's own
 * keyword → media-send list. Kept independent from the Automations
 * module's `send_media` step type by design: the user wants both modules
 * usable on their own, even though the two overlap in purpose.
 */
export interface AiMediaRule {
  id: string
  name: string
  keywords: string[]
  match_type: 'exact' | 'contains'
  case_sensitive: boolean
  document_url: string
  document_kind: 'image' | 'document'
  document_filename: string | null
  audio_url: string
  audio_filename: string | null
  is_active: boolean
  position: number
}

/**
 * Find the first active rule whose keywords match `messageText`, ordered
 * by `position`. Same substring/exact matching semantics as the
 * Automations engine's `triggerMatches` keyword_match branch
 * (src/lib/automations/engine.ts) — reimplemented here rather than
 * imported so this module stays independent of the automations engine.
 */
export async function findMatchingAiMediaRule(
  db: SupabaseClient,
  accountId: string,
  messageText: string,
): Promise<AiMediaRule | null> {
  const text = messageText.trim()
  if (!text) return null

  const { data: rules, error } = await db
    .from('ai_media_rules')
    .select(
      'id, name, keywords, match_type, case_sensitive, document_url, document_kind, document_filename, audio_url, audio_filename, is_active, position',
    )
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position', { ascending: true })

  if (error || !rules) return null

  for (const rule of rules as AiMediaRule[]) {
    if (!rule.keywords || rule.keywords.length === 0) continue
    const haystack = rule.case_sensitive ? text : text.toLowerCase()
    const matched = rule.keywords.some((raw) => {
      const k = rule.case_sensitive ? raw : raw.toLowerCase()
      return rule.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
    if (matched) return rule
  }
  return null
}

/**
 * Send a matched rule's document/image + audio (as a native voice note)
 * in order. Marks both sends `ai_generated` so the inbox badges them like
 * an AI text reply.
 */
export async function sendAiMediaRule(
  rule: AiMediaRule,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
  },
): Promise<void> {
  await engineSendMedia({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: rule.document_kind,
    link: rule.document_url,
    filename: rule.document_filename ?? undefined,
    aiGenerated: true,
  })

  // No caption/filename on the audio send — required for both Meta and
  // UAZAPI (via its 'ptt' mapping) to render a native voice-note bubble
  // rather than a generic/forwarded-looking attachment.
  await engineSendMedia({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: 'audio',
    link: rule.audio_url,
    aiGenerated: true,
  })
}
