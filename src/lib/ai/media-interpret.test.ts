import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'
import { describeImage, transcribeAudio, interpretInboundMedia } from './media-interpret'

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    autoReplyDelaySeconds: 0,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
    blob: async () => new Blob(['fake audio bytes']),
    headers: { get: () => 'image/jpeg' },
  }
}

describe('describeImage', () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('calls OpenAI chat completions with the image URL directly', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'A red sneaker with a torn lace.' } }] }),
    )

    const result = await describeImage(aiConfig({ provider: 'openai' }), 'https://x/img.jpg', null)

    expect(result).toBe('A red sneaker with a torn lace.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    const body = JSON.parse(opts.body)
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://x/img.jpg' } })
  })

  it('downloads the image and sends base64 for Anthropic', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, true)) // image download
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'A product photo.' }] })) // messages API

    const result = await describeImage(aiConfig({ provider: 'anthropic' }), 'https://x/img.jpg', 'look at this')

    expect(result).toBe('A product photo.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, opts] = fetchMock.mock.calls[1]
    const body = JSON.parse(opts.body)
    expect(body.messages[0].content[0].type).toBe('image')
    expect(body.messages[0].content[0].source.type).toBe('base64')
  })

  it('returns null (never throws) when the provider call fails', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, false, 401))

    const result = await describeImage(aiConfig(), 'https://x/img.jpg', null)
    expect(result).toBeNull()
  })

  it('returns null when the response has no text', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }))
    const result = await describeImage(aiConfig(), 'https://x/img.jpg', null)
    expect(result).toBeNull()
  })
})

describe('transcribeAudio', () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('transcribes via Whisper using the openai provider key', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, true)) // audio download
      .mockResolvedValueOnce(jsonResponse({ text: 'Hi, checking on my order.' })) // whisper

    const result = await transcribeAudio(aiConfig({ provider: 'openai' }), 'https://x/a.ogg')
    expect(result).toBe('Hi, checking on my order.')
  })

  it('falls back to the embeddings key when the provider is anthropic', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, true))
      .mockResolvedValueOnce(jsonResponse({ text: 'transcribed via fallback key' }))

    const result = await transcribeAudio(
      aiConfig({ provider: 'anthropic', apiKey: 'sk-ant', embeddingsApiKey: 'sk-oai-embed' }),
      'https://x/a.ogg',
    )
    expect(result).toBe('transcribed via fallback key')
    const [, opts] = fetchMock.mock.calls[1]
    expect(opts.headers.Authorization).toBe('Bearer sk-oai-embed')
  })

  it('skips transcription (no fetch at all) when anthropic has no embeddings key', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    const result = await transcribeAudio(aiConfig({ provider: 'anthropic', embeddingsApiKey: null }), 'https://x/a.ogg')
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when the download fails', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse({}, false, 404))
    const result = await transcribeAudio(aiConfig(), 'https://x/a.ogg')
    expect(result).toBeNull()
  })
})

describe('interpretInboundMedia', () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    global.fetch = originalFetch
  })

  it('prefixes an image description', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'A cat.' } }] }))
    const result = await interpretInboundMedia(aiConfig(), {
      contentType: 'image',
      mediaUrl: 'https://x/i.jpg',
      existingCaption: null,
    })
    expect(result).toBe('[Customer sent an image] A cat.')
  })

  it('prefixes a voice-note transcript', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, true))
      .mockResolvedValueOnce(jsonResponse({ text: 'hello there' }))
    const result = await interpretInboundMedia(aiConfig(), {
      contentType: 'audio',
      mediaUrl: 'https://x/a.ogg',
      existingCaption: null,
    })
    expect(result).toBe('[Customer sent a voice message] "hello there"')
  })

  it('returns null for unsupported content types (video/document/text)', async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>
    for (const contentType of ['video', 'document', 'text']) {
      const result = await interpretInboundMedia(aiConfig(), {
        contentType,
        mediaUrl: 'https://x/y',
        existingCaption: null,
      })
      expect(result).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
