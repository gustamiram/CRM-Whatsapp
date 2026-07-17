// ============================================================
// UAZAPI (QR-code) provider.
//
// Implements WhatsAppProvider on top of uazapi-api.ts. UAZAPI resolves
// the recipient JID itself, so there's no Meta-style phone-variant
// retry — a single attempt with the normalized number. Interactive
// messages map to UAZAPI's unified `/send/menu` (button / list). There
// is no template concept, so `sendTemplate` throws.
// ============================================================

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  uazapiSendText,
  uazapiSendMedia,
  uazapiSendMenu,
  type UazapiMediaType,
} from '@/lib/whatsapp/uazapi-api';
import type { MediaKind, InteractiveListSection } from '@/lib/whatsapp/meta-api';
import type {
  WhatsAppProvider,
  ProviderConfigRow,
  ProviderSendResult,
} from './types';
import { ProviderError } from './types';

const MEDIA_KIND_TO_UAZAPI: Record<MediaKind, UazapiMediaType> = {
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
};

/** Meta buttons → UAZAPI `choices` (`"title|id"` encodes a reply button). */
function buildButtonChoices(
  buttons: { id: string; title: string }[]
): string[] {
  return buttons.map((b) => `${b.title}|${b.id}`);
}

/** Meta list sections → UAZAPI `choices`:
 *  `"[Section]"` opens a section; `"title|id|description"` is a row. */
function buildListChoices(sections: InteractiveListSection[]): string[] {
  const choices: string[] = [];
  for (const section of sections) {
    if (section.title) choices.push(`[${section.title}]`);
    for (const row of section.rows) {
      choices.push(
        [row.title, row.id, row.description].filter(Boolean).join('|')
      );
    }
  }
  return choices;
}

export function createUazapiProvider(
  config: ProviderConfigRow
): WhatsAppProvider {
  if (!config.uazapi_base_url) {
    throw new ProviderError('UAZAPI config missing server URL');
  }
  if (!config.uazapi_instance_token) {
    throw new ProviderError(
      'UAZAPI is not connected yet — scan the QR code in Settings first.'
    );
  }
  const baseUrl = config.uazapi_base_url;
  const instanceToken = decrypt(config.uazapi_instance_token);

  return {
    kind: 'uazapi',

    async sendText({ to, text }): Promise<ProviderSendResult> {
      const { messageId } = await uazapiSendText({
        baseUrl,
        instanceToken,
        number: to,
        text,
      });
      return { messageId, usedPhone: to };
    },

    async sendMedia({ to, kind, link, caption, filename }): Promise<ProviderSendResult> {
      const { messageId } = await uazapiSendMedia({
        baseUrl,
        instanceToken,
        number: to,
        type: MEDIA_KIND_TO_UAZAPI[kind],
        file: link,
        text: caption,
        docName: filename,
      });
      return { messageId, usedPhone: to };
    },

    async sendInteractiveButtons({
      to,
      bodyText,
      buttons,
      footerText,
    }): Promise<ProviderSendResult> {
      const { messageId } = await uazapiSendMenu({
        baseUrl,
        instanceToken,
        number: to,
        type: 'button',
        text: bodyText,
        choices: buildButtonChoices(buttons),
        footerText,
      });
      return { messageId, usedPhone: to };
    },

    async sendInteractiveList({
      to,
      bodyText,
      buttonLabel,
      sections,
      footerText,
    }): Promise<ProviderSendResult> {
      const { messageId } = await uazapiSendMenu({
        baseUrl,
        instanceToken,
        number: to,
        type: 'list',
        text: bodyText,
        listButton: buttonLabel,
        choices: buildListChoices(sections),
        footerText,
      });
      return { messageId, usedPhone: to };
    },

    async sendTemplate(): Promise<ProviderSendResult> {
      // Templates are a Meta Cloud API concept (pre-approved HSMs for the
      // 24h window). UAZAPI has no equivalent — callers should send text
      // or an interactive menu instead.
      throw new ProviderError(
        'Message templates are only available on the Meta provider.'
      );
    },
  };
}
