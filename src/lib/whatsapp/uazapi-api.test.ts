import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInstance,
  connectInstance,
  findMessages,
  getInstanceStatus,
  requestHistorySync,
  setWebhook,
} from './uazapi-api';

function fakeResponse(body: unknown, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
    json: async () => body,
  } as Response;
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
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // Trailing slash on baseUrl is normalized away.
    expect(url).toBe('https://demo.uazapi.com/instance/create');
    expect((init.headers as Record<string, string>).admintoken).toBe(
      'admin-xyz'
    );
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
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe('GET');
  });

  it('setWebhook defaults events and always excludes wasSentByApi', async () => {
    const fetchMock = stubFetch({ ok: true });
    await setWebhook({
      baseUrl: 'https://demo.uazapi.com',
      instanceToken: 'tok',
      url: 'https://crm.example.com/api/whatsapp/uazapi/webhook/secret',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://demo.uazapi.com/webhook');
    const body = JSON.parse(init.body as string);
    expect(body.excludeMessages).toContain('wasSentByApi');
    expect(body.events).toEqual(['messages', 'connection', 'history']);
    expect(body.url).toContain('/uazapi/webhook/secret');
  });

  it('requestHistorySync requests up to 100 older messages for one chat', async () => {
    const fetchMock = stubFetch({ success: true });
    const result = await requestHistorySync({
      baseUrl: 'https://demo.uazapi.com/',
      instanceToken: 'inst-tok',
      number: '5511999999999@s.whatsapp.net',
      count: 250,
    });

    expect(result).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://demo.uazapi.com/message/history-sync');
    expect((init.headers as Record<string, string>).token).toBe('inst-tok');
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999@s.whatsapp.net',
      mode: 'history',
      count: 100,
    });
  });

  it('findMessages reads a paginated chat page from the provider store', async () => {
    const fetchMock = stubFetch({
      returnedMessages: 2,
      messages: [
        {
          messageid: 'msg-2',
          chatid: '5511999999999@s.whatsapp.net',
        },
        {
          messageid: 'msg-1',
          chatid: '5511999999999@s.whatsapp.net',
        },
      ],
      limit: 100,
      offset: 0,
      nextOffset: 2,
      hasMore: true,
    });

    const result = await findMessages({
      baseUrl: 'https://demo.uazapi.com/',
      instanceToken: 'inst-tok',
      chatId: '5511999999999@s.whatsapp.net',
      limit: 100,
      offset: 0,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.nextOffset).toBe(2);
    expect(result.hasMore).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://demo.uazapi.com/message/find');
    expect(JSON.parse(init.body as string)).toEqual({
      chatid: '5511999999999@s.whatsapp.net',
      limit: 100,
      offset: 0,
    });
  });

  it('requestHistorySync includes an optional anchor message', async () => {
    const fetchMock = stubFetch({ success: true });
    await requestHistorySync({
      baseUrl: 'https://demo.uazapi.com',
      instanceToken: 'inst-tok',
      number: '123456@lid',
      count: 20,
      messageId: '3EB01234567890ABCDEF',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).toEqual({
      number: '123456@lid',
      mode: 'history',
      count: 20,
      messageid: '3EB01234567890ABCDEF',
    });
  });

  it('throws with the server error message on a non-2xx', async () => {
    stubFetch(
      { error: 'Invalid AdminToken Header' },
      { ok: false, status: 403 }
    );
    await expect(
      createInstance({
        baseUrl: 'https://demo.uazapi.com',
        adminToken: 'bad',
        name: 'n',
      })
    ).rejects.toThrow('Invalid AdminToken Header');
  });
});
