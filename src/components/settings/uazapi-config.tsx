'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
  Loader2,
  QrCode,
  RotateCcw,
  Power,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const MASKED_TOKEN = '••••••••••••••••';
// Stop polling after roughly the QR's 2-minute lifetime.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 120_000;

type UazapiStatus = 'disconnected' | 'connecting' | 'connected' | 'hibernated';

export function UazapiConfig() {
  const t = useTranslations('Settings.whatsapp');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const [status, setStatus] = useState<UazapiStatus>('disconnected');
  const [profileName, setProfileName] = useState<string | null>(null);
  const [qrcode, setQrcode] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAt = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/config');
      const data = await res.json();
      setConfigured(Boolean(data.configured));
      setBaseUrl(data.base_url || '');
      setAdminToken(data.configured ? MASKED_TOKEN : '');
      setTokenEdited(false);
      setStatus((data.status as UazapiStatus) || 'disconnected');
    } catch (err) {
      console.error('[uazapi] load config failed:', err);
      toast.error(t('uazapi.loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadConfig();
    return () => stopPolling();
  }, [loadConfig, stopPolling]);

  const qrSrc = qrcode
    ? qrcode.startsWith('data:')
      ? qrcode
      : `data:image/png;base64,${qrcode}`
    : null;

  async function handleSave() {
    if (!baseUrl.trim() || !/^https?:\/\//i.test(baseUrl.trim())) {
      toast.error(t('uazapi.invalidUrl'));
      return;
    }
    if (!configured && (!adminToken.trim() || !tokenEdited)) {
      toast.error(t('uazapi.tokenRequired'));
      return;
    }
    const payload: Record<string, unknown> = { base_url: baseUrl.trim() };
    if (tokenEdited && adminToken !== MASKED_TOKEN && adminToken.trim()) {
      payload.admin_token = adminToken.trim();
    } else if (!configured) {
      toast.error(t('uazapi.tokenRequired'));
      return;
    } else {
      // Editing an existing config without changing the token: the server
      // keeps the stored admin token, so require a re-entry only when the
      // server URL changed (which invalidates the instance).
      payload.admin_token = undefined;
    }

    try {
      setSaving(true);
      const res = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('uazapi.saveError'));
        return;
      }
      toast.success(t('uazapi.saved'));
      await loadConfig();
    } catch (err) {
      console.error('[uazapi] save failed:', err);
      toast.error(t('uazapi.saveError'));
    } finally {
      setSaving(false);
    }
  }

  function pollStatus() {
    stopPolling();
    pollStartedAt.current = Date.now();
    pollTimer.current = setInterval(async () => {
      if (Date.now() - pollStartedAt.current > POLL_MAX_MS) {
        stopPolling();
        setQrcode(null);
        setStatus('disconnected');
        toast.error(t('uazapi.qrExpired'));
        return;
      }
      try {
        const res = await fetch('/api/whatsapp/uazapi/status');
        const data = await res.json();
        setStatus((data.status as UazapiStatus) || 'connecting');
        if (data.connected) {
          stopPolling();
          setQrcode(null);
          setProfileName(data.profile_name || null);
          toast.success(t('uazapi.connected'));
        } else if (data.qrcode) {
          setQrcode(data.qrcode);
        }
      } catch (err) {
        console.error('[uazapi] status poll failed:', err);
      }
    }, POLL_INTERVAL_MS);
  }

  async function handleConnect() {
    try {
      setConnecting(true);
      const res = await fetch('/api/whatsapp/uazapi/connect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('uazapi.connectError'));
        return;
      }
      setStatus((data.status as UazapiStatus) || 'connecting');
      if (data.connected || data.status === 'connected') {
        toast.success(t('uazapi.connected'));
        await loadConfig();
        return;
      }
      setQrcode(data.qrcode || null);
      pollStatus();
    } catch (err) {
      console.error('[uazapi] connect failed:', err);
      toast.error(t('uazapi.connectError'));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      setDisconnecting(true);
      stopPolling();
      const res = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || t('uazapi.disconnectError'));
        return;
      }
      setStatus('disconnected');
      setQrcode(null);
      setProfileName(null);
      toast.success(t('uazapi.disconnected'));
    } catch (err) {
      console.error('[uazapi] disconnect failed:', err);
      toast.error(t('uazapi.disconnectError'));
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('uazapi.resetConfirm'))) return;
    try {
      stopPolling();
      const res = await fetch('/api/whatsapp/uazapi/config', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('uazapi.resetError'));
        return;
      }
      setConfigured(false);
      setBaseUrl('');
      setAdminToken('');
      setTokenEdited(false);
      setStatus('disconnected');
      setQrcode(null);
      setProfileName(null);
      toast.success(t('uazapi.reset'));
    } catch (err) {
      console.error('[uazapi] reset failed:', err);
      toast.error(t('uazapi.resetError'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const isConnected = status === 'connected';

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-6">
      {/* Connection status */}
      <Alert className="bg-card border-border">
        <div className="flex items-center gap-2">
          {isConnected ? (
            <CheckCircle2 className="size-4 text-primary" />
          ) : (
            <XCircle className="size-4 text-red-500" />
          )}
          <AlertTitle className="text-foreground mb-0">
            {isConnected ? t('uazapi.statusConnected') : t('uazapi.statusDisconnected')}
          </AlertTitle>
        </div>
        <AlertDescription className="text-muted-foreground">
          {isConnected
            ? t('uazapi.connectedDesc', { name: profileName || '' })
            : t('uazapi.disconnectedDesc')}
        </AlertDescription>
      </Alert>

      {/* Credentials */}
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('uazapi.credentialsTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('uazapi.credentialsDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('uazapi.serverUrl')}</Label>
            <Input
              placeholder="https://api.uazapi.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('uazapi.adminToken')}</Label>
            <div className="relative">
              <Input
                type={showToken ? 'text' : 'password'}
                placeholder={t('uazapi.adminTokenPlaceholder')}
                value={adminToken}
                onChange={(e) => {
                  setAdminToken(e.target.value);
                  setTokenEdited(true);
                }}
                onFocus={() => {
                  if (adminToken === MASKED_TOKEN) {
                    setAdminToken('');
                    setTokenEdited(true);
                  }
                }}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{t('uazapi.adminTokenHint')}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('uazapi.save')}
            </Button>
            {configured && (
              <Button
                variant="outline"
                onClick={handleReset}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                <RotateCcw className="size-4" />
                {t('uazapi.reset')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* QR connection */}
      {configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('uazapi.qrTitle')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('uazapi.qrDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qrSrc && !isConnected && (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrSrc}
                  alt="WhatsApp QR code"
                  className="size-56 rounded-lg border border-border bg-white p-2"
                />
                <p className="text-xs text-muted-foreground text-center max-w-xs">
                  {t('uazapi.qrScanHint')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {!isConnected ? (
                <Button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {connecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <QrCode className="size-4" />
                  )}
                  {qrcode ? t('uazapi.regenerateQr') : t('uazapi.connect')}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  {disconnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Power className="size-4" />
                  )}
                  {t('uazapi.disconnect')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
