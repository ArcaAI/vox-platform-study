import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeChangelog, listChangelog, listUnseenChangelog, publishChangelogEntry } from '../client';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stubFetch(handler: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('changelog api client', () => {
  it('listChangelog reads GET /changelog through the BFF proxy', async () => {
    const calls = stubFetch(() => Response.json({ data: [], count: 0, limit: 25, page: 1 }));
    await listChangelog({ severity: 'BREAKING' });
    expect(calls[0].url).toContain('/api/hope/changelog');
    expect(calls[0].url).toContain('severity=BREAKING');
    expect(calls[0].method).toBe('GET');
  });

  it('listUnseenChangelog reads GET /changelog/unseen', async () => {
    const calls = stubFetch(() => Response.json([]));
    const result = await listUnseenChangelog();
    expect(calls[0].url).toContain('/api/hope/changelog/unseen');
    expect(result).toEqual([]);
  });

  it('acknowledgeChangelog POSTs entryIds', async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await acknowledgeChangelog(['a', 'b']);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/hope/changelog/acknowledge');
    expect(calls[0].body).toEqual({ entryIds: ['a', 'b'] });
  });

  it('publishChangelogEntry sends If-Match from the given etag', async () => {
    const calls = stubFetch(() => Response.json({ id: 'x' }, { headers: { etag: '"3"' } }));
    await publishChangelogEntry('entry-1', '"2"');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/hope/admin/changelog/entry-1/publish');
    expect(calls[0].headers['if-match']).toBe('"2"');
  });
});
