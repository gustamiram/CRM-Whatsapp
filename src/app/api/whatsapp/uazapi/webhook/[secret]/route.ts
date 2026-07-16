import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound-core'

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
  senderName?: string
  isGroup?: boolean
  fromMe?: boolean
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

  // Skip our own / agent-from-phone sends and group messages. The
  // webhook is also registered with excludeMessages:['wasSentByApi'],
  // so API sends never reach here — this guards the phone-side ones.
  if (msg.fromMe) return
  if (msg.isGroup) return

  const senderJid = String(msg.sender ?? '')
  const senderPhone = normalizePhone(senderJid.split('@')[0].split(':')[0])
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
