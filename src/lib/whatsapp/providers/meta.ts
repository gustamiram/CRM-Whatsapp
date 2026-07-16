// ============================================================
// Meta (official Cloud API) provider.
//
// Wraps the existing meta-api.ts helpers behind the WhatsAppProvider
// interface. This is also where the Meta phone-variant retry now lives
// — previously duplicated inline in send-message.ts, flows/meta-send.ts,
// automations/meta-send.ts, and broadcast-core.ts. Consolidating it here
// keeps every send path's Meta behaviour identical and in one place.
// ============================================================

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons as metaSendInteractiveButtons,
  sendInteractiveList as metaSendInteractiveList,
} from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils';
import type {
  WhatsAppProvider,
  ProviderConfigRow,
  ProviderSendResult,
} from './types';
import { ProviderError } from './types';

export function createMetaProvider(config: ProviderConfigRow): WhatsAppProvider {
  if (!config.phone_number_id) {
    throw new ProviderError('Meta config missing phone_number_id');
  }
  if (!config.access_token) {
    throw new ProviderError('Meta config missing access_token');
  }
  const phoneNumberId = config.phone_number_id;
  // Decrypt once per send-batch. Throws on a corrupted ciphertext — same
  // failure mode the call sites had when they decrypted inline.
  const accessToken = decrypt(config.access_token);

  // Retry the send across plausible trunk-prefix variants when Meta
  // rejects the recipient with #131030 ("not in allowed list"). Returns
  // the variant that worked so the caller can persist it back to the
  // contact.
  async function withVariants(
    to: string,
    attempt: (phone: string) => Promise<string>
  ): Promise<ProviderSendResult> {
    const variants = phoneVariants(to);
    let lastError: unknown = null;
    for (const variant of variants) {
      try {
        const messageId = await attempt(variant);
        return { messageId, usedPhone: variant };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) throw err;
        lastError = err;
      }
    }
    throw lastError ?? new Error('Meta send failed for all phone variants');
  }

  return {
    kind: 'meta',

    sendText: ({ to, text, contextMessageId }) =>
      withVariants(to, (phone) =>
        sendTextMessage({
          phoneNumberId,
          accessToken,
          to: phone,
          text,
          contextMessageId,
        }).then((r) => r.messageId)
      ),

    sendMedia: ({ to, kind, link, caption, filename, contextMessageId }) =>
      withVariants(to, (phone) =>
        sendMediaMessage({
          phoneNumberId,
          accessToken,
          to: phone,
          kind,
          link,
          caption,
          filename,
          contextMessageId,
        }).then((r) => r.messageId)
      ),

    sendInteractiveButtons: ({
      to,
      bodyText,
      buttons,
      headerText,
      footerText,
      contextMessageId,
    }) =>
      withVariants(to, (phone) =>
        metaSendInteractiveButtons({
          phoneNumberId,
          accessToken,
          to: phone,
          bodyText,
          buttons,
          headerText,
          footerText,
          contextMessageId,
        }).then((r) => r.messageId)
      ),

    sendInteractiveList: ({
      to,
      bodyText,
      buttonLabel,
      sections,
      headerText,
      footerText,
      contextMessageId,
    }) =>
      withVariants(to, (phone) =>
        metaSendInteractiveList({
          phoneNumberId,
          accessToken,
          to: phone,
          bodyText,
          buttonLabel,
          sections,
          headerText,
          footerText,
          contextMessageId,
        }).then((r) => r.messageId)
      ),

    sendTemplate: ({
      to,
      templateName,
      language,
      template,
      messageParams,
      params,
      contextMessageId,
    }) =>
      withVariants(to, (phone) =>
        sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to: phone,
          templateName,
          language,
          template,
          messageParams,
          params,
          contextMessageId,
        }).then((r) => r.messageId)
      ),
  };
}
