import type { UazapiMessage } from '@/lib/whatsapp/uazapi-api';

export interface UazapiHistoryMessageRow {
  sender_type: 'customer' | 'agent';
  content_type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location';
  content_text: string | null;
  media_url: string | null;
  message_id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  created_at: string;
}

function canonicalJid(value: string): string {
  const [rawUser = '', rawServer = ''] = value.trim().toLowerCase().split('@');
  if (!rawUser || !rawServer) return '';
  return `${rawUser.split(':')[0]}@${rawServer}`;
}

function mapMessageType(
  messageType: string | undefined
): UazapiHistoryMessageRow['content_type'] | null {
  const type = (messageType ?? '').toLowerCase();
  if (type.includes('reaction')) return null;
  if (type.includes('buttonsresponse') || type.includes('listresponse')) {
    return null;
  }
  if (type.includes('image') || type.includes('sticker')) return 'image';
  if (type.includes('video')) return 'video';
  if (type.includes('audio') || type.includes('ptt')) return 'audio';
  if (type.includes('document')) return 'document';
  if (type.includes('location')) return 'location';
  return 'text';
}

function mediaUrlOf(message: UazapiMessage): string | null {
  const candidates = [
    message.mediaUrl,
    message.fileURL,
    message.file,
    message.content,
    message.audio,
    message.url,
    message.downloadUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function mapStatus(message: UazapiMessage): UazapiHistoryMessageRow['status'] {
  if (!message.fromMe) return 'delivered';
  const status = String(message.status ?? '').toLowerCase();
  if (status.includes('fail') || status.includes('cancel')) return 'failed';
  if (status.includes('read')) return 'read';
  if (status.includes('deliver')) return 'delivered';
  return 'sent';
}

/**
 * Convert one provider-side stored message into the inert messages-table
 * shape used by manual history imports. Returns null for groups,
 * reactions, interactive replies, malformed rows, or another chat.
 */
export function normalizeUazapiHistoryMessage(
  message: UazapiMessage,
  expectedChatJid: string
): UazapiHistoryMessageRow | null {
  if (message.isGroup) return null;

  const messageChatJid = canonicalJid(String(message.chatid ?? ''));
  const expected = canonicalJid(expectedChatJid);
  if (messageChatJid && expected && messageChatJid !== expected) return null;

  const messageId = String(message.messageid ?? message.id ?? '').trim();
  if (!messageId) return null;

  const rawTimestamp = Number(message.messageTimestamp ?? 0);
  if (!Number.isFinite(rawTimestamp) || rawTimestamp <= 0) return null;
  const timestampMs = rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
  const createdAt = new Date(timestampMs);
  if (Number.isNaN(createdAt.getTime())) return null;

  const contentType = mapMessageType(message.messageType);
  if (!contentType) return null;

  const isMedia =
    contentType === 'image' ||
    contentType === 'video' ||
    contentType === 'audio' ||
    contentType === 'document';

  return {
    sender_type: message.fromMe ? 'agent' : 'customer',
    content_type: contentType,
    content_text: message.caption || message.text || null,
    media_url: isMedia ? mediaUrlOf(message) : null,
    message_id: messageId,
    status: mapStatus(message),
    created_at: createdAt.toISOString(),
  };
}
