import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { retrieveUpcomingEvents } from './events'

/** Minimal fake matching the query chain in retrieveUpcomingEvents:
 *  from().select().eq().not().neq().gte().order().limit() → { data, error }. */
function fakeDb(result: { data: unknown[] | null; error: unknown }): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    not: () => chain,
    neq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => Promise.resolve(result),
  }
  return chain as unknown as SupabaseClient
}

describe('retrieveUpcomingEvents', () => {
  it('formats each row with contact name when present', async () => {
    const db = fakeDb({
      data: [
        {
          title: 'Consultation',
          expected_close_date: '2026-10-02T14:00:00+00:00',
          contacts: { name: 'Jane Doe' },
        },
      ],
      error: null,
    })
    const out = await retrieveUpcomingEvents(db, 'acct-1')
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('Consultation')
    expect(out[0]).toContain('Jane Doe')
  })

  it('omits the contact segment when there is no linked contact', async () => {
    const db = fakeDb({
      data: [
        {
          title: 'Solo event',
          expected_close_date: '2026-10-02T14:00:00+00:00',
          contacts: null,
        },
      ],
      error: null,
    })
    const out = await retrieveUpcomingEvents(db, 'acct-1')
    expect(out).toEqual([expect.stringContaining('Solo event')])
    expect(out[0]).not.toContain('(')
  })

  it('handles the array-shaped nested contact (PostgREST default)', async () => {
    const db = fakeDb({
      data: [
        {
          title: 'Array contact',
          expected_close_date: '2026-10-02T14:00:00+00:00',
          contacts: [{ name: 'Array Person' }],
        },
      ],
      error: null,
    })
    const out = await retrieveUpcomingEvents(db, 'acct-1')
    expect(out[0]).toContain('Array Person')
  })

  it('returns [] on a query error', async () => {
    const db = fakeDb({ data: null, error: { message: 'boom' } })
    const out = await retrieveUpcomingEvents(db, 'acct-1')
    expect(out).toEqual([])
  })

  it('never throws — swallows unexpected errors and returns []', async () => {
    const throwingDb = {
      from: () => {
        throw new Error('unexpected')
      },
    } as unknown as SupabaseClient
    const out = await retrieveUpcomingEvents(throwingDb, 'acct-1')
    expect(out).toEqual([])
  })
})
