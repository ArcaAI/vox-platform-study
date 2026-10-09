/**
 * TASK-1055 lane C (E9) — "Reset to default" deletes the explicit keep-policy
 * row, so the model falls back to the implicit live-path / on-demand default.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api')>('@/shared/api');
  return { ...actual, request: (...args: unknown[]) => request(...args) };
});

import { deleteResidencyPolicy } from '../client';
import { useResetResidencyPolicy } from '../hooks';
import { modelResidencyKeys } from '../keys';

beforeEach(() => {
  request.mockReset().mockResolvedValue({ data: { id: 'pol-1' }, etag: null });
});

describe('deleteResidencyPolicy', () => {
  it('DELETEs the policy with If-Match built from its version', async () => {
    await deleteResidencyPolicy('pol/1', 4);
    expect(request).toHaveBeenCalledWith('admin/model-residency/policies/pol%2F1', { method: 'DELETE', etag: '"4"' });
  });
});

describe('useResetResidencyPolicy', () => {
  it('deletes the row and refreshes the catalogue', async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useResetResidencyPolicy(), { wrapper });
    result.current.mutate({ policyId: 'pol-1', policyVersion: 2 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(request).toHaveBeenCalledWith('admin/model-residency/policies/pol-1', { method: 'DELETE', etag: '"2"' });
    expect(spy).toHaveBeenCalledWith({ queryKey: modelResidencyKeys.catalogue() });
  });
});
