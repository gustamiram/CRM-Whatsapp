import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/** Most recent customer turn, truncated to a glanceable quote — or
 *  null when the transcript has no customer message at all. Shared by
 *  both internal-note builders below. */
function lastCustomerQuote(messages: ChatMessage[]): string | null {
  const lastCustomer = [...messages].reverse().find((m) => m.role === 'user' && m.content.trim())
  return lastCustomer ? truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN) : null
}

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
}): string {
  const { messages, replyCount } = args

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}.`
  const quote = lastCustomerQuote(messages)
  return quote ? `${base} Last customer message: “${quote}”` : base
}

/**
 * Build the short internal note left when the bot decides it has fully
 * accomplished the goal described in the account's own instructions
 * (OBJECTIVE_COMPLETE_SENTINEL — see src/lib/ai/defaults.ts) and stops
 * auto-replying. Distinct wording from `buildHandoffSummary` so the
 * paused banner (src/components/inbox/ai-thread-banner.tsx) doesn't
 * read as an urgent escalation — this is a successful stop, not a
 * "needs a human" signal.
 */
export function buildObjectiveCompleteSummary(args: { messages: ChatMessage[] }): string {
  const base = '🤖 AI agent completed its configured objective and stopped auto-replying.'
  const quote = lastCustomerQuote(args.messages)
  return quote ? `${base} Last customer message: “${quote}”` : base
}
