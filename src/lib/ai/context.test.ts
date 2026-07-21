import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_type: 'text', content_text: 'third' },
      { sender_type: 'agent', content_type: 'text', content_text: 'second' },
      { sender_type: 'customer', content_type: 'text', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_type: 'text', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'text', content_text: '   ' },
        { sender_type: 'customer', content_type: 'text', content_text: null },
        { sender_type: 'customer', content_type: 'text', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('uses ai_media_description (not content_text) for image/audio rows', async () => {
    // fakeDb rows are supplied newest-first (matching the real query's
    // created_at DESC order) — buildConversationContext reverses them
    // back to chronological, so the audio row (sent second) comes
    // first here.
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_type: 'audio',
          content_text: null,
          ai_media_description: '[Customer sent a voice message] "is this in stock?"',
        },
        {
          sender_type: 'customer',
          content_type: 'image',
          content_text: "customer's own caption",
          ai_media_description: '[Customer sent an image] A photo of a damaged shoe.',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: '[Customer sent an image] A photo of a damaged shoe.' },
      { role: 'user', content: '[Customer sent a voice message] "is this in stock?"' },
    ])
  })

  it('drops image/audio rows with no cached description', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_type: 'image', content_text: null, ai_media_description: null },
        { sender_type: 'customer', content_type: 'text', content_text: 'hello' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'hello' }])
  })
})
