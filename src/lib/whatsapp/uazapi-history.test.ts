import { describe, expect, it } from 'vitest';

import { normalizeUazapiHistoryMessage } from './uazapi-history';

const CHAT_JID = '5511999999999@s.whatsapp.net';

describe('normalizeUazapiHistoryMessage', () => {
  it('normalizes an inbound text message', () => {
    const result = normalizeUazapiHistoryMessage(
      {
        messageid: 'msg-1',
        chatid: CHAT_JID,
        fromMe: false,
        messageType: 'conversation',
        messageTimestamp: 1_784_744_000,
        text: 'Olá',
      },
      CHAT_JID
    );

    expect(result).toEqual({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Olá',
      media_url: null,
      message_id: 'msg-1',
      status: 'delivered',
      created_at: new Date(1_784_744_000_000).toISOString(),
    });
  });

  it('normalizes an outbound media message and its provider status', () => {
    const result = normalizeUazapiHistoryMessage(
      {
        messageid: 'msg-2',
        chatid: CHAT_JID,
        fromMe: true,
        messageType: 'videoMessage',
        messageTimestamp: 1_784_744_000_000,
        status: 'Read',
        caption: 'Vídeo',
        fileURL: 'https://media.example/video.mp4',
      },
      CHAT_JID
    );

    expect(result).toMatchObject({
      sender_type: 'agent',
      content_type: 'video',
      content_text: 'Vídeo',
      media_url: 'https://media.example/video.mp4',
      status: 'read',
    });
  });

  it('rejects another chat, groups, interactive replies, and missing ids', () => {
    const base = {
      messageid: 'msg-3',
      chatid: CHAT_JID,
      messageType: 'conversation',
      messageTimestamp: 1_784_744_000_000,
    };

    expect(
      normalizeUazapiHistoryMessage(
        { ...base, chatid: '5511888888888@s.whatsapp.net' },
        CHAT_JID
      )
    ).toBeNull();
    expect(
      normalizeUazapiHistoryMessage({ ...base, isGroup: true }, CHAT_JID)
    ).toBeNull();
    expect(
      normalizeUazapiHistoryMessage(
        { ...base, messageType: 'buttonsResponseMessage' },
        CHAT_JID
      )
    ).toBeNull();
    expect(
      normalizeUazapiHistoryMessage(
        { ...base, messageid: undefined, id: undefined },
        CHAT_JID
      )
    ).toBeNull();
  });
});
