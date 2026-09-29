/**
 * Starting a download from inside an open model drawer must refresh the model
 * reads, so the drawer sees DOWNLOADING and locks the edit form (a heartbeat
 * bumps the row's version on every beat, so an unlocked save would 412).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStartModelDownload } from '../hooks';
import { aiModelKeys } from '../keys';
import { startModelDownload } from '../client';

vi.mock('../client', () => ({ startModelDownload: vi.fn() }));

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useStartModelDownload', () => {
  it('invalidates the model reads once the download is accepted, so an open drawer locks', async () => {
    vi.mocked(startModelDownload).mockResolvedValue({ jobId: 'job-1' } as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(() => useStartModelDownload(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync('m1');
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: aiModelKeys.root });
  });
});
