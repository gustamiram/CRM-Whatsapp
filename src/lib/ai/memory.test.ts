import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

const h = vi.hoisted(() => ({
  generateReply: vi.fn(),
}))

vi.mock('./generate', () => ({ generateReply: h.generateReply }))

import { getConversationMemory, refreshConversationMemoryIfDue } from './memory'

function aiConfig(): AiConfig {
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
  }
}

/**
 * Minimal fake SupabaseClient covering only what memory.ts touches:
 * - conversations: select().eq().maybeSingle() / update().eq()
 * - messages: a count-mode query (awaited directly after the .eq()
 *   chain, no .range()) and a rows-mode query (.order().range()).
 * The two `messages` shapes are told apart by whether `select()` was
 * called with a `{ count }` option, matching how the real client
 * behaves (its query builder is itself a thenable).
 */
function makeDb(state: {
  conversation: Record<string, unknown> | null
  totalCount: number
  rows: { sender_type: string; content_text: string | null }[]
  updates: { id: string; patch: Record<string, unknown> }[]
}) {
  return {
    from(table: string) {
      if (table === 'conversations') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: state.conversation }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              state.updates.push({ id, patch })
              return Promise.resolve({ error: null })
            },
          }),
        }
        return chain
      }
      if (table === 'messages') {
        let isCount = false
        const chain: {
          select: (cols: string, opts?: { count?: string; head?: boolean }) => typeof chain
          eq: () => typeof chain
          order: () => typeof chain
          range: (from: number, to: number) => Promise<{ data: unknown; error: null }>
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>
        } = {
          select(_cols, opts) {
            if (opts?.count) isCount = true
            return chain
          },
          eq: () => chain,
          order: () => chain,
          range: (from, to) => Promise.resolve({ data: state.rows.slice(from, to + 1), error: null }),
          then: (resolve, reject) =>
            Promise.resolve({ count: isCount ? state.totalCount : null, data: null, error: null }).then(
              resolve,
              reject,
            ),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  h.generateReply.mockResolvedValue({ text: 'Updated memory.', handoff: false, usage: null })
})

describe('getConversationMemory', () => {
  it('returns the stored summary', async () => {
    const db = makeDb({
      conversation: { ai_memory_summary: 'Customer prefers morning calls.' },
      totalCount: 0,
      rows: [],
      updates: [],
    })
    expect(await getConversationMemory(db, 'conv-1')).toBe('Customer prefers morning calls.')
  })

  it('returns null when there is no memory yet', async () => {
    const db = makeDb({ conversation: { ai_memory_summary: null }, totalCount: 0, rows: [], updates: [] })
    expect(await getConversationMemory(db, 'conv-1')).toBeNull()
  })
})

describe('refreshConversationMemoryIfDue', () => {
  it('does nothing while the conversation is still under the context window', async () => {
    const state = {
      conversation: { ai_memory_summary: null, ai_memory_synced_count: 0 },
      totalCount: 15, // <= contextLimit(20): nothing has scrolled out yet
      rows: [],
      updates: [],
    }
    await refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
  })

  it('skips when not enough new messages have scrolled out yet (under the batch size)', async () => {
    const state = {
      conversation: { ai_memory_summary: null, ai_memory_synced_count: 0 },
      // pendingCutoff = 25 - 20 = 5, which is < the default batch size of 10
      totalCount: 25,
      rows: [],
      updates: [],
    }
    await refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
  })

  it('refreshes and advances synced_count once the batch threshold is met', async () => {
    const state = {
      conversation: { ai_memory_summary: null, ai_memory_synced_count: 0 },
      // pendingCutoff = 35 - 20 = 15, which is >= the default batch size of 10
      totalCount: 35,
      rows: Array.from({ length: 15 }, (_, i) => ({
        sender_type: i % 2 === 0 ? 'customer' : 'agent',
        content_text: `message ${i}`,
      })),
      updates: [],
    }
    await refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)

    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(state.updates).toEqual([
      {
        id: 'conv-1',
        patch: expect.objectContaining({
          ai_memory_summary: 'Updated memory.',
          ai_memory_synced_count: 15,
        }),
      },
    ])
  })

  it('merges the previous summary with the new transcript chunk in the prompt', async () => {
    const state = {
      conversation: { ai_memory_summary: 'Previously: customer asked about pricing.', ai_memory_synced_count: 0 },
      totalCount: 35,
      rows: [{ sender_type: 'customer', content_text: 'Actually I need it in blue.' }],
      updates: [],
    }
    // Force the batch check to pass regardless of row count by using a
    // small context limit relative to totalCount.
    await refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)

    const [args] = h.generateReply.mock.calls[0]
    expect(args.systemPrompt).toContain('Previously: customer asked about pricing.')
    expect(args.systemPrompt).toContain('Actually I need it in blue.')
  })

  it('never throws when the generation call fails', async () => {
    h.generateReply.mockRejectedValue(new Error('provider down'))
    const state = {
      conversation: { ai_memory_summary: null, ai_memory_synced_count: 0 },
      totalCount: 35,
      rows: Array.from({ length: 15 }, () => ({ sender_type: 'customer', content_text: 'hi' })),
      updates: [],
    }
    await expect(refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)).resolves.toBeUndefined()
    expect(state.updates).toEqual([])
  })

  it('does nothing when the conversation cannot be found', async () => {
    const state = { conversation: null, totalCount: 100, rows: [], updates: [] }
    await refreshConversationMemoryIfDue(makeDb(state), aiConfig(), 'conv-1', 20)
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})
