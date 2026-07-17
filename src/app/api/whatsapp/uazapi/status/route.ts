import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { loadUazapiConfig } from '@/lib/whatsapp/uazapi-config';
import { getInstanceStatus } from '@/lib/whatsapp/uazapi-api';

/**
 * GET /api/whatsapp/uazapi/status
 *
 * Polled by the UI while a QR is on screen. Returns the current instance
 * status + a refreshed QR, and persists the connected state (profile
 * name / phone) once the scan completes.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const row = await loadUazapiConfig(supabase, accountId);

    if (!row?.uazapi_base_url || !row.uazapi_instance_token) {
      return NextResponse.json({
        status: 'disconnected',
        qrcode: null,
        connected: false,
      });
    }

    const instanceToken = decrypt(row.uazapi_instance_token);
    const snapshot = await getInstanceStatus({
      baseUrl: row.uazapi_base_url,
      instanceToken,
    });

    const status = snapshot.status ?? 'disconnected';
    const connected = status === 'connected';

    // Mirror the connection onto the shared `status` column so the
    // provider-agnostic reads (inbox "connected" banner, settings
    // overview) recognise a UAZAPI connection — they key off `status`,
    // not `uazapi_status`. Written every poll (cheap, one row) so a row
    // that connected before this mirror existed self-heals.
    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: status,
        status: connected ? 'connected' : 'disconnected',
        ...(connected
          ? {
              connected_at: new Date().toISOString(),
              uazapi_profile_name: snapshot.profileName ?? null,
              uazapi_phone: snapshot.owner
                ? normalizePhone(String(snapshot.owner).split('@')[0])
                : null,
            }
          : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);

    return NextResponse.json({
      status,
      connected,
      qrcode: connected ? null : snapshot.qrcode ?? null,
      paircode: connected ? null : snapshot.paircode ?? null,
      profile_name: snapshot.profileName ?? null,
    });
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[uazapi/status] error:', err.message);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
