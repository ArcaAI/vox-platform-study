/**
 * Erasure mutations (playground SELF plane). Both DELETE routes wipe reads
 * that live under several feature keys — my-style, the mine rows and every
 * versions timeline — so the contract asserted here is the ROOT-level
 * invalidation the existing mutations use. The settings key sits under the
 * same root deliberately: erase and opt-out are INDEPENDENT, so the toggle is
 * re-read (and must come back unchanged), never mutated.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEraseMyReport, useEraseMyStyle } from '../hooks';
import { playgroundDnaKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
}

function stubFetch(body: unknown = { doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 }): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return Response.json(body);
    }),
  );
  return calls;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

/** Seeds every feature read so invalidation is observable on each key. */
function seedFeatureCache(queryClient: QueryClient) {
  queryClient.setQueryData(playgroundDnaKeys.myStyle(), { data: { id: 'rep-1' }, etag: '"3"' });
  queryClient.setQueryData(playgroundDnaKeys.reports(), [{ id: 'rep-1' }]);
  queryClient.setQueryData(playgroundDnaKeys.versions('rep-1'), []);
  queryClient.setQueryData(playgroundDnaKeys.settings(), { doctorToggle: true, tenantEnabled: true, effective: true, version: 2 });
}

const FEATURE_KEYS = [
  playgroundDnaKeys.myStyle(),
  playgroundDnaKeys.reports(),
  playgroundDnaKeys.versions('rep-1'),
  playgroundDnaKeys.settings(),
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useEraseMyStyle', () => {
  it('DELETEs my-style and invalidates every feature read', async () => {
    const calls = stubFetch();
    const { queryClient, Wrapper } = createWrapper();
    seedFeatureCache(queryClient);

    const { result } = renderHook(() => useEraseMyStyle(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(calls).toEqual([{ method: 'DELETE', url: '/api/hope/dna-writing-styles/my-style' }]);
    await waitFor(() => expect(result.current.data).toEqual({ doctorId: 'doc-1', deletedReports: 2, deletedVersions: 5 }));
    await waitFor(() => {
      for (const key of FEATURE_KEYS) {
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      }
    });
  });

  it('leaves the cache untouched when the erase fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ message: 'Impersonate a doctor to erase.', statusCode: 403 }, { status: 403 })),
    );
    const { queryClient, Wrapper } = createWrapper();
    seedFeatureCache(queryClient);

    const { result } = renderHook(() => useEraseMyStyle(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync().catch(() => undefined);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    for (const key of FEATURE_KEYS) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    }
  });
});

describe('useEraseMyReport', () => {
  it('DELETEs the single report and invalidates every feature read', async () => {
    const calls = stubFetch({ doctorId: 'doc-1', deletedReports: 1, deletedVersions: 3 });
    const { queryClient, Wrapper } = createWrapper();
    seedFeatureCache(queryClient);

    const { result } = renderHook(() => useEraseMyReport(), { wrapper: Wrapper });
    await act(async () => {
      await result.current.mutateAsync('rep-1');
    });

    expect(calls).toEqual([{ method: 'DELETE', url: '/api/hope/dna-writing-styles/rep-1' }]);
    await waitFor(() => {
      for (const key of FEATURE_KEYS) {
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
      }
    });
  });
});
