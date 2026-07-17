import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { loadUazapiConfig, uazapiWebhookUrl } from '@/lib/whatsapp/uazapi-config';
import {
  createInstance,
  connectInstance,
  getInstanceStatus,
  setWebhook,
} from '@/lib/whatsapp/uazapi-api';

/**
 * POST /api/whatsapp/uazapi/connect
 *
 * Ensures an instance exists (creating one via the admin token on first
 * call), starts the QR connection flow, registers our inbound webhook,
 * and returns the QR code for the UI to render + poll on.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const row = await loadUazapiConfig(supabase, accountId);

    if (!row?.uazapi_base_url || !row.uazapi_admin_token) {
      return NextResponse.json(
        { error: 'Save your UAZAPI server URL and admin token first.' },
        { status: 400 }
      );
    }
    const baseUrl = row.uazapi_base_url;

    // Create the instance on first connect. The per-instance token is
    // stored encrypted and reused on every subsequent call.
    let instanceToken: string;
    if (row.uazapi_instance_token) {
      instanceToken = decrypt(row.uazapi_instance_token);
    } else {
      const adminToken = decrypt(row.uazapi_admin_token);
      const created = await createInstance({
        baseUrl,
        adminToken,
        name: `wacrm-${accountId.slice(0, 8)}`,
      });
      instanceToken = created.instanceToken;
      await supabase
        .from('whatsapp_config')
        .update({
          uazapi_instance_id: created.instanceId ?? null,
          uazapi_instance_token: encrypt(instanceToken),
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId);
    }

    const webhookUrl = row.uazapi_webhook_secret
      ? uazapiWebhookUrl(request, row.uazapi_webhook_secret)
      : null;
    const registerWebhook = async () => {
      if (!webhookUrl) return;
      try {
        await setWebhook({ baseUrl, instanceToken, url: webhookUrl });
      } catch (err) {
        // Non-fatal — surface later, but let the flow continue.
        console.warn('[uazapi/connect] setWebhook failed:', err);
      }
    };

    // If the instance is already connected, don't start a fresh QR flow.
    // Just (re-)register the webhook — this is the path a user takes after
    // pointing NEXT_PUBLIC_SITE_URL at a public tunnel to re-point the
    // inbound URL without re-scanning.
    const current = await getInstanceStatus({ baseUrl, instanceToken });
    if (current.status === 'connected') {
      await registerWebhook();
      await supabase
        .from('whatsapp_config')
        .update({
          uazapi_status: 'connected',
          status: 'connected',
          connected_at: new Date().toISOString(),
          uazapi_profile_name: current.profileName ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId);
      return NextResponse.json({ status: 'connected', connected: true, qrcode: null });
    }

    // Register the inbound webhook before connecting so no early message
    // is missed (excludeMessages defaults to ['wasSentByApi'] to avoid
    // echo loops), then start the QR flow.
    await registerWebhook();
    const snapshot = await connectInstance({ baseUrl, instanceToken });

    await supabase
      .from('whatsapp_config')
      .update({
        uazapi_status: snapshot.status ?? 'connecting',
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);

    return NextResponse.json({
      status: snapshot.status ?? 'connecting',
      qrcode: snapshot.qrcode ?? null,
      paircode: snapshot.paircode ?? null,
    });
  } catch (err) {
    if (err instanceof Error && !('status' in err)) {
      console.error('[uazapi/connect] error:', err.message);
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return toErrorResponse(err);
  }
}
