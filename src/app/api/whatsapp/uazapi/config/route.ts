import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { encrypt } from '@/lib/whatsapp/encryption';
import { loadUazapiConfig } from '@/lib/whatsapp/uazapi-config';

/**
 * GET /api/whatsapp/uazapi/config
 * Returns the (non-secret) UAZAPI connection state for the UI.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const row = await loadUazapiConfig(supabase, accountId);
    return NextResponse.json({
      configured: Boolean(row?.uazapi_base_url),
      provider: row?.provider ?? 'meta',
      base_url: row?.uazapi_base_url ?? null,
      status: row?.uazapi_status ?? 'disconnected',
      connected: row?.uazapi_status === 'connected',
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/whatsapp/uazapi/config
 * Save the account's UAZAPI server URL + admin token and switch the
 * active provider to 'uazapi'. Credentials are stored encrypted; the
 * instance itself is created later by /connect.
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId } = await getCurrentAccount();
    const body = await request.json();
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    const adminToken =
      typeof body.admin_token === 'string' ? body.admin_token.trim() : '';

    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      return NextResponse.json(
        { error: 'A valid UAZAPI server URL (https://…) is required.' },
        { status: 400 }
      );
    }
    if (!adminToken) {
      return NextResponse.json(
        { error: 'The UAZAPI admin token is required.' },
        { status: 400 }
      );
    }

    let encryptedAdminToken: string;
    try {
      encryptedAdminToken = encrypt(adminToken);
    } catch (err) {
      console.error('[uazapi/config] admin token encryption failed:', err);
      return NextResponse.json(
        {
          error:
            'Failed to encrypt the token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
        },
        { status: 500 }
      );
    }

    const existing = await loadUazapiConfig(supabase, accountId);
    // Changing the server invalidates any instance created on the old
    // one — clear the instance so /connect re-creates it.
    const serverChanged =
      existing?.uazapi_base_url != null &&
      existing.uazapi_base_url !== baseUrl;

    const row = {
      provider: 'uazapi' as const,
      uazapi_base_url: baseUrl,
      uazapi_admin_token: encryptedAdminToken,
      // Preserve an existing secret so a previously-registered webhook
      // URL keeps working; mint one on first save.
      uazapi_webhook_secret:
        existing?.uazapi_webhook_secret ??
        crypto.randomBytes(24).toString('hex'),
      uazapi_status: 'disconnected' as const,
      updated_at: new Date().toISOString(),
      ...(serverChanged
        ? {
            uazapi_instance_id: null,
            uazapi_instance_token: null,
            uazapi_profile_name: null,
            uazapi_phone: null,
          }
        : {}),
    };

    if (existing) {
      const { error } = await supabase
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', accountId);
      if (error) {
        console.error('[uazapi/config] update failed:', error);
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 });
      }
    } else {
      const { error } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...row });
      if (error) {
        console.error('[uazapi/config] insert failed:', error);
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/whatsapp/uazapi/config
 * Clear the UAZAPI credentials and switch the active provider back to
 * Meta (any Meta credentials on the row are left intact).
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        provider: 'meta',
        uazapi_base_url: null,
        uazapi_admin_token: null,
        uazapi_instance_id: null,
        uazapi_instance_token: null,
        uazapi_webhook_secret: null,
        uazapi_status: null,
        uazapi_profile_name: null,
        uazapi_phone: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);
    if (error) {
      console.error('[uazapi/config] delete failed:', error);
      return NextResponse.json({ error: 'Failed to reset configuration' }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
