import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { engineSendText } from '@/lib/flows/meta-send'
import type { Task } from '@/types'

/**
 * Poll for `billing`-type tasks that just came due and haven't been
 * reminded about yet, and have the AI agent send each contact a
 * payment-reminder message.
 *
 * Called from the existing /api/automations/cron route (reuses the
 * external cron-job.org pinger already hitting that endpoint every
 * minute — no second scheduled job needed). Must never throw, same
 * contract as runAutomationsForTrigger: all errors are caught and
 * logged per-task so one bad row can't stop the rest.
 *
 * `status` (the human "mark done" checkbox) is never touched here —
 * sending a reminder isn't the same as the bill being settled.
 * `reminder_sent_at` is set exactly once per due occurrence so the
 * poller doesn't resend every minute once a task becomes due.
 */
export async function processDueBillingTasks(): Promise<void> {
  try {
    const db = supabaseAdmin()
    const { data: dueTasks, error } = await db
      .from('tasks')
      .select('*')
      .eq('task_type', 'billing')
      .eq('status', 'pending')
      .is('reminder_sent_at', null)
      .lte('due_at', new Date().toISOString())
      .limit(50)

    if (error) {
      console.error('[tasks] failed to fetch due billing tasks:', error)
      return
    }
    if (!dueTasks || dueTasks.length === 0) return

    for (const task of dueTasks as Task[]) {
      try {
        await processOneBillingTask(db, task)
      } catch (err) {
        console.error('[tasks] billing reminder failed:', task.id, err)
      }
    }
  } catch (err) {
    console.error('[tasks] processDueBillingTasks failed:', err)
  }
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

async function processOneBillingTask(db: SupabaseClient, task: Task) {
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
    console.error(`[tasks] billing task ${task.id} has no resolvable contact`)
    await markReminder(db, task.id, 'failed')
    return
  }

  const { data: contact } = await db
    .from('contacts')
    .select('id, account_id, name, phone')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) {
    console.error(`[tasks] billing task ${task.id}: contact ${contactId} not found`)
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
    console.error(`[tasks] billing task ${task.id}: no conversation for contact ${contactId}`)
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
    console.error(`[tasks] billing task ${task.id}: WhatsApp not configured for this account`)
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
        `[tasks] billing task ${task.id}: contact outside Meta's 24h window — reminder blocked, needs a human`,
      )
      await markReminder(db, task.id, 'blocked_window')
      return
    }
  }

  const systemPrompt = buildBillingReminderPrompt({
    contactName: contact.name || contact.phone,
    taskTitle: task.title,
    taskNotes: task.notes ?? null,
    dueAt: task.due_at ?? null,
    deal: dealInfo,
  })

  try {
    const { text } = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: 'Write the reminder message now.' }],
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
    console.error(`[tasks] billing task ${task.id}: send failed:`, err)
    await markReminder(db, task.id, 'failed')
  }
}

function buildBillingReminderPrompt(args: {
  contactName: string
  taskTitle: string
  taskNotes: string | null
  dueAt: string | null
  deal: { title: string; value: number; currency: string } | null
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
  return parts.join('\n')
}
