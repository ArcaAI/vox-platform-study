/**
 * TASK-331 doc-09 — the clinician-facing template selector (Pre-Summary /
 * Summary) must fetch from the END-USER plane (`/prompt-templates/available`)
 * via the impersonation-aware `smrClient`, NOT the admin
 * `/admin/prompt-templates` route. The admin route requires
 * `manage:PromptTemplate` which doctors don't hold, so the old wiring 403'd and
 * the global query-cache handler bounced the whole app to `/403`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../smr-client', () => ({
  SmrApiError: class SmrApiError extends Error {},
  smrClient: { get: vi.fn() },
}));

import { smrClient } from '../smr-client';
import { usePromptTemplatesAvailable } from '../prompts';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('usePromptTemplatesAvailable (TASK-331 doc-09 — end-user template plane)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (smrClient.get as Mock).mockResolvedValue([
      { id: 'tpl-1', name: 'Tenant default', category: 'SUMMARY', content: 'c', currentVersionNumber: 1, createdAt: '', updatedAt: '' },
    ]);
  });

  it('GETs the end-user /prompt-templates/available route (never /admin/prompt-templates)', async () => {
    const { result } = renderHook(() => usePromptTemplatesAvailable('tenant-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(smrClient.get).toHaveBeenCalledTimes(1);
    const [path] = (smrClient.get as Mock).mock.calls[0] as [string];
    expect(path).toContain('/prompt-templates/available');
    expect(path).not.toContain('/admin/');
  });

  it('forwards the category filter as a query param', async () => {
    const { result } = renderHook(() => usePromptTemplatesAvailable('tenant-1', { category: 'SUMMARY' }), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const [path] = (smrClient.get as Mock).mock.calls[0] as [string];
    expect(path).toContain('category=SUMMARY');
  });

  it('returns the plain array produced by the end-user endpoint', async () => {
    const { result } = renderHook(() => usePromptTemplatesAvailable('tenant-1'), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0]?.id).toBe('tpl-1');
  });

  it('does not run while disabled (impersonation gate) — no fetch when enabled=false', async () => {
    const { result } = renderHook(() => usePromptTemplatesAvailable('tenant-1', undefined, { enabled: false }), { wrapper });

    // Give react-query a tick; a disabled query must never call the client.
    await new Promise((r) => setTimeout(r, 0));

    expect(smrClient.get).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });
});
