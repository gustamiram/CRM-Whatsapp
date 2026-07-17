// ============================================================
// WhatsApp provider abstraction — the seam that lets the CRM send
// through EITHER the official Meta Cloud API or the unofficial UAZAPI
// (QR-code) provider without the send call sites knowing which one.
//
// A `WhatsAppProvider` owns the actual outbound API call for one
// account, keyed on that account's `whatsapp_config` row. The four send
// paths (inbox core, flows, automations, broadcasts) build a provider
// via `getProvider(config)` and call these methods; message persistence
// stays in the callers so behaviour is identical across providers.
// ============================================================

import type {
  MediaKind,
  InteractiveButton,
  InteractiveListSection,
} from '@/lib/whatsapp/meta-api';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

export type { MediaKind };

export interface ProviderSendResult {
  /** The provider's message id (Meta `wamid` / UAZAPI `messageid`).
   *  Persisted to `messages.message_id`. */
  messageId: string;
  /** The phone number the send actually landed on. Meta may retry
   *  across trunk-prefix variants and return a corrected number that
   *  the caller writes back to the contact; UAZAPI always echoes `to`. */
  usedPhone: string;
}

export interface SendTextInput {
  /** Destination — digits-only international number (no `+`). */
  to: string;
  text: string;
  /** Provider message id being replied to (quote preview). */
  contextMessageId?: string;
}

export interface SendMediaInput {
  to: string;
  kind: MediaKind;
  /** Public URL the provider fetches at send time. */
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface SendInteractiveButtonsInput {
  to: string;
  bodyText: string;
  buttons: InteractiveButton[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface SendInteractiveListInput {
  to: string;
  bodyText: string;
  buttonLabel: string;
  sections: InteractiveListSection[];
  headerText?: string;
  footerText?: string;
  contextMessageId?: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language?: string;
  template?: MessageTemplate;
  messageParams?: SendTimeParams;
  params?: string[];
  contextMessageId?: string;
}

export interface WhatsAppProvider {
  readonly kind: 'meta' | 'uazapi';
  sendText(input: SendTextInput): Promise<ProviderSendResult>;
  sendMedia(input: SendMediaInput): Promise<ProviderSendResult>;
  sendInteractiveButtons(
    input: SendInteractiveButtonsInput
  ): Promise<ProviderSendResult>;
  sendInteractiveList(
    input: SendInteractiveListInput
  ): Promise<ProviderSendResult>;
  /** Meta-only. The UAZAPI provider throws — templates are a Cloud API
   *  concept with no UAZAPI equivalent (see plan). */
  sendTemplate(input: SendTemplateInput): Promise<ProviderSendResult>;
}

/**
 * The subset of the `whatsapp_config` row that `getProvider` reads.
 * Loosely typed (the callers pass the full row from Supabase). Tokens
 * are the encrypted column values; the provider factories decrypt them.
 */
export interface ProviderConfigRow {
  provider?: string | null;
  // Meta
  phone_number_id?: string | null;
  access_token?: string | null;
  // UAZAPI
  uazapi_base_url?: string | null;
  uazapi_instance_token?: string | null;
  [key: string]: unknown;
}

/**
 * Thrown when a provider can't be built or a send is attempted against a
 * provider that doesn't support the operation (e.g. templates on UAZAPI).
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
