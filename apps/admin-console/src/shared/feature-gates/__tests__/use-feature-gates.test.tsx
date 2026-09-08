import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_GATES_QUERY_KEY, invalidateFeatureGates, useFeatureGates } from '../use-feature-gates';

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFeatureGates', () => {
  it('starts loading with an empty (fail-closed) map', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [] })));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useFeatureGates(), { wrapper: Wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.gates).toEqual({});
  });

  it('resolves the effective map once the request settles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          items: [
            { key: 'console.tools.mcp.enabled', value: true, sourceScope: 'system' },
            { key: 'console.mlflow.enabled', value: false, sourceScope: 'default' },
          ],
        }),
      ),
    );
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useFeatureGates(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.gates).toEqual({ 'console.tools.mcp.enabled': true, 'console.mlflow.enabled': false });
    expect(result.current.isError).toBe(false);
  });

  it('fails closed to an empty map on a fetch error — never undefined, never a stale "on"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 })));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useFeatureGates(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.gates).toEqual({});
  });

  it('fails closed to an empty map on a 404 (the endpoint not reachable yet)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })));
    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useFeatureGates(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.gates).toEqual({});
  });
});

describe('invalidateFeatureGates', () => {
  it('invalidates the shared feature-gates query key', async () => {
    const { queryClient } = createWrapper();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    await invalidateFeatureGates(queryClient);

    expect(spy).toHaveBeenCalledWith({ queryKey: FEATURE_GATES_QUERY_KEY });
  });
});
