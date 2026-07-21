import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { retrieveUpcomingEvents } from './events'
import { generateReply } from './generate'
import { buildSystemPrompt, aiContextMessageLimit } from './defaults'
import { getConversationMemory, refreshConversationMemoryIfDue } from './memory'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { findMatchingAiMediaRule, sendAiMediaRule } from './media-rules'
import { engineSendText } from '@/lib/flows/meta-send'
import { triggerMatches } from '@/lib/automations/engine'
import type { Automation } from '@/types'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Provider message id of the inbound that triggered this dispatch.
   *  Drives the debounce: after the configured delay, if this is no
   *  longer the conversation's newest customer message, this dispatch
   *  stands down and the newer message's own dispatch replies instead
   *  — with every message in context. */
  triggerProviderMessageId?: string | null
  /** Raw text of the inbound message that triggered this dispatch. Used
   *  to check the account's keyword → media rules (ai_media_rules)
   *  before falling back to the LLM — see the media-rule check below. */
  triggerMessageText?: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    triggerProviderMessageId,
    triggerMessageText,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Debounce. Customers routinely split one thought across several
    // quick messages; replying the instant the first lands means the
    // answer ignores what they're still typing. Wait the configured
    // delay, then check whether the triggering message is still the
    // newest customer message — if something newer arrived, stand down:
    // that message's own dispatch (running the same wait) replies once,
    // with the whole burst in context because `buildConversationContext`
    // below runs AFTER this wait.
    //
    // The sleep runs inside the webhook route's `after()` and is awaited
    // all the way up, so the serverless function stays alive through it
    // (the delay cap of 30s + LLM + send fits the route's maxDuration
    // of 60s). Every conversation-state gate below (agent assigned,
    // auto-reply switched off, reply cap) intentionally runs after the
    // wait, so a human stepping in during the delay also stops the bot.
    const delaySeconds = config.autoReplyDelaySeconds ?? 0
    if (delaySeconds > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(delaySeconds, 30) * 1000),
      )
      if (triggerProviderMessageId) {
        // Tie-break by id so two dispatches racing on equal timestamps
        // (Meta delivers second-precision) both resolve the same row —
        // exactly one of them proceeds.
        const { data: newest } = await db
          .from('messages')
          .select('message_id')
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'customer')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (newest?.message_id && newest.message_id !== triggerProviderMessageId) {
          return // a newer customer message owns the reply
        }
      }
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so stand down when one actually matches this message
    // (`triggerMatches` returns true unconditionally for
    // `new_message_received`, same as before; for `keyword_match` it only
    // matches when the keywords are actually present). This is a strict
    // refinement of the previous "stand down if any such automation is
    // merely active" check — it no longer mutes the bot account-wide for
    // every message just because one unrelated keyword automation exists
    // (e.g. a keyword-triggered media-send automation). (Relationship
    // triggers like `first_inbound_message` don't count — they're not
    // per-message auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
    if (
      autoResponders &&
      (autoResponders as Automation[]).some((a) =>
        triggerMatches(a, { message_text: triggerMessageText ?? '' }),
      )
    ) {
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // AI Agents' own keyword → media rules (Settings > Agentes de IA,
    // ai_media_rules — independent of the Automations module's
    // send_media step type). Checked before the LLM path: a matching
    // rule sends its document/image + voice note and skips generation
    // entirely, so no LLM/embeddings call is spent when a deterministic
    // rule already answers the message.
    const matchedRule = await findMatchingAiMediaRule(
      db,
      accountId,
      triggerMessageText ?? '',
    )
    if (matchedRule) {
      const { data: claimed, error: claimErr } = await db.rpc(
        'claim_ai_reply_slot',
        {
          conversation_id: conversationId,
          max_replies: config.autoReplyMaxPerConversation,
        },
      )
      if (claimErr) {
        console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
        return
      }
      if (claimed !== true) return // lost the per-conversation cap race
      await sendAiMediaRule(matchedRule, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
      })
      return
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Booked events (deals.expected_close_date) so the model can answer
    // "is <date/time> free?" without inventing availability.
    const events = await retrieveUpcomingEvents(db, accountId)

    // Rolling long-term summary covering whatever has already scrolled
    // out of `messages`' recent-messages window (see src/lib/ai/memory.ts)
    // — keeps a long conversation's earlier context alive indefinitely.
    const memory = await getConversationMemory(db, conversationId)

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      events,
      memory,
    })

    const { text, handoff, usage } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // Fire-and-forget: never adds latency to the customer-facing send,
    // and internally no-ops unless enough new messages have scrolled
    // out of the recent-messages window to justify another LLM call.
    void refreshConversationMemoryIfDue(db, config, conversationId, aiContextMessageLimit())
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
