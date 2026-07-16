import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from './index';
import { encrypt } from '@/lib/whatsapp/encryption';

// Minimal fake Response covering what uazapi-api reads (ok/status/text).
function fakeResponse(body: unknown, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return { ok, status, text: async () => text, json: async () => body } as Response;
}

function stubFetch(body: unknown, opts?: { ok?: boolean; status?: number }) {
  const fn = vi.fn(async () => fakeResponse(body, opts));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const UAZAPI_CONFIG = {
  provider: 'uazapi',
  uazapi_base_url: 'https://demo.uazapi.com',
  uazapi_instance_token: encrypt('inst-token-123'),
};

const META_CONFIG = {
  provider: 'meta',
  phone_number_id: 'PN1',
  access_token: encrypt('meta-access-token'),
};

describe('getProvider', () => {
  it('returns the Meta provider by default (no provider field)', () => {
    const provider = getProvider({
      phone_number_id: 'PN1',
      access_token: encrypt('t'),
    });
    expect(provider.kind).toBe('meta');
  });

  it('returns the Meta provider for provider="meta"', () => {
    expect(getProvider(META_CONFIG).kind).toBe('meta');
  });

  it('returns the UAZAPI provider for provider="uazapi"', () => {
    expect(getProvider(UAZAPI_CONFIG).kind).toBe('uazapi');
  });

  it('throws a clear error if UAZAPI is not connected yet', () => {
    expect(() =>
      getProvider({ provider: 'uazapi', uazapi_base_url: 'https://x.uazapi.com' })
    ).toThrow(/scan the QR/i);
  });
});

describe('UAZAPI provider — sending', () => {
  beforeEach(() => {
    /* fetch stubbed per-test */
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sendText posts to /send/text with the token header and returns the message id', async () => {
    const fetchMock = stubFetch({ messageid: 'MID-1' });
    const provider = getProvider(UAZAPI_CONFIG);
    const result = await provider.sendText({ to: '5511999999999', text: 'oi' });

    expect(result).toEqual({ messageId: 'MID-1', usedPhone: '5511999999999' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.uazapi.com/send/text');
    expect((init.headers as Record<string, string>).token).toBe('inst-token-123');
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999',
      text: 'oi',
    });
  });

  it('sendMedia maps the Meta media kind and sends file + docName', async () => {
    const fetchMock = stubFetch({ id: 'MID-2' });
    const provider = getProvider(UAZAPI_CONFIG);
    const result = await provider.sendMedia({
      to: '5511999999999',
      kind: 'document',
      link: 'https://example.com/f.pdf',
      caption: 'here',
      filename: 'f.pdf',
    });

    expect(result.messageId).toBe('MID-2');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.uazapi.com/send/media');
    expect(JSON.parse(init.body as string)).toEqual({
      number: '5511999999999',
      type: 'document',
      file: 'https://example.com/f.pdf',
      text: 'here',
      docName: 'f.pdf',
    });
  });

  it('sendInteractiveButtons encodes choices as "title|id" on /send/menu', async () => {
    const fetchMock = stubFetch({ messageid: 'MID-3' });
    const provider = getProvider(UAZAPI_CONFIG);
    await provider.sendInteractiveButtons({
      to: '5511999999999',
      bodyText: 'Pick',
      buttons: [
        { id: 'yes', title: 'Yes' },
        { id: 'no', title: 'No' },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://demo.uazapi.com/send/menu');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('button');
    expect(body.choices).toEqual(['Yes|yes', 'No|no']);
  });

  it('sendInteractiveList encodes sections + rows and sets listButton', async () => {
    const fetchMock = stubFetch({ messageid: 'MID-4' });
    const provider = getProvider(UAZAPI_CONFIG);
    await provider.sendInteractiveList({
      to: '5511999999999',
      bodyText: 'Menu',
      buttonLabel: 'Open',
      sections: [
        {
          title: 'Food',
          rows: [
            { id: 'p', title: 'Pizza', description: 'cheesy' },
            { id: 'b', title: 'Burger' },
          ],
        },
      ],
    });
    const body = JSON.parse(
      (stubFetchLastInit(fetchMock).body as string) || '{}'
    );
    expect(body.type).toBe('list');
    expect(body.listButton).toBe('Open');
    expect(body.choices).toEqual(['[Food]', 'Pizza|p|cheesy', 'Burger|b']);
  });

  it('sendTemplate rejects — templates are Meta-only', async () => {
    const provider = getProvider(UAZAPI_CONFIG);
    await expect(
      provider.sendTemplate({ to: '5511999999999', templateName: 'welcome' })
    ).rejects.toThrow(/only available on the Meta provider/i);
  });

  it('surfaces the UAZAPI error message on a non-2xx response', async () => {
    stubFetch({ error: 'Invalid token' }, { ok: false, status: 401 });
    const provider = getProvider(UAZAPI_CONFIG);
    await expect(
      provider.sendText({ to: '5511999999999', text: 'x' })
    ).rejects.toThrow('Invalid token');
  });
});

function stubFetchLastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const calls = fetchMock.mock.calls;
  return (calls[calls.length - 1] as unknown as [string, RequestInit])[1];
}
