// ============================================================
// Provider-neutral inbound pipeline.
//
// Both the Meta webhook and the UAZAPI webhook translate their own
// wire payload into a normalized `InboundMessage` and hand it here.
// This module owns everything downstream of the transport:
//   - find/create the contact + conversation (account-scoped),
//   - reactions (upsert/delete on message_reactions — not a message),
//   - insert the inbound message + bump the conversation,
//   - flag a broadcast reply,
//   - dispatch to the Flows runner, automations, AI auto-reply, and the
//     public webhook fan-out (identical semantics for every provider).
//
// Media resolution stays with each provider (Meta media-id proxying vs
// UAZAPI URLs), so `contentText` / `mediaUrl` / `interactiveReplyId`
// arrive already resolved.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

/** A single inbound message, normalized across providers. */
export interface InboundMessage {
  /** Tenancy key — stamps every contact/conversation/message row. */
  accountId: string;
  /** Audit / sender-of-record for NOT NULL user_id FK columns. */
  configOwnerUserId: string;
  /** Sender's phone, digits only (already normalized). */
  senderPhone: string;
  /**
   * WhatsApp LID (Linked ID), when the sender is only identifiable this
   * way — no real phone number was resolvable (UAZAPI only). Persisted
   * onto the contact so the send path can route via `{lid}@lid` instead
   * of the (bogus, LID-derived) `senderPhone`. Null/absent for Meta and
   * for any contact WhatsApp gave a real phone number for.
   */
  senderWaLid?: string | null;
  /** Display name from the provider (falls back to the phone). */
  senderName: string;
  /** Provider message id → persisted as messages.message_id. */
  providerMessageId: string;
  /** Epoch milliseconds. */
  timestampMs: number;
  /**
   * Raw provider message type ('text' | 'image' | 'video' | 'document'
   * | 'audio' | 'sticker' | 'location' | 'interactive' | 'reaction' | …).
   * Mapped to the messages.content_type CHECK set below.
   */
  type: string;
  contentText: string | null;
  mediaUrl: string | null;
  /** Set when the customer tapped an interactive button/list option. */
  interactiveReplyId: string | null;
  /** Provider id of a quoted/replied-to message, if any. */
  replyToExternalId: string | null;
  /** Present only for reaction events — never inserted as a message. */
  reaction?: { targetExternalId: string; emoji: string } | null;
}

// messages.content_type CHECK (migrations 001 + 010).
const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);

function mapContentType(type: string): string {
  if (ALLOWED_CONTENT_TYPES.has(type)) return type;
  if (type === 'sticker') return 'image'; // stickers are images
  return 'text'; // reaction / unknown → text fallback
}

/**
 * Resolve a provider-side message id into the matching internal UUID,
 * scoped to one conversation. Returns null when the parent was never
 * received (e.g. a reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderId(
  providerId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', providerId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[inbound] lookupInternalIdByProviderId failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

async function handleReaction(
  targetExternalId: string,
  emoji: string,
  conversationId: string,
  contactId: string
) {
  if (!targetExternalId) return;
  const targetInternalId = await lookupInternalIdByProviderId(
    targetExternalId,
    conversationId
  );
  if (!targetInternalId) {
    console.warn('[inbound] reaction target message not found; skipping', targetExternalId);
    return;
  }

  // Empty emoji = removal.
  if (!emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId);
    if (delError) console.error('[inbound] reaction delete failed:', delError.message);
    return;
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    );
  if (upsertError) console.error('[inbound] reaction upsert failed:', upsertError.message);
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied`. Best-effort.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !recs || recs.length === 0) return;
    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id);
    if (updErr) console.error('[inbound] mark broadcast replied failed:', updErr.message);
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny failed:', err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

interface ContactOutcome {
  contact: ContactRow;
  wasCreated: boolean;
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
  waLid?: string | null
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone);
  if (existingContact) {
    const updates: Record<string, unknown> = {};
    if (name && name !== existingContact.name) updates.name = name;
    // Backfill wa_lid on an existing contact once WhatsApp gives us one
    // (e.g. a contact created before this field existed, or one whose
    // LID wasn't known on an earlier message).
    if (waLid && waLid !== existingContact.wa_lid) updates.wa_lid = waLid;
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      await supabaseAdmin().from('contacts').update(updates).eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
      wa_lid: waLid ?? null,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('[inbound] Error creating contact:', createError);
    return null;
  }
  return { contact: newContact, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('[inbound] Error finding conversation:', findError);
    return null;
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contactId })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) return { conversation: raced[0], created: false };
    }
    console.error('[inbound] Error creating conversation:', createError);
    return null;
  }
  return { conversation: newConv, created: true };
}

/**
 * Ingest one normalized inbound message: persist it and fan out to the
 * flows/automations/AI/webhook engines. Provider-agnostic — the caller
 * (Meta or UAZAPI webhook) has already resolved media + content.
 */
export async function ingestInboundMessage(input: InboundMessage): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    senderPhone,
    senderWaLid,
    senderName,
    providerMessageId,
    timestampMs,
    type,
    contentText,
    mediaUrl,
    interactiveReplyId,
    replyToExternalId,
    reaction,
  } = input;

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    senderName,
    senderWaLid
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Emit conversation.created before the reaction short-circuit so a
  // thread first opened by a reaction still fires the event.
  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    });
  }

  // Reactions aren't messages — upsert/delete and return.
  if (reaction) {
    await handleReaction(
      reaction.targetExternalId,
      reaction.emoji,
      conversation.id,
      contactRecord.id
    );
    return;
  }

  // Resolve a swipe-reply parent (missing is fine — store NULL).
  let replyToInternalId: string | null = null;
  if (replyToExternalId) {
    replyToInternalId = await lookupInternalIdByProviderId(
      replyToExternalId,
      conversation.id
    );
  }

  const contentType = mapContentType(type);

  // First-ever inbound from this contact? (Covers manually-added contacts
  // messaging for the first time.) Counted BEFORE the insert.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: providerMessageId,
    status: 'delivered',
    created_at: new Date(timestampMs).toISOString(),
    reply_to_message_id: replyToInternalId,
    interactive_reply_id: interactiveReplyId,
  });
  if (msgError) {
    console.error('[inbound] Error inserting message:', msgError);
    return;
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${type}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);
  if (convError) console.error('[inbound] Error updating conversation:', convError);

  await flagBroadcastReplyIfAny(accountId, contactRecord.id);

  // Flow runner dispatch. If it consumes the message, suppress the
  // content-level automation triggers (new_message_received / keyword_match /
  // interactive_reply) — the customer is navigating a bot menu.
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: providerMessageId,
        }
      : {
          kind: 'text',
          text: contentText ?? '',
          meta_message_id: providerMessageId,
        },
    isFirstInboundMessage,
  });
  const flowConsumed = flowResult.consumed;

  const inboundText = contentText ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    if (interactiveReplyId) automationTriggers.push('interactive_reply');
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');
  // Awaited — not fire-and-forget. This function runs inside the
  // webhook route's `after()`, which only keeps the serverless
  // function alive for promises it can see chained off what it
  // awaits. A detached `runAutomationsForTrigger(...).catch(...)`
  // here is invisible to that guarantee: Vercel can freeze/terminate
  // the instance the moment the awaited chain above resolves, killing
  // the automation mid-run. That produced exactly this symptom — an
  // `automation_logs` row inserted with `status: 'success'` and
  // `steps_executed: []` (the initial insert lands fast) but nothing
  // after it ever runs, so a configured `send_message` step never
  // actually sends and `execution_count` never increments. See
  // issue: "Welcome Message" automation logged success with 0 steps.
  // `runAutomationsForTrigger` is documented to never throw (all
  // errors are caught and logged internally), so awaiting it here
  // adds no new failure mode — it only makes the existing safety net
  // actually cover automations too.
  for (const triggerType of automationTriggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply — only for plain text the flow runner didn't consume.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId,
    });
  }

  // message.received public webhook.
  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: providerMessageId,
    content_type: contentType,
    text: contentText,
  });
}

/** A message the connected number's owner sent directly from their
 *  phone (not through this CRM). */
export interface AgentSentMessage {
  accountId: string;
  configOwnerUserId: string;
  /** The customer's phone, digits only — resolved from the chat/JID,
   *  NOT the message's `sender` (a `fromMe` event reports our own
   *  identity there, not the customer's). */
  customerPhone: string;
  customerName?: string;
  providerMessageId: string;
  timestampMs: number;
  type: string;
  contentText: string | null;
  mediaUrl: string | null;
}

/**
 * Record a message sent directly from the connected WhatsApp phone
 * app — not through this CRM. UAZAPI/Baileys still delivers these as
 * `fromMe: true` webhook events (after `wasSentByApi` rules out
 * echoes of our own API sends). Without this, replying from the phone
 * reaches the customer fine but never appears in the CRM thread, and
 * a teammate reading the inbox has no idea the conversation moved on.
 *
 * `sender_type: 'agent'` matches how a CRM-initiated send is recorded
 * (see send-message.ts) — from the thread's point of view this reads
 * identically to an agent reply, which is what it is.
 */
export async function ingestAgentSentMessage(input: AgentSentMessage): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    customerPhone,
    customerName,
    providerMessageId,
    timestampMs,
    type,
    contentText,
    mediaUrl,
  } = input;

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    customerPhone,
    customerName || customerPhone
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Defense in depth against double-recording: if `wasSentByApi` ever
  // misses on the UAZAPI side, this would otherwise duplicate a
  // message our own send path already persisted (message_id isn't
  // unique in this schema, so a plain insert wouldn't catch it).
  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', providerMessageId)
    .maybeSingle();
  if (existing) return;

  const contentType = mapContentType(type);

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: providerMessageId,
    status: 'sent',
    created_at: new Date(timestampMs).toISOString(),
  });
  if (msgError) {
    console.error('[inbound] Error inserting agent-sent (phone) message:', msgError);
    return;
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${type}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  // Mirror send-message.ts: the agent stepping in — even from their
  // own phone — is the strongest "yield, human is here" signal.
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contactRecord.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[flows] pause-on-agent-send (phone) failed:', pauseErr.message);
    }
  } catch (err) {
    console.error('[flows] pause-on-agent-send (phone) threw:', err);
  }
}

/** One message from a provider's history backfill (UAZAPI's 7-day
 *  sync on a fresh QR connect, or an explicit history-sync request). */
export interface HistoryMessage {
  accountId: string;
  configOwnerUserId: string;
  /** Resolved from the chat/JID — history batches mix both directions
   *  (customer + agent), and `chatid` identifies the conversation
   *  regardless of which side sent a given message. */
  customerPhone: string;
  senderName?: string;
  /** True when this particular message was sent by the connected
   *  number (fromMe), false when the customer sent it. */
  isFromAgent: boolean;
  providerMessageId: string;
  timestampMs: number;
  type: string;
  contentText: string | null;
  mediaUrl: string | null;
}

/**
 * Persist one message from a history backfill — deliberately inert
 * otherwise: no Flows, no automations, no AI auto-reply, no public
 * webhook fan-out.
 *
 * These are messages from BEFORE this CRM connection existed. Routing
 * them through the normal real-time pipeline would fire
 * `first_inbound_message`/`new_contact_created` on a conversation that
 * was actually already in progress — the "Welcome Message sent to an
 * existing contact" bug this function exists to prevent. The one job
 * here is to backfill context so the CRM thread isn't missing
 * everything that happened before the connection.
 */
export async function ingestHistoryMessage(input: HistoryMessage): Promise<void> {
  const {
    accountId,
    configOwnerUserId,
    customerPhone,
    senderName,
    isFromAgent,
    providerMessageId,
    timestampMs,
    type,
    contentText,
    mediaUrl,
  } = input;

  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    customerPhone,
    senderName || customerPhone
  );
  if (!contactOutcome) return;
  const contactRecord = contactOutcome.contact;

  const convResult = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  // Skip anything we've already recorded — history batches routinely
  // overlap with messages the real-time path already captured.
  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', providerMessageId)
    .maybeSingle();
  if (existing) return;

  const contentType = mapContentType(type);
  const createdAtIso = new Date(timestampMs).toISOString();

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: isFromAgent ? 'agent' : 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: providerMessageId,
    status: isFromAgent ? 'sent' : 'delivered',
    created_at: createdAtIso,
  });
  if (msgError) {
    console.error('[inbound] Error inserting history message:', msgError);
    return;
  }

  // Only advance the conversation's preview if this backfilled message
  // is actually more recent than what's there — a history batch can
  // arrive out of order, or entirely predate messages the real-time
  // path already recorded (and already used to set the preview).
  const { data: convRow } = await supabaseAdmin()
    .from('conversations')
    .select('last_message_at')
    .eq('id', conversation.id)
    .maybeSingle();
  const currentLastAt = convRow?.last_message_at
    ? new Date(convRow.last_message_at as string).getTime()
    : 0;
  if (timestampMs > currentLastAt) {
    await supabaseAdmin()
      .from('conversations')
      .update({
        last_message_text: contentText || `[${type}]`,
        last_message_at: createdAtIso,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);
  }
}
