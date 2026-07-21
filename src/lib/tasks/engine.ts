import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { getConversationMemory } from '@/lib/ai/memory'
import { engineSendText } from '@/lib/flows/meta-send'
import type { Task, TaskType } from '@/types'

type PromptBuilder = (args: {
  contactName: string
  taskTitle: string
  taskNotes: string | null
  dueAt: string | null
  deal: { title: string; value: number; currency: string } | null
  memory: string | null
}) => string

/**
 * Shared poller: fetch pending, past-due, not-yet-reminded tasks of a
 * given `task_type` and have the AI agent message each one's contact,
 * drafted by `promptBuilder`.
 *
 * Called from the existing /api/automations/cron route (reuses the
 * external cron-job.org pinger already hitting that endpoint every
 * minute — no second scheduled job needed). Must never throw, same
 * contract as runAutomationsForTrigger: all errors are caught and
 * logged per-task so one bad row can't stop the rest.
 *
 * `status` (the human "mark done" checkbox) is never touched here —
 * sending a message isn't the same as the task being resolved.
 * `reminder_sent_at` is set exactly once per due occurrence so the
 * poller doesn't resend every minute once a task becomes due.
 */
async function processDueTasksOfType(taskType: TaskType, promptBuilder: PromptBuilder): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: dueTasks, error } = await db
      .from('tasks')
      .select('*')
      .eq('task_type', taskType)
      .eq('status', 'pending')
      .eq('ai_message_enabled', true)
      .is('reminder_sent_at', null)
      .lte('due_at', new Date().toISOString())
      .limit(50)

    if (error) {
      console.error(`[tasks] failed to fetch due ${taskType} tasks:`, error)
      return
    }
    if (!dueTasks || dueTasks.length === 0) return

    for (const task of dueTasks as Task[]) {
      try {
        await processOneAiMessageTask(db, task, promptBuilder)
      } catch (err) {
        console.error(`[tasks] ${taskType} message failed:`, task.id, err)
      }
    }
  } catch (err) {
    console.error(`[tasks] processDueTasksOfType(${taskType}) failed:`, err)
  }
}

/** Polls `billing` tasks — AI drafts and sends a payment reminder. */
export async function processDueBillingTasks(): Promise<void> {
  await processDueTasksOfType('billing', buildBillingReminderPrompt)
}

/** Polls `proposal_followup` tasks — AI asks what the customer thought
 *  of a proposal that was already sent. */
export async function processDueProposalFollowupTasks(): Promise<void> {
  await processDueTasksOfType('proposal_followup', buildProposalFollowupPrompt)
}

async function markReminder(
  db: SupabaseClient,
  taskId: string,
  status: 'sent' | 'blocked_window' | 'failed',
) {
  await db
    .from('tasks')
    .update({ reminder_status: status, reminder_sent_at: new Date().toISOString() })
    .eq('id', taskId)
}

async function processOneAiMessageTask(db: SupabaseClient, task: Task, promptBuilder: PromptBuilder) {
  // Resolve the contact: the task's own contact_id, falling back to its
  // linked deal's. Also pull the deal's title/value/currency (if any) so
  // the reminder can mention what's owed.
  let contactId = task.contact_id ?? null
  let dealInfo: { title: string; value: number; currency: string } | null = null

  if (task.deal_id) {
    const { data: dealRow } = await db
      .from('deals')
      .select('contact_id, title, value, currency')
      .eq('id', task.deal_id)
      .maybeSingle()
    if (dealRow) {
      dealInfo = { title: dealRow.title, value: dealRow.value, currency: dealRow.currency }
      if (!contactId) contactId = dealRow.contact_id
    }
  }

  if (!contactId) {
    // Shouldn't happen — both UI paths that create a billing task
    // require a contact — but stop the retry loop rather than
    // re-checking this row every minute forever.
    console.error(`[tasks] task ${task.id} has no resolvable contact`)
    await markReminder(db, task.id, 'failed')
    return
  }

  const { data: contact } = await db
    .from('contacts')
    .select('id, account_id, name, phone')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) {
    console.error(`[tasks] task ${task.id}: contact ${contactId} not found`)
    await markReminder(db, task.id, 'failed')
    return
  }

  const { data: conversation } = await db
    .from('conversations')
    .select('id')
    .eq('contact_id', contactId)
    .eq('account_id', contact.account_id)
    .maybeSingle()
  if (!conversation) {
    console.error(`[tasks] task ${task.id}: no conversation for contact ${contactId}`)
    await markReminder(db, task.id, 'failed')
    return
  }

  // AI must be configured to draft the message — if not, leave the task
  // untouched (no reminder_sent_at) so it self-heals the moment the
  // account configures/activates the AI agent.
  const config = await loadAiConfig(db, contact.account_id)
  if (!config) return

  // Meta requires an approved template outside the 24h customer-service
  // window — a freeform send there would just be rejected. UAZAPI has no
  // such restriction (confirmed: its sendTemplate() stub explicitly says
  // templates aren't a UAZAPI concept), so only gate the Meta provider.
  const { data: waConfig } = await db
    .from('whatsapp_config')
    .select('provider, user_id')
    .eq('account_id', contact.account_id)
    .maybeSingle()
  if (!waConfig) {
    console.error(`[tasks] task ${task.id}: WhatsApp not configured for this account`)
    await markReminder(db, task.id, 'failed')
    return
  }

  if ((waConfig.provider ?? 'meta') === 'meta') {
    const { data: lastCustomerMsg } = await db
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversation.id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const withinWindow =
      !!lastCustomerMsg &&
      Date.now() - new Date(lastCustomerMsg.created_at).getTime() < 24 * 60 * 60 * 1000
    if (!withinWindow) {
      console.warn(
        `[tasks] task ${task.id}: contact outside Meta's 24h window — message blocked, needs a human`,
      )
      await markReminder(db, task.id, 'blocked_window')
      return
    }
  }

  // Same rolling long-term memory the auto-reply bot uses (src/lib/ai/memory.ts)
  // — a billing/follow-up message sent after a long gap still carries
  // whatever the conversation already established, not just this
  // task's own title/notes.
  const memory = await getConversationMemory(db, conversation.id)

  const systemPrompt = promptBuilder({
    contactName: contact.name || contact.phone,
    taskTitle: task.title,
    taskNotes: task.notes ?? null,
    dueAt: task.due_at ?? null,
    deal: dealInfo,
    memory,
  })

  try {
    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: 'Write the message now.' }],
    })
    if (!text.trim()) throw new Error('empty generation')

    await engineSendText({
      accountId: contact.account_id,
      userId: waConfig.user_id,
      conversationId: conversation.id,
      contactId: contact.id,
      text,
      aiGenerated: true,
    })
    await markReminder(db, task.id, 'sent')
  } catch (err) {
    console.error(`[tasks] task ${task.id}: send failed:`, err)
    await markReminder(db, task.id, 'failed')
  }
}

function buildBillingReminderPrompt(args: {
  contactName: string
  taskTitle: string
  taskNotes: string | null
  dueAt: string | null
  deal: { title: string; value: number; currency: string } | null
  memory: string | null
}): string {
  const parts = [
    'You are drafting a single WhatsApp payment-reminder message on behalf of this business, to send directly to the customer below. Be short, polite, and clear about what is due. Do not include greetings-only filler or internal/staff-facing notes — output only the message text the customer should read.',
    `Customer: ${args.contactName}`,
    `Reminder: ${args.taskTitle}`,
  ]
  if (args.deal) {
    parts.push(`Related deal: ${args.deal.title} — ${args.deal.currency} ${args.deal.value}`)
  }
  if (args.taskNotes) parts.push(`Additional context: ${args.taskNotes}`)
  if (args.dueAt) parts.push(`Due: ${new Date(args.dueAt).toISOString()}`)
  if (args.memory) parts.push(`Conversation memory (earlier context that may have scrolled out of view):\n${args.memory}`)
  return parts.join('\n\n')
}

function buildProposalFollowupPrompt(args: {
  contactName: string
  taskTitle: string
  taskNotes: string | null
  dueAt: string | null
  deal: { title: string; value: number; currency: string } | null
  memory: string | null
}): string {
  const parts = [
    'You are drafting a single WhatsApp follow-up message on behalf of this business, to send directly to the customer below, asking what they thought of a proposal that was already sent to them. Be short, warm, and low-pressure — invite feedback or questions, do not re-quote pricing or re-send proposal details unless the customer asks. Do not include greetings-only filler or internal/staff-facing notes — output only the message text the customer should read.',
    `Customer: ${args.contactName}`,
    `Follow-up: ${args.taskTitle}`,
  ]
  if (args.deal) {
    parts.push(`Related proposal/deal: ${args.deal.title}${args.deal.value ? ` — ${args.deal.currency} ${args.deal.value}` : ''}`)
  }
  if (args.taskNotes) parts.push(`Additional context: ${args.taskNotes}`)
  if (args.memory) parts.push(`Conversation memory (earlier context that may have scrolled out of view):\n${args.memory}`)
  return parts.join('\n\n')
}
