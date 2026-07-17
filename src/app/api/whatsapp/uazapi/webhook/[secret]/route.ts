import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { ingestInboundMessage, ingestAgentSentMessage } from '@/lib/whatsapp/inbound-core'

// Inbound processing can fan out to the flows/automations/AI engines.
export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// A UAZAPI message object (a subset of the /message/find schema). Media
// and interactive shapes vary by server version, so extra fields are
// read defensively below.
interface UazapiMessage {
  id?: string
  messageid?: string
  chatid?: string
  sender?: string
  /**
   * The sender's phone-number-based JID, resolved by WhatsApp — only
   * present once WhatsApp has linked this contact's LID to a real
   * number. When absent, `sender` (and/or `sender_lid`) is a LID, not
   * a dialable phone number.
   */
  sender_pn?: string
  /** The sender's original LID, when WhatsApp assigned one. */
  sender_lid?: string
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
  /** True when this message was sent through UAZAPI's own send/* API —
   *  i.e. by this CRM. We register the webhook with
   *  excludeMessages:['wasSentByApi'] so these shouldn't normally
   *  arrive at all; this field is a second, message-level check so a
   *  registration-level miss can't duplicate a message we already
   *  recorded when we sent it. */
  wasSentByApi?: boolean
  messageType?: string
  messageTimestamp?: number
  text?: string
  quoted?: string
  reaction?: string
  // Media / interactive (best-effort — presence varies by version):
  mediaUrl?: string
  file?: string
  content?: string
  mimetype?: string
  caption?: string
  selectedId?: string
  buttonId?: string
  vote?: string
  [key: string]: unknown
}

/** Map UAZAPI's messageType to our normalized inbound `type`. */
function mapUazapiType(messageType: string | undefined): string {
  const t = (messageType ?? '').toLowerCase()
  if (t.includes('image') || t.includes('sticker')) return 'image'
  if (t.includes('video')) return 'video'
  if (t.includes('audio') || t.includes('ptt')) return 'audio'
  if (t.includes('document')) return 'document'
  if (t.includes('location')) return 'location'
  if (t.includes('reaction')) return 'reaction'
  if (t.includes('buttonsresponse') || t.includes('listresponse')) return 'interactive'
  return 'text'
}

/** Pull the message object out of the various webhook envelope shapes. */
function pickMessage(body: Record<string, unknown>): UazapiMessage | null {
  const candidate =
    (body.message as UazapiMessage | undefined) ??
    (body.data as UazapiMessage | undefined) ??
    (body.messages as UazapiMessage[] | undefined)?.[0] ??
    (body as UazapiMessage)
  if (!candidate || (!candidate.messageid && !candidate.id && !candidate.text)) {
    return null
  }
  return candidate
}

function mediaUrlOf(msg: UazapiMessage): string | null {
  const url = msg.mediaUrl || msg.file || msg.content
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
  return null
}

function extractJidUser(jid: string): string {
  return jid.split('@')[0].split(':')[0]
}

/**
 * Resolve the sender's identity from a UAZAPI message.
 *
 * WhatsApp is rolling out LIDs (privacy identifiers) that replace the
 * real phone number for some senders. UAZAPI surfaces this as
 * `sender_pn` (the real phone-number JID, only present once WhatsApp
 * has resolved it) separately from `sender`/`sender_lid` (the LID).
 * Naively reading the digits out of `sender` — regardless of whether
 * its JID suffix is `@s.whatsapp.net` (real number) or `@lid` (not a
 * dialable number) — produces a contact with a bogus "phone" that
 * every outbound send then fails against.
 *
 * Returns `waLid` set only when no real phone number is known — that's
 * the signal the send path uses to target `{waLid}@lid` instead of a
 * phone-based JID (see providers/uazapi.ts).
 */
function resolveSender(msg: UazapiMessage): { phone: string; waLid: string | null } {
  const senderJid = String(msg.sender ?? '')
  const isLidJid = senderJid.endsWith('@lid')
  const resolvedPn = msg.sender_pn || (!isLidJid ? senderJid : '')

  if (resolvedPn) {
    return { phone: normalizePhone(extractJidUser(resolvedPn)), waLid: null }
  }

  const lid = msg.sender_lid || extractJidUser(senderJid)
  const normalizedLid = normalizePhone(lid)
  return { phone: normalizedLid, waLid: normalizedLid || null }
}

/**
 * Resolve the customer's phone from a message's `chatid` — "the chat
 * this message belongs to", independent of who sent it. Used only for
 * `fromMe` events: `sender` there reports OUR OWN identity, not the
 * customer's, so resolving from `sender` would (mis)file the message
 * under a contact matching our own number.
 */
function resolveChatCustomerPhone(msg: UazapiMessage): string {
  const chatJid = String(msg.chatid ?? '')
  return normalizePhone(extractJidUser(chatJid))
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> }
) {
  const { secret } = await params
  if (!secret) {
    return NextResponse.json({ error: 'Missing secret' }, { status: 400 })
  }

  // Resolve the owning account by the unguessable secret in the URL.
  // This is the tenancy check — UAZAPI does not sign its payloads, so a
  // valid secret is what authenticates the delivery to this account.
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id, provider')
    .eq('uazapi_webhook_secret', secret)
    .maybeSingle()

  if (error) {
    console.error('[uazapi-webhook] config lookup failed:', error)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  // Always return 200 for an unknown secret so a probing sender can't
  // distinguish valid from invalid secrets by the status code.
  if (!config || config.provider !== 'uazapi') {
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Ack fast, process after (same rationale as the Meta webhook).
  after(async () => {
    try {
      await processUazapiEvent(body, config.account_id, config.user_id)
    } catch (err) {
      console.error('[uazapi-webhook] processing error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processUazapiEvent(
  body: Record<string, unknown>,
  accountId: string,
  configOwnerUserId: string
) {
  const msg = pickMessage(body)
  if (!msg) return
  if (msg.isGroup) return

  // `fromMe` covers two different situations that need opposite
  // handling:
  //   - wasSentByApi=true  → this CRM sent it (via /send/*); already
  //     recorded when we sent it. The webhook is registered with
  //     excludeMessages:['wasSentByApi'] so these shouldn't normally
  //     even arrive — this is a second, message-level check.
  //   - wasSentByApi=false → the connected number's owner replied
  //     directly from the WhatsApp phone app, not through the CRM.
  //     That reaches the customer fine but, without this, never shows
  //     up in the CRM thread — record it as an agent message.
  if (msg.fromMe) {
    if (!msg.wasSentByApi) {
      await handleAgentSentFromPhone(msg, accountId, configOwnerUserId)
    }
    return
  }

  const { phone: senderPhone, waLid: senderWaLid } = resolveSender(msg)
  if (!senderPhone) return

  const providerMessageId = msg.messageid || msg.id || ''
  const rawTs = Number(msg.messageTimestamp ?? 0)
  // UAZAPI documents ms; guard the occasional seconds value defensively.
  const timestampMs = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now()

  const type = mapUazapiType(msg.messageType)

  // Reaction event — target id + emoji, never a stored message.
  if (type === 'reaction') {
    if (!msg.reaction) return
    await ingestInboundMessage({
      accountId,
      configOwnerUserId,
      senderPhone,
      senderWaLid,
      senderName: msg.senderName || senderPhone,
      providerMessageId,
      timestampMs,
      type: 'reaction',
      contentText: null,
      mediaUrl: null,
      interactiveReplyId: null,
      replyToExternalId: null,
      reaction: { targetExternalId: msg.reaction, emoji: msg.text ?? '' },
    })
    return
  }

  const isMedia =
    type === 'image' || type === 'video' || type === 'audio' || type === 'document'
  const mediaUrl = isMedia ? mediaUrlOf(msg) : null
  const interactiveReplyId =
    type === 'interactive'
      ? msg.selectedId || msg.buttonId || msg.vote || null
      : null

  const contentText =
    type === 'interactive'
      ? msg.text || interactiveReplyId || null
      : msg.caption || msg.text || null

  await ingestInboundMessage({
    accountId,
    configOwnerUserId,
    senderPhone,
    senderWaLid,
    senderName: msg.senderName || senderPhone,
    providerMessageId,
    timestampMs,
    type,
    contentText,
    mediaUrl,
    interactiveReplyId,
    replyToExternalId: msg.quoted || null,
    reaction: null,
  })
}

/**
 * A `fromMe` message that wasn't sent via our API — the connected
 * number's owner replied directly from the phone. Record it in the
 * customer's thread (resolved via `chatid`, not `sender`) so it shows
 * up in the CRM instead of only existing on the phone.
 */
async function handleAgentSentFromPhone(
  msg: UazapiMessage,
  accountId: string,
  configOwnerUserId: string
) {
  const customerPhone = resolveChatCustomerPhone(msg)
  if (!customerPhone) return

  const providerMessageId = msg.messageid || msg.id || ''
  const rawTs = Number(msg.messageTimestamp ?? 0)
  const timestampMs = rawTs > 0 ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : Date.now()
  const type = mapUazapiType(msg.messageType)

  // Reactions and interactive taps from our own side aren't meaningful
  // to mirror as a message row — nothing in this schema models "agent
  // reacted" or "agent tapped a button".
  if (type === 'reaction' || type === 'interactive') return

  const isMedia =
    type === 'image' || type === 'video' || type === 'audio' || type === 'document'
  const mediaUrl = isMedia ? mediaUrlOf(msg) : null
  const contentText = msg.caption || msg.text || null

  await ingestAgentSentMessage({
    accountId,
    configOwnerUserId,
    customerPhone,
    providerMessageId,
    timestampMs,
    type,
    contentText,
    mediaUrl,
  })
}
