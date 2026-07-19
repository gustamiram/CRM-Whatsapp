import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client — mirrors src/lib/ai/admin-client.ts,
// src/lib/automations/admin-client.ts, src/lib/flows/admin-client.ts. The
// inbound webhook has no auth.uid(), so the auto-add-to-pipeline path reads
// account config and writes the deal through the service role.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
