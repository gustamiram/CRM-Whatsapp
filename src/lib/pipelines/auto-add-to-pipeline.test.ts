import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  state: {
    account: null as { default_pipeline_id: string | null; default_currency: string } | null,
    firstStage: null as { id: string } | null,
    insertError: null as { message: string } | null,
    insertedRows: [] as Record<string, unknown>[],
  },
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: h.state.account, error: null }),
            }),
          }),
        }
      }
      if (table === 'pipeline_stages') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: h.state.firstStage, error: null }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'deals') {
        return {
          insert: (payload: Record<string, unknown>) => {
            h.state.insertedRows.push(payload)
            return Promise.resolve({ error: h.state.insertError })
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { autoAddContactToDefaultPipeline } from './auto-add-to-pipeline'

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  contactName: 'Jane Doe',
  contactPhone: '+15551234567',
}

beforeEach(() => {
  h.state.account = null
  h.state.firstStage = null
  h.state.insertError = null
  h.state.insertedRows = []
})

describe('autoAddContactToDefaultPipeline', () => {
  it('is a no-op when the account has no default pipeline set', async () => {
    h.state.account = { default_pipeline_id: null, default_currency: 'USD' }
    await autoAddContactToDefaultPipeline(ARGS)
    expect(h.state.insertedRows).toHaveLength(0)
  })

  it('creates a deal in the pipeline\'s first stage when a default is set', async () => {
    h.state.account = { default_pipeline_id: 'pipe-1', default_currency: 'BRL' }
    h.state.firstStage = { id: 'stage-first' }

    await autoAddContactToDefaultPipeline(ARGS)

    expect(h.state.insertedRows).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        user_id: 'user-1',
        pipeline_id: 'pipe-1',
        stage_id: 'stage-first',
        contact_id: 'contact-1',
        conversation_id: 'conv-1',
        title: 'Jane Doe',
        value: 0,
        currency: 'BRL',
        status: 'open',
      }),
    ])
  })

  it('falls back to the contact phone as the title when no name is known', async () => {
    h.state.account = { default_pipeline_id: 'pipe-1', default_currency: 'USD' }
    h.state.firstStage = { id: 'stage-first' }

    await autoAddContactToDefaultPipeline({ ...ARGS, contactName: null })

    expect(h.state.insertedRows[0]).toMatchObject({ title: '+15551234567' })
  })

  it('does not throw when the pipeline has no stages', async () => {
    h.state.account = { default_pipeline_id: 'pipe-1', default_currency: 'USD' }
    h.state.firstStage = null
    await expect(autoAddContactToDefaultPipeline(ARGS)).resolves.toBeUndefined()
    expect(h.state.insertedRows).toHaveLength(0)
  })

  it('does not throw when the deal insert fails', async () => {
    h.state.account = { default_pipeline_id: 'pipe-1', default_currency: 'USD' }
    h.state.firstStage = { id: 'stage-first' }
    h.state.insertError = { message: 'boom' }
    await expect(autoAddContactToDefaultPipeline(ARGS)).resolves.toBeUndefined()
  })
})
