import { supabaseAdmin } from './admin-client'

interface AutoAddArgs {
  accountId: string
  /** Stamped as deals.user_id — same configOwnerUserId already used to
   *  stamp the conversation row in inbound-core.ts. */
  userId: string
  contactId: string
  conversationId: string
  contactName: string | null
  contactPhone: string
}

/**
 * Auto-create a deal for a contact whose conversation was just created
 * (fires exactly once per contact, ever — see findOrCreateConversation in
 * inbound-core.ts), landing it in the account's configured default
 * pipeline's first stage (lowest `position`).
 *
 * No-op when the account has no default pipeline set — that's the
 * feature's on/off switch (accounts.default_pipeline_id, migration 041).
 *
 * Must never throw — called from the webhook route's `after()` chain,
 * same contract as runAutomationsForTrigger.
 */
export async function autoAddContactToDefaultPipeline(
  args: AutoAddArgs,
): Promise<void> {
  try {
    const db = supabaseAdmin()

    const { data: account, error: acctErr } = await db
      .from('accounts')
      .select('default_pipeline_id, default_currency')
      .eq('id', args.accountId)
      .maybeSingle()
    if (acctErr || !account?.default_pipeline_id) return

    const { data: firstStage, error: stageErr } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('pipeline_id', account.default_pipeline_id)
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (stageErr || !firstStage) {
      console.warn(
        `[auto-add-to-pipeline] default pipeline ${account.default_pipeline_id} has no stages — skipping`,
      )
      return
    }

    const { error: insertErr } = await db.from('deals').insert({
      account_id: args.accountId,
      user_id: args.userId,
      pipeline_id: account.default_pipeline_id,
      stage_id: firstStage.id,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      title: args.contactName || args.contactPhone,
      value: 0,
      currency: account.default_currency ?? 'USD',
      status: 'open',
    })
    if (insertErr) {
      console.error('[auto-add-to-pipeline] deal insert failed:', insertErr)
    }
  } catch (err) {
    console.error('[auto-add-to-pipeline] failed:', err)
  }
}
