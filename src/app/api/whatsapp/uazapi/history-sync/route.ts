import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  findMessages,
  requestHistorySync,
  type UazapiMessage,
} from '@/lib/whatsapp/uazapi-api';
import { loadUazapiConfig } from '@/lib/whatsapp/uazapi-config';
import {
  normalizeUazapiHistoryMessage,
  type UazapiHistoryMessageRow,
} from '@/lib/whatsapp/uazapi-history';

export const maxDuration = 60;

const PAGE_SIZE = 100;
const MAX_MESSAGES_PER_SYNC = 2_000;

interface HistorySyncBody {
  conversation_id?: unknown;
}

interface ConversationContact {
  phone?: string | null;
  wa_lid?: string | null;
}

interface ConversationRecord {
  id: string;
  last_message_at?: string | null;
  contact: ConversationContact | null;
}

interface StoredMessagesResult {
  messages: UazapiMessage[];
  scanned: number;
  truncated: boolean;
}

async function loadStoredMessages(args: {
  baseUrl: string;
  instanceToken: string;
  chatJid: string;
}): Promise<StoredMessagesResult> {
  const messages: UazapiMessage[] = [];
  let offset = 0;
  let scanned = 0;
  let providerHasMore = false;

  while (scanned < MAX_MESSAGES_PER_SYNC) {
    const page = await findMessages({
      baseUrl: args.baseUrl,
      instanceToken: args.instanceToken,
      chatId: args.chatJid,
      limit: Math.min(PAGE_SIZE, MAX_MESSAGES_PER_SYNC - scanned),
      offset,
    });

    messages.push(...page.messages);
    scanned += page.messages.length;
    providerHasMore = page.hasMore;

    if (!page.hasMore || page.returnedMessages === 0) break;
    if (page.nextOffset <= offset) {
      console.warn(
        '[uazapi/history-sync] provider returned a non-advancing offset'
      );
      break;
    }
    offset = page.nextOffset;
  }

  return {
    messages,
    scanned,
    truncated: providerHasMore && scanned >= MAX_MESSAGES_PER_SYNC,
  };
}

async function importMissingMessages(args: {
  supabase: AccountContext['supabase'];
  conversation: ConversationRecord;
  chatJid: string;
  messages: UazapiMessage[];
}): Promise<{ imported: number; skipped: number }> {
  const normalizedById = new Map<string, UazapiHistoryMessageRow>();
  let skipped = 0;

  for (const message of args.messages) {
    const normalized = normalizeUazapiHistoryMessage(message, args.chatJid);
    if (!normalized) {
      skipped += 1;
      continue;
    }
    normalizedById.set(normalized.message_id, normalized);
  }

  const normalized = [...normalizedById.values()];
  let imported = 0;
  let newestImported: UazapiHistoryMessageRow | null = null;

  for (let start = 0; start < normalized.length; start += PAGE_SIZE) {
    const page = normalized.slice(start, start + PAGE_SIZE);
    const messageIds = page.map((message) => message.message_id);
    const { data: existing, error: existingError } = await args.supabase
      .from('messages')
      .select('message_id')
      .eq('conversation_id', args.conversation.id)
      .in('message_id', messageIds);

    if (existingError) {
      throw new Error(
        `Failed to check existing messages: ${existingError.message}`
      );
    }

    const existingIds = new Set(
      (existing ?? [])
        .map((message) => message.message_id)
        .filter((messageId): messageId is string => Boolean(messageId))
    );
    const missing = page
      .filter((message) => !existingIds.has(message.message_id))
      .map((message) => ({
        conversation_id: args.conversation.id,
        ...message,
      }));

    if (missing.length === 0) continue;
    const { error: insertError } = await args.supabase
      .from('messages')
      .insert(missing);
    if (insertError) {
      throw new Error(`Failed to import messages: ${insertError.message}`);
    }

    imported += missing.length;
    for (const row of missing) {
      if (
        !newestImported ||
        new Date(row.created_at).getTime() >
          new Date(newestImported.created_at).getTime()
      ) {
        newestImported = row;
      }
    }
  }

  const currentLastAt = args.conversation.last_message_at
    ? new Date(args.conversation.last_message_at).getTime()
    : 0;
  if (
    newestImported &&
    new Date(newestImported.created_at).getTime() > currentLastAt
  ) {
    const { error: previewError } = await args.supabase
      .from('conversations')
      .update({
        last_message_text:
          newestImported.content_text || `[${newestImported.content_type}]`,
        last_message_at: newestImported.created_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.conversation.id);
    if (previewError) {
      console.error(
        '[uazapi/history-sync] conversation preview update failed:',
        previewError.message
      );
    }
  }

  return { imported, skipped };
}

/**
 * Imports messages already stored by UAZAPI for the selected inbox
 * conversation, then asks WhatsApp for up to 100 messages older than
 * UAZAPI's current local anchor.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('agent');

    let body: HistorySyncBody;
    try {
      body = (await request.json()) as HistorySyncBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const conversationId =
      typeof body.conversation_id === 'string'
        ? body.conversation_id.trim()
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 }
      );
    }

    // Account filter is an explicit tenancy check in addition to RLS.
    // The client never supplies a phone/JID, so it cannot sync a chat
    // outside the selected account by changing the request payload.
    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .select('id, last_message_at, contact:contacts(phone, wa_lid)')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (conversationError) {
      console.error(
        '[uazapi/history-sync] conversation lookup failed:',
        conversationError.message
      );
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const conversationRecord = conversation as unknown as ConversationRecord;
    const contact = conversationRecord.contact;
    const phone = sanitizePhoneForMeta(contact?.phone ?? '');
    const chatJid = contact?.wa_lid
      ? `${contact.wa_lid}@lid`
      : phone
        ? `${phone}@s.whatsapp.net`
        : '';
    if (!chatJid) {
      return NextResponse.json(
        { error: 'Contact has no WhatsApp identifier' },
        { status: 400 }
      );
    }

    const config = await loadUazapiConfig(supabase, accountId);
    if (
      config?.provider !== 'uazapi' ||
      !config.uazapi_base_url ||
      !config.uazapi_instance_token
    ) {
      return NextResponse.json(
        { error: 'UAZAPI is not connected for this account' },
        { status: 409 }
      );
    }

    const instanceToken = decrypt(config.uazapi_instance_token);
    const stored = await loadStoredMessages({
      baseUrl: config.uazapi_base_url,
      instanceToken,
      chatJid,
    });
    const imported = await importMissingMessages({
      supabase,
      conversation: conversationRecord,
      chatJid,
      messages: stored.messages,
    });

    const historyResponse = await requestHistorySync({
      baseUrl: config.uazapi_base_url,
      instanceToken,
      number: chatJid,
      count: 100,
    });

    console.info('[uazapi/history-sync] completed', {
      conversationId,
      scanned: stored.scanned,
      imported: imported.imported,
      skipped: imported.skipped,
      truncated: stored.truncated,
      historyRequested: historyResponse.success === true,
    });

    return NextResponse.json({
      imported: imported.imported,
      scanned: stored.scanned,
      skipped: imported.skipped,
      truncated: stored.truncated,
      history_requested: historyResponse.success === true,
      history_count: 100,
    });
  } catch (err) {
    // Auth/account failures retain their typed 401/403 responses.
    if (err instanceof Error && !('status' in err)) {
      console.error('[uazapi/history-sync] provider error:', err.message);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
