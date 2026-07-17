// ============================================================
// Provider factory — the single entry point every send path uses.
//
//   const provider = getProvider(config)   // config = whatsapp_config row
//   await provider.sendText({ to, text })
//
// Switches on the row's `provider` discriminator (migration 037),
// defaulting to Meta for any row that predates it.
// ============================================================

import type { WhatsAppProvider, ProviderConfigRow } from './types';
import { createMetaProvider } from './meta';
import { createUazapiProvider } from './uazapi';

export * from './types';

export function getProvider(config: ProviderConfigRow): WhatsAppProvider {
  const kind = (config.provider ?? 'meta') as string;
  if (kind === 'uazapi') return createUazapiProvider(config);
  return createMetaProvider(config);
}
