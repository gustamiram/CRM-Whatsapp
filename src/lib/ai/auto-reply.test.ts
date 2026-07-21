import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  findMatchingAiMediaRule: vi.fn(),
  sendAiMediaRule: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    // Full-ish automation rows — real `triggerMatches` (not mocked)
    // evaluates these against `trigger_type` + `trigger_config`.
    autoResponders: [] as Record<string, unknown>[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    // The conversation's newest customer message_id, as the debounce's
    // tie-break query would see it after the wait.
    newestCustomerMessageId: null as string | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('./media-rules', () => ({
  findMatchingAiMediaRule: h.findMatchingAiMediaRule,
  sendAiMediaRule: h.sendAiMediaRule,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select('*').eq().eq().in() → candidate auto-responder rows;
        // the real triggerMatches (not mocked) decides which count.
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // .select().eq().eq().order().order().limit().maybeSingle() →
        // the debounce's "am I still the newest customer message?" check.
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.newestCustomerMessageId
                ? { message_id: h.state.newestCustomerMessageId }
                : null,
              error: null,
            }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

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

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.state.newestCustomerMessageId = null
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.findMatchingAiMediaRule.mockResolvedValue(null)
  h.sendAiMediaRule.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active new_message_received automation exists (matches unconditionally)', async () => {
    h.state.autoResponders = [
      { id: 'auto-1', trigger_type: 'new_message_received', trigger_config: {} },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does NOT stand down for a keyword_match automation whose keywords do not match this message', async () => {
    h.state.autoResponders = [
      {
        id: 'auto-1',
        trigger_type: 'keyword_match',
        trigger_config: { keywords: ['refund'], match_type: 'contains' },
      },
    ]
    await dispatchInboundToAiReply({ ...ARGS, triggerMessageText: 'hello there' })
    expect(h.generateReply).toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('stands down for a keyword_match automation that matches this message', async () => {
    h.state.autoResponders = [
      {
        id: 'auto-1',
        trigger_type: 'keyword_match',
        trigger_config: { keywords: ['refund'], match_type: 'contains' },
      },
    ]
    await dispatchInboundToAiReply({ ...ARGS, triggerMessageText: 'I need a refund please' })
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('sends the matched AI media rule and skips LLM generation entirely', async () => {
    h.findMatchingAiMediaRule.mockResolvedValue({
      id: 'rule-1',
      document_kind: 'image',
      document_url: 'https://example.com/img.png',
      audio_url: 'https://example.com/audio.ogg',
    })
    await dispatchInboundToAiReply({ ...ARGS, triggerMessageText: 'send me the price list' })
    expect(h.sendAiMediaRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rule-1' }),
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
      }),
    )
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toEqual([
      { name: 'claim_ai_reply_slot', args: { conversation_id: 'conv-1', max_replies: 3 } },
    ])
  })

  it('does not send the media rule when the slot claim loses the race', async () => {
    h.state.claim = false
    h.findMatchingAiMediaRule.mockResolvedValue({ id: 'rule-1' })
    await dispatchInboundToAiReply({ ...ARGS, triggerMessageText: 'price list please' })
    expect(h.sendAiMediaRule).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — objective complete', () => {
  it('sends the final message, then pauses auto-reply with a distinct (non-handoff) note', async () => {
    h.generateReply.mockResolvedValue({ text: 'Perfeito, já tenho tudo que preciso!', handoff: false, done: true })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Perfeito, já tenho tudo que preciso!' }),
    )
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('completed its configured objective')
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('pauses without sending when done and there is no final text, without human-escalation side effects', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: false, done: true })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('completed its configured objective')
    // Unlike a real handoff, a configured handoff agent is never assigned here.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('handoff wins if the model somehow signals both', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true, done: true })
    await dispatchInboundToAiReply(ARGS)

    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('AI agent handed off')
  })
})

describe('dispatchInboundToAiReply — debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits the configured delay, then replies when its trigger is still the newest customer message', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyDelaySeconds: 5 }))
    h.state.newestCustomerMessageId = 'wamid-1'

    const dispatch = dispatchInboundToAiReply({
      ...ARGS,
      triggerProviderMessageId: 'wamid-1',
    })
    // Nothing should happen before the delay elapses.
    await vi.advanceTimersByTimeAsync(4999)
    expect(h.generateReply).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await dispatch
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })

  it('stands down when a newer customer message superseded it during the wait', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyDelaySeconds: 5 }))
    // A second message arrived while this dispatch was waiting.
    h.state.newestCustomerMessageId = 'wamid-2'

    const dispatch = dispatchInboundToAiReply({
      ...ARGS,
      triggerProviderMessageId: 'wamid-1',
    })
    await vi.advanceTimersByTimeAsync(5000)
    await dispatch

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('caps the wait at 30s even if a higher value is configured', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyDelaySeconds: 999 }))
    h.state.newestCustomerMessageId = 'wamid-1'

    const dispatch = dispatchInboundToAiReply({
      ...ARGS,
      triggerProviderMessageId: 'wamid-1',
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await dispatch
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('skips the wait entirely when the delay is 0', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyDelaySeconds: 0 }))
    await dispatchInboundToAiReply({
      ...ARGS,
      triggerProviderMessageId: 'wamid-1',
    })
    expect(h.engineSendText).toHaveBeenCalled()
  })
})
