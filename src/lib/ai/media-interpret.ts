import type { AiConfig } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

/**
 * One-time interpretation of a customer's image/voice-note message,
 * computed once at ingestion (see src/lib/whatsapp/inbound-core.ts)
 * and cached on messages.ai_media_description — buildConversationContext
 * (src/lib/ai/context.ts) reads that column instead of re-describing
 * or re-transcribing the same media on every later reply.
 *
 * Deliberately NOT surfaced in the Inbox UI: message-bubble.tsx only
 * ever renders the customer's own `content_text` caption, so an
 * AI-generated description can't be mistaken for something the
 * customer typed.
 */

const IMAGE_CAPTION_PROMPT =
  'You are describing an image a customer sent to a business over WhatsApp, for a customer-service AI assistant that cannot see images directly. Write one short, factual, neutral description of what the image shows — objects, any text visible in the image (transcribe it verbatim), relevant context. Do not guess intent or invent details that are not visible. Output only the description, 1-3 sentences, no preamble, no "The image shows" framing.'

const MAX_CAPTION_TOKENS = 200

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[]
}

async function describeImageOpenAi(
  config: AiConfig,
  imageUrl: string,
  existingCaption: string | null,
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: IMAGE_CAPTION_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: existingCaption ? `Customer's own caption: "${existingCaption}"` : 'Describe this image.',
            },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      max_completion_tokens: MAX_CAPTION_TOKENS,
    }),
    signal: AbortSignal.timeout(aiRequestTimeoutMs()),
  })
  if (!res.ok) throw await providerHttpError('OpenAI', res)
  const data = (await res.json().catch(() => null)) as OpenAiChatResponse | null
  const text = data?.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim() ? text.trim() : null
}

interface AnthropicMessagesResponse {
  content?: { type?: string; text?: string }[]
}

async function describeImageAnthropic(
  config: AiConfig,
  imageUrl: string,
  existingCaption: string | null,
): Promise<string | null> {
  // Anthropic's image blocks take base64 (no arbitrary-URL source in
  // the API version this integration targets) — fetch our own copy,
  // same "download once, reuse" approach as the WhatsApp media-decrypt
  // fix (src/lib/whatsapp/media-decrypt.ts).
  const imgRes = await fetch(imageUrl)
  if (!imgRes.ok) throw new Error(`Failed to download image for captioning: HTTP ${imgRes.status}`)
  const mediaType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
  const base64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      system: IMAGE_CAPTION_PROMPT,
      max_tokens: MAX_CAPTION_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text: existingCaption ? `Customer's own caption: "${existingCaption}"` : 'Describe this image.',
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(aiRequestTimeoutMs()),
  })
  if (!res.ok) throw await providerHttpError('Anthropic', res)
  const data = (await res.json().catch(() => null)) as AnthropicMessagesResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  return text || null
}

/** Never throws — a captioning failure just means this message stays
 *  without a description (same as "AI not configured"), it must not
 *  affect message ingestion. */
export async function describeImage(
  config: AiConfig,
  imageUrl: string,
  existingCaption: string | null,
): Promise<string | null> {
  try {
    return config.provider === 'openai'
      ? await describeImageOpenAi(config, imageUrl, existingCaption)
      : await describeImageAnthropic(config, imageUrl, existingCaption)
  } catch (err) {
    console.error('[ai media] describeImage failed:', toNetworkErrorMessage(err))
    return null
  }
}

interface WhisperResponse {
  text?: string
}

/**
 * Transcribe a voice note via OpenAI's Whisper endpoint — the only
 * provider in this integration that offers speech-to-text. When the
 * account's primary provider is Anthropic, its own `embeddingsApiKey`
 * (already OpenAI-compatible — reused for knowledge-base embeddings)
 * doubles as the Whisper key here; with neither key available,
 * transcription is skipped (same graceful-degradation pattern as the
 * knowledge base falling back to lexical search without an embeddings
 * key).
 */
export async function transcribeAudio(config: AiConfig, audioUrl: string): Promise<string | null> {
  const whisperKey = config.provider === 'openai' ? config.apiKey : config.embeddingsApiKey
  if (!whisperKey) return null

  try {
    const audioRes = await fetch(audioUrl)
    if (!audioRes.ok) throw new Error(`Failed to download audio for transcription: HTTP ${audioRes.status}`)
    const blob = await audioRes.blob()

    const form = new FormData()
    form.append('file', blob, 'audio.ogg')
    form.append('model', 'whisper-1')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${whisperKey}` },
      body: form,
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    })
    if (!res.ok) throw await providerHttpError('OpenAI Whisper', res)
    const data = (await res.json().catch(() => null)) as WhisperResponse | null
    return typeof data?.text === 'string' && data.text.trim() ? data.text.trim() : null
  } catch (err) {
    console.error('[ai media] transcribeAudio failed:', toNetworkErrorMessage(err))
    return null
  }
}

function toNetworkErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : toNetworkError(err).message
}

/**
 * Entry point called once per inbound image/audio message (see
 * ingestInboundMessage). Returns the text to cache on
 * messages.ai_media_description, already prefixed so it reads
 * unambiguously as a media summary — never a literal quote — when fed
 * into buildConversationContext. Returns null when interpretation
 * wasn't possible (unsupported content type, missing key, or a
 * failure already logged by describeImage/transcribeAudio).
 */
export async function interpretInboundMedia(
  config: AiConfig,
  args: { contentType: string; mediaUrl: string; existingCaption: string | null },
): Promise<string | null> {
  if (args.contentType === 'image') {
    const description = await describeImage(config, args.mediaUrl, args.existingCaption)
    return description ? `[Customer sent an image] ${description}` : null
  }
  if (args.contentType === 'audio') {
    const transcript = await transcribeAudio(config, args.mediaUrl)
    return transcript ? `[Customer sent a voice message] "${transcript}"` : null
  }
  return null
}
