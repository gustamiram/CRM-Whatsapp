// Shared helpers for the UAZAPI connection routes.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Columns the UAZAPI connect/status/disconnect routes read + write. */
export interface UazapiConfigRow {
  id: string;
  provider: string;
  uazapi_base_url: string | null;
  uazapi_admin_token: string | null;
  uazapi_instance_id: string | null;
  uazapi_instance_token: string | null;
  uazapi_webhook_secret: string | null;
  uazapi_status: string | null;
}

const UAZAPI_COLUMNS =
  'id, provider, uazapi_base_url, uazapi_admin_token, uazapi_instance_id, uazapi_instance_token, uazapi_webhook_secret, uazapi_status';

/** Load the account's UAZAPI config row (RLS-scoped client). */
export async function loadUazapiConfig(
  supabase: SupabaseClient,
  accountId: string
): Promise<UazapiConfigRow | null> {
  const { data } = await supabase
    .from('whatsapp_config')
    .select(UAZAPI_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as UazapiConfigRow | null) ?? null;
}

/**
 * Canonical origin for building the inbound webhook URL. Prefers
 * NEXT_PUBLIC_SITE_URL (needed when the request-derived host would be
 * wrong — e.g. behind a tunnel), else derives it from the request.
 */
export function resolveOrigin(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const url = new URL(request.url);
  const proto =
    request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  const host =
    request.headers.get('x-forwarded-host') ??
    request.headers.get('host') ??
    url.host;
  return `${proto}://${host}`;
}

/** Build the tenancy-scoped inbound webhook URL for an account's secret. */
export function uazapiWebhookUrl(request: Request, secret: string): string {
  return `${resolveOrigin(request)}/api/whatsapp/uazapi/webhook/${secret}`;
}
