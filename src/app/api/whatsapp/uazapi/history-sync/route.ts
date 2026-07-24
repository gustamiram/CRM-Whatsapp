import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import { requestHistorySync } from '@/lib/whatsapp/uazapi-api';
import { loadUazapiConfig } from '@/lib/whatsapp/uazapi-config';

interface HistorySyncBody {
  conversation_id?: unknown;
}

interface ConversationContact {
  phone?: string | null;
  wa_lid?: string | null;
}

/**
 * Requests up to 100 older messages for the selected inbox
 * conversation. UAZAPI returns the actual messages asynchronously to
 * the existing `history` webhook, which persists and deduplicates them.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();

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
      .select('id, contact:contacts(phone, wa_lid)')
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

    const contact =
      conversation.contact as unknown as ConversationContact | null;
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

    await requestHistorySync({
      baseUrl: config.uazapi_base_url,
      instanceToken: decrypt(config.uazapi_instance_token),
      number: chatJid,
      count: 100,
    });

    return NextResponse.json({
      requested: true,
      count: 100,
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
