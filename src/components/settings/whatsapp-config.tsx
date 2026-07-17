'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircle, QrCode, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';
import { MetaConfig } from './meta-config';
import { UazapiConfig } from './uazapi-config';

type Provider = 'meta' | 'uazapi';

/**
 * WhatsApp settings tab. Lets the account choose which provider to
 * connect through — the official Meta Cloud API (credentials) or UAZAPI
 * (QR code) — and renders the matching panel. The active provider is
 * whichever was last saved/connected; switching tabs only changes the
 * panel in view until the user saves within it.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const [selected, setSelected] = useState<Provider>('meta');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp/uazapi/config');
        const data = await res.json();
        if (!cancelled && data.provider === 'uazapi') setSelected('uazapi');
      } catch {
        // Default to Meta on any failure.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {/* Provider selector */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <ProviderCard
          active={selected === 'meta'}
          onClick={() => setSelected('meta')}
          icon={<MessageCircle className="size-5" />}
          title={t('providerMetaTitle')}
          description={t('providerMetaDesc')}
        />
        <ProviderCard
          active={selected === 'uazapi'}
          onClick={() => setSelected('uazapi')}
          icon={<QrCode className="size-5" />}
          title={t('providerUazapiTitle')}
          description={t('providerUazapiDesc')}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : selected === 'meta' ? (
        <MetaConfig />
      ) : (
        <UazapiConfig />
      )}
    </section>
  );
}

function ProviderCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-muted'
      )}
    >
      <span
        className={cn(
          'mt-0.5 shrink-0',
          active ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {icon}
      </span>
      <span className="space-y-0.5">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
