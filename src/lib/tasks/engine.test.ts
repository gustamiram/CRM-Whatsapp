import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from '../ai/types'

// Shared, hoisted mock state the module mocks below close over.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    dueTasks: [] as Record<string, unknown>[],
    deal: null as Record<string, unknown> | null,
    contact: null as Record<string, unknown> | null,
    conversation: null as Record<string, unknown> | null,
    waConfig: null as Record<string, unknown> | null,
    lastCustomerMessage: null as Record<string, unknown> | null,
    updates: [] as { id: string; patch: Record<string, unknown> }[],
  },
}))

vi.mock('@/lib/ai/config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('@/lib/ai/generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/ai/memory', () => ({ getConversationMemory: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'tasks') {
        // Two shapes: the initial due-tasks SELECT (awaited directly,
        // no .maybeSingle()) and the per-task status UPDATE.
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          lte: () => chain,
          limit: () => Promise.resolve({ data: h.state.dueTasks, error: null }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              h.state.updates.push({ id, patch })
              return Promise.resolve({ error: null })
            },
          }),
        }
        return chain
      }
      if (table === 'deals') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.deal }),
        }
        return chain
      }
      if (table === 'contacts') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.contact }),
        }
        return chain
      }
      if (table === 'conversations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.conversation }),
        }
        return chain
      }
      if (table === 'whatsapp_config') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.waConfig }),
        }
        return chain
      }
      if (table === 'messages') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: h.state.lastCustomerMessage }),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { processDueBillingTasks, processDueProposalFollowupTasks } from './engine'

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

const TASK = {
  id: 'task-1',
  deal_id: null,
  contact_id: 'contact-1',
  title: 'Pay the deposit',
  notes: null,
  due_at: new Date().toISOString(),
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.dueTasks = [{ ...TASK }]
  h.state.deal = null
  h.state.contact = { id: 'contact-1', account_id: 'acct-1', name: 'Jane', phone: '15551234' }
  h.state.conversation = { id: 'conv-1' }
  h.state.waConfig = { provider: 'uazapi', user_id: 'user-1' }
  h.state.lastCustomerMessage = null
  h.state.updates = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.generateReply.mockResolvedValue({ text: 'Hi Jane, friendly reminder about your deposit.', handoff: false, usage: null })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'wamid-1' })
})

describe('processDueBillingTasks', () => {
  it('sends a reminder and marks it sent (UAZAPI — no window restriction)', async () => {
    await processDueBillingTasks()

    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        aiGenerated: true,
      }),
    )
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'sent' }) },
    ])
  })

  it('resolves the contact through the linked deal when the task has none directly', async () => {
    h.state.dueTasks = [{ ...TASK, contact_id: null, deal_id: 'deal-1' }]
    h.state.deal = { contact_id: 'contact-1', title: 'Wedding photos', value: 500, currency: 'BRL' }

    await processDueBillingTasks()

    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'contact-1' }))
    const [args] = h.generateReply.mock.calls[0]
    expect(args.systemPrompt).toContain('Wedding photos')
  })

  it('marks the task failed (no retry storm) when no contact can be resolved', async () => {
    h.state.dueTasks = [{ ...TASK, contact_id: null, deal_id: null }]

    await processDueBillingTasks()

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'failed' }) },
    ])
  })

  it('leaves the task untouched when AI is not configured (self-heals once configured)', async () => {
    h.loadAiConfig.mockResolvedValue(null)

    await processDueBillingTasks()

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updates).toEqual([])
  })

  it('blocks the send on Meta when the contact is outside the 24h window', async () => {
    h.state.waConfig = { provider: 'meta', user_id: 'user-1' }
    h.state.lastCustomerMessage = null // never messaged, or long ago either way

    await processDueBillingTasks()

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'blocked_window' }) },
    ])
  })

  it('sends on Meta when the contact messaged within the last 24h', async () => {
    h.state.waConfig = { provider: 'meta', user_id: 'user-1' }
    h.state.lastCustomerMessage = { created_at: new Date(Date.now() - 60_000).toISOString() }

    await processDueBillingTasks()

    expect(h.engineSendText).toHaveBeenCalled()
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'sent' }) },
    ])
  })

  it('marks the task failed when the send itself throws', async () => {
    h.engineSendText.mockRejectedValue(new Error('provider down'))

    await processDueBillingTasks()

    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'failed' }) },
    ])
  })

  it('does nothing when there are no due tasks', async () => {
    h.state.dueTasks = []
    await processDueBillingTasks()
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})

describe('processDueProposalFollowupTasks', () => {
  it('sends a follow-up and marks it sent (UAZAPI — no window restriction)', async () => {
    await processDueProposalFollowupTasks()

    expect(h.generateReply).toHaveBeenCalledTimes(1)
    const [args] = h.generateReply.mock.calls[0]
    expect(args.systemPrompt).toContain('follow-up')
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        contactId: 'contact-1',
        conversationId: 'conv-1',
        aiGenerated: true,
      }),
    )
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'sent' }) },
    ])
  })

  it('resolves the contact through the linked deal and mentions it in the prompt', async () => {
    h.state.dueTasks = [{ ...TASK, contact_id: null, deal_id: 'deal-1' }]
    h.state.deal = { contact_id: 'contact-1', title: 'Wedding photos proposal', value: 500, currency: 'BRL' }

    await processDueProposalFollowupTasks()

    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'contact-1' }))
    const [args] = h.generateReply.mock.calls[0]
    expect(args.systemPrompt).toContain('Wedding photos proposal')
  })

  it('marks the task failed (no retry storm) when no contact can be resolved', async () => {
    h.state.dueTasks = [{ ...TASK, contact_id: null, deal_id: null }]

    await processDueProposalFollowupTasks()

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'failed' }) },
    ])
  })

  it('blocks the send on Meta when the contact is outside the 24h window', async () => {
    h.state.waConfig = { provider: 'meta', user_id: 'user-1' }
    h.state.lastCustomerMessage = null

    await processDueProposalFollowupTasks()

    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updates).toEqual([
      { id: 'task-1', patch: expect.objectContaining({ reminder_status: 'blocked_window' }) },
    ])
  })

  it('does nothing when there are no due tasks', async () => {
    h.state.dueTasks = []
    await processDueProposalFollowupTasks()
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})
