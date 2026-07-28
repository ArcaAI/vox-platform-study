import { vi } from 'vitest';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

export type FetchHandler = (call: RecordedCall) => Response | undefined;

/**
 * Stubs global fetch (per the feature-api test pattern): records every call —
 * including headers, for If-Match assertions — and lets the test branch on
 * URL/method. Unhandled calls throw so a missing stub is loud. Callers
 * unstub in afterEach.
 */
export function installFetchStub(handle: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const call: RecordedCall = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const response = handle(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}
