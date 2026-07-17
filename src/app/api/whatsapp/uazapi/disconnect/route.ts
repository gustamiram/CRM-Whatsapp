import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { loadUazapiConfig } from '@/lib/whatsapp/uazapi-config';
import { disconnectInstance } from '@/lib/whatsapp/uazapi-api';

/**
 * POST /api/whatsapp/uazapi/disconnect
 *
 * Ends the WhatsApp session on the instance. The instance + token are
 * kept so the user can reconnect with a fresh QR without re-creating it.
 */
export async function POST() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const row = await loadUazapiConfig(supabase, accountId);

    if (row?.uazapi_base_url && row.uazapi_instance_token) {
      try {
        await disconnectInstance({
          baseUrl: row.uazapi_base_url,
          instanceToken: decrypt(row.uazapi_instance_token),
        });
      } catch (err) {
        // Best-effort — even if the remote call fails we still flip our
        // local status so the UI reflects the user's intent.
        console.warn('[uazapi/disconnect] remote disconnect failed:', err);
      }
    }

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: 'disconnected',
        // Mirror onto the shared column the inbox/overview read.
        status: 'disconnected',
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
