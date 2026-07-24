// ============================================================
// UAZAPI (unofficial WhatsApp API) low-level client.
//
// The parallel of meta-api.ts for the QR-code provider. UAZAPI auth is
// header-based:
//   - `admintoken`  → admin endpoints (create instance)
//   - `token`       → per-instance endpoints (connect/status/send/webhook)
//
// Every function takes a single options object. Errors are thrown with
// UAZAPI's own message when present. Base URL is per-account (bring-your-
// own server), so it's always passed in — never a hardcoded host.
// ============================================================

export interface UazapiBase {
  /** Server base URL, e.g. https://api.uazapi.com (no trailing slash needed). */
  baseUrl: string;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function uazapiRequest(
  baseUrl: string,
  path: string,
  opts: {
    method?: 'GET' | 'POST';
    /** Auth header — instance `token` or `admintoken`. */
    authHeader: 'token' | 'admintoken';
    authValue: string;
    body?: unknown;
  }
): Promise<Record<string, unknown>> {
  const { method = 'POST', authHeader, authValue, body } = opts;
  const url = `${normalizeBase(baseUrl)}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [authHeader]: authValue,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
  }

  if (!res.ok) {
    const message =
      (typeof data.error === 'string' && data.error) ||
      (typeof data.message === 'string' && data.message) ||
      `UAZAPI error: ${res.status}`;
    throw new Error(message);
  }
  return data;
}

// ------------------------------------------------------------
// Instance lifecycle
// ------------------------------------------------------------

export interface UazapiInstanceSnapshot {
  id?: string;
  status?: string;
  qrcode?: string;
  paircode?: string;
  profileName?: string;
  owner?: string;
  token?: string;
}

/** Pull the instance object out of the various response shapes UAZAPI
 *  uses (`{ instance: {...} }`, or the instance fields at top level). */
function pickInstance(data: Record<string, unknown>): UazapiInstanceSnapshot {
  const inst = (data.instance as Record<string, unknown> | undefined) ?? data;
  return {
    id: (inst.id as string) ?? undefined,
    status: (inst.status as string) ?? (data.status as string) ?? undefined,
    qrcode: (inst.qrcode as string) ?? (data.qrcode as string) ?? undefined,
    paircode:
      (inst.paircode as string) ?? (data.paircode as string) ?? undefined,
    profileName: (inst.profileName as string) ?? undefined,
    owner: (inst.owner as string) ?? undefined,
    token: (data.token as string) ?? (inst.token as string) ?? undefined,
  };
}

export interface CreateInstanceArgs extends UazapiBase {
  adminToken: string;
  name: string;
}

export interface CreateInstanceResult {
  /** Per-instance token used for every subsequent call. */
  instanceToken: string;
  instanceId?: string;
}

/** Create a new instance (admin op). Returns the per-instance token. */
export async function createInstance(
  args: CreateInstanceArgs
): Promise<CreateInstanceResult> {
  const data = await uazapiRequest(args.baseUrl, '/instance/create', {
    authHeader: 'admintoken',
    authValue: args.adminToken,
    body: { name: args.name },
  });
  const inst = pickInstance(data);
  const instanceToken = (data.token as string) ?? inst.token;
  if (!instanceToken) {
    throw new Error('UAZAPI did not return an instance token on create.');
  }
  return { instanceToken, instanceId: inst.id };
}

export interface InstanceTokenArgs extends UazapiBase {
  instanceToken: string;
}

/** Start the connection flow. With no `phone`, UAZAPI returns a QR code. */
export async function connectInstance(
  args: InstanceTokenArgs
): Promise<UazapiInstanceSnapshot> {
  const data = await uazapiRequest(args.baseUrl, '/instance/connect', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body: {},
  });
  return pickInstance(data);
}

/** Poll the current status (+ refreshed QR while `connecting`). */
export async function getInstanceStatus(
  args: InstanceTokenArgs
): Promise<UazapiInstanceSnapshot> {
  const data = await uazapiRequest(args.baseUrl, '/instance/status', {
    method: 'GET',
    authHeader: 'token',
    authValue: args.instanceToken,
  });
  return pickInstance(data);
}

/** Disconnect the WhatsApp session (a new QR is needed to reconnect). */
export async function disconnectInstance(
  args: InstanceTokenArgs
): Promise<void> {
  await uazapiRequest(args.baseUrl, '/instance/disconnect', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body: {},
  });
}

// ------------------------------------------------------------
// Webhook registration
// ------------------------------------------------------------

export interface SetWebhookArgs extends InstanceTokenArgs {
  url: string;
  events?: string[];
  /** Always include 'wasSentByApi' to stop our own sends echoing back. */
  excludeMessages?: string[];
}

/** Register (or update) the single instance webhook — "simple mode"
 *  (no `id`/`action`, so UAZAPI upserts one webhook per instance). */
export async function setWebhook(args: SetWebhookArgs): Promise<void> {
  await uazapiRequest(args.baseUrl, '/webhook', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body: {
      enabled: true,
      url: args.url,
      // 'history' is the 7-day backfill UAZAPI sends after a fresh QR
      // connect — without it, any conversation that was already in
      // progress before the connection looks brand new to us, and
      // `first_inbound_message` fires on a customer's next reply even
      // though it's nowhere close to their first message.
      events: args.events ?? ['messages', 'connection', 'history'],
      excludeMessages: args.excludeMessages ?? ['wasSentByApi'],
    },
  });
}

// ------------------------------------------------------------
// History
// ------------------------------------------------------------

// A UAZAPI message object (a subset of the /message/find schema).
// Extra fields are intentionally allowed because media payloads vary
// between server versions.
export interface UazapiMessage {
  id?: string;
  messageid?: string;
  chatid?: string;
  sender?: string;
  sender_pn?: string;
  sender_lid?: string;
  senderName?: string;
  isGroup?: boolean;
  fromMe?: boolean;
  wasSentByApi?: boolean;
  messageType?: string;
  messageTimestamp?: number;
  status?: string;
  text?: string;
  quoted?: string;
  reaction?: string;
  mediaUrl?: string;
  file?: string;
  fileURL?: string;
  content?: string | { URL?: string; mediaKey?: string; mimetype?: string };
  mimetype?: string;
  caption?: string;
  selectedId?: string;
  buttonId?: string;
  vote?: string;
  [key: string]: unknown;
}

export interface UazapiFindMessagesArgs extends InstanceTokenArgs {
  /** Complete chat JID to filter the provider-side message store. */
  chatId: string;
  /** Page size. UAZAPI defaults to 100. */
  limit?: number;
  /** Zero-based result offset; results are newest first. */
  offset?: number;
}

export interface UazapiFindMessagesResult {
  messages: UazapiMessage[];
  returnedMessages: number;
  limit: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
}

/** Read one page of messages already persisted by UAZAPI for a chat. */
export async function findMessages(
  args: UazapiFindMessagesArgs
): Promise<UazapiFindMessagesResult> {
  const limit = Math.max(1, Math.trunc(args.limit ?? 100));
  const offset = Math.max(0, Math.trunc(args.offset ?? 0));
  const data = await uazapiRequest(args.baseUrl, '/message/find', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body: {
      chatid: args.chatId,
      limit,
      offset,
    },
  });

  const messages = Array.isArray(data.messages)
    ? data.messages.filter(
        (message): message is UazapiMessage =>
          Boolean(message) && typeof message === 'object'
      )
    : [];
  const returnedMessages = Number.isFinite(Number(data.returnedMessages))
    ? Math.max(0, Math.trunc(Number(data.returnedMessages)))
    : messages.length;
  const responseLimit = Number.isFinite(Number(data.limit))
    ? Math.max(1, Math.trunc(Number(data.limit)))
    : limit;
  const responseOffset = Number.isFinite(Number(data.offset))
    ? Math.max(0, Math.trunc(Number(data.offset)))
    : offset;
  const nextOffset = Number.isFinite(Number(data.nextOffset))
    ? Math.max(responseOffset, Math.trunc(Number(data.nextOffset)))
    : responseOffset + returnedMessages;

  return {
    messages,
    returnedMessages,
    limit: responseLimit,
    offset: responseOffset,
    nextOffset,
    hasMore: data.hasMore === true,
  };
}

export interface UazapiHistorySyncArgs extends InstanceTokenArgs {
  /** Complete chat JID (`5511...@s.whatsapp.net` or `<lid>@lid`). */
  number: string;
  /** Number of older messages requested by UAZAPI (hard limit: 100). */
  count?: number;
  /** Optional anchor; history is loaded backwards from this message. */
  messageId?: string;
}

/**
 * Ask WhatsApp to send an older history batch for one chat.
 *
 * UAZAPI acknowledges this request synchronously, then delivers the
 * messages asynchronously through the configured `history` webhook.
 * The webhook ingestion path is responsible for persistence and
 * duplicate suppression.
 */
export async function requestHistorySync(
  args: UazapiHistorySyncArgs
): Promise<Record<string, unknown>> {
  const count = Math.min(100, Math.max(1, Math.trunc(args.count ?? 100)));
  const body: Record<string, unknown> = {
    number: args.number,
    mode: 'history',
    count,
  };
  if (args.messageId) body.messageid = args.messageId;

  return uazapiRequest(args.baseUrl, '/message/history-sync', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body,
  });
}

// ------------------------------------------------------------
// Sending
// ------------------------------------------------------------

function extractMessageId(data: Record<string, unknown>): string {
  const nested = data.message as Record<string, unknown> | undefined;
  return (
    (data.messageid as string) ??
    (data.id as string) ??
    (nested?.messageid as string) ??
    (nested?.id as string) ??
    ''
  );
}

export interface UazapiSendTextArgs extends InstanceTokenArgs {
  number: string;
  text: string;
}

export async function uazapiSendText(
  args: UazapiSendTextArgs
): Promise<{ messageId: string }> {
  const data = await uazapiRequest(args.baseUrl, '/send/text', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body: { number: args.number, text: args.text },
  });
  return { messageId: extractMessageId(data) };
}

/** UAZAPI media type keyword. Meta's MediaKind maps 1:1 for our uses. */
export type UazapiMediaType =
  'image' | 'video' | 'document' | 'audio' | 'ptt' | 'sticker';

export interface UazapiSendMediaArgs extends InstanceTokenArgs {
  number: string;
  type: UazapiMediaType;
  /** URL or base64. */
  file: string;
  text?: string;
  docName?: string;
}

export async function uazapiSendMedia(
  args: UazapiSendMediaArgs
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    number: args.number,
    type: args.type,
    file: args.file,
  };
  if (args.text) body.text = args.text;
  if (args.docName) body.docName = args.docName;
  const data = await uazapiRequest(args.baseUrl, '/send/media', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body,
  });
  return { messageId: extractMessageId(data) };
}

export interface UazapiSendMenuArgs extends InstanceTokenArgs {
  number: string;
  type: 'button' | 'list';
  text: string;
  /** Encoded choices — see buildButtonChoices / buildListChoices. */
  choices: string[];
  footerText?: string;
  /** For lists: the label of the tap-to-expand button. */
  listButton?: string;
}

export async function uazapiSendMenu(
  args: UazapiSendMenuArgs
): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    number: args.number,
    type: args.type,
    text: args.text,
    choices: args.choices,
  };
  if (args.footerText) body.footerText = args.footerText;
  if (args.listButton) body.listButton = args.listButton;
  const data = await uazapiRequest(args.baseUrl, '/send/menu', {
    authHeader: 'token',
    authValue: args.instanceToken,
    body,
  });
  return { messageId: extractMessageId(data) };
}
