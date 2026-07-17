import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstance,
  connectInstance,
  getInstanceStatus,
  setWebhook,
} from './uazapi-api';

function fakeResponse(body: unknown, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return { ok, status, text: async () => text, json: async () => body } as Response;
}

function stubFetch(body: unknown, opts?: { ok?: boolean; status?: number }) {
  const fn = vi.fn(async () => fakeResponse(body, opts));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('uazapi-api', () => {
  it('createInstance uses the admintoken header and returns the instance token', async () => {
    const fetchMock = stubFetch({
      token: 'inst-tok',
      instance: { id: 'inst-1', status: 'disconnected' },
    });
    const result = await createInstance({
      baseUrl: 'https://demo.uazapi.com/',
      adminToken: 'admin-xyz',
      name: 'wacrm-abc',
    });
    expect(result).toEqual({ instanceToken: 'inst-tok', instanceId: 'inst-1' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Trailing slash on baseUrl is normalized away.
    expect(url).toBe('https://demo.uazapi.com/instance/create');
    expect((init.headers as Record<string, string>).admintoken).toBe('admin-xyz');
    expect((init.headers as Record<string, string>).token).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ name: 'wacrm-abc' });
  });

  it('createInstance throws if no token is returned', async () => {
    stubFetch({ instance: { id: 'inst-1' } });
    await expect(
      createInstance({
        baseUrl: 'https://demo.uazapi.com',
        adminToken: 'a',
        name: 'n',
      })
    ).rejects.toThrow(/did not return an instance token/i);
  });

  it('connectInstance returns the QR snapshot from a nested instance object', async () => {
    stubFetch({ instance: { status: 'connecting', qrcode: 'base64qr' } });
    const snap = await connectInstance({
      baseUrl: 'https://demo.uazapi.com',
      instanceToken: 'tok',
    });
    expect(snap.status).toBe('connecting');
    expect(snap.qrcode).toBe('base64qr');
  });

  it('getInstanceStatus reads top-level status fields too', async () => {
    const fetchMock = stubFetch({ status: 'connected', profileName: 'Acme' });
    const snap = await getInstanceStatus({
      baseUrl: 'https://demo.uazapi.com',
      instanceToken: 'tok',
    });
    expect(snap.status).toBe('connected');
    expect(snap.profileName).toBe('Acme');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('GET');
  });

  it('setWebhook defaults events and always excludes wasSentByApi', async () => {
    const fetchMock = stubFetch({ ok: true });
    await setWebhook({
      baseUrl: 'https://demo.uazapi.com',
      instanceToken: 'tok',
      url: 'https://crm.example.com/api/whatsapp/uazapi/webhook/secret',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.uazapi.com/webhook');
    const body = JSON.parse(init.body as string);
    expect(body.excludeMessages).toContain('wasSentByApi');
    expect(body.events).toEqual(['messages', 'connection']);
    expect(body.url).toContain('/uazapi/webhook/secret');
  });

  it('throws with the server error message on a non-2xx', async () => {
    stubFetch({ error: 'Invalid AdminToken Header' }, { ok: false, status: 403 });
    await expect(
      createInstance({ baseUrl: 'https://demo.uazapi.com', adminToken: 'bad', name: 'n' })
    ).rejects.toThrow('Invalid AdminToken Header');
  });
});
