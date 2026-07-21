import { describe, it, expect } from 'vitest'
import { buildHandoffSummary, buildObjectiveCompleteSummary } from './handoff'

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. Last customer message: “I want a refund”',
    )
  })

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    })
    expect(summary).toContain('after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(summary).toContain('handed off without replying.')
    expect(summary).toContain('“agent please”')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(summary).toBe('🤖 AI agent handed off without replying.')
  })
})

describe('buildObjectiveCompleteSummary', () => {
  it('quotes the last customer message', () => {
    const summary = buildObjectiveCompleteSummary({
      messages: [
        { role: 'user', content: 'my name is Jane' },
        { role: 'assistant', content: 'Thanks Jane!' },
        { role: 'user', content: 'jane@example.com' },
      ],
    })
    expect(summary).toBe(
      '🤖 AI agent completed its configured objective and stopped auto-replying. Last customer message: “jane@example.com”',
    )
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildObjectiveCompleteSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
    })
    expect(summary).toBe('🤖 AI agent completed its configured objective and stopped auto-replying.')
  })

  it('reads distinctly from the handoff summary (not an escalation)', () => {
    const messages = [{ role: 'user' as const, content: 'ok great' }]
    const handoff = buildHandoffSummary({ messages, replyCount: 1 })
    const done = buildObjectiveCompleteSummary({ messages })
    expect(done).not.toBe(handoff)
    expect(done).not.toContain('handed off')
  })
})
