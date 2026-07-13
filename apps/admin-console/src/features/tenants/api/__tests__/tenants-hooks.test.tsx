/**
 * Representative hook-level test proving the TanStack wiring pattern shared by
 * every domain: reads expose { data, etag }, mutations plumb the ETag through
 * and invalidate the domain namespace. Client-level tests cover the rest.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ListParams } from '@/shared/api';
import { tenantKeys } from '../keys';
import { useProvisionTenant, useTenant, useTenants, useUpdateTenant } from '../hooks';

function createWrapper(queryClient: QueryClient) {
    return function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('tenant hooks', () => {
    it('useTenants keeps the previous rows visible while a params change refetches (TASK-428)', async () => {
        // First page resolves; the second request is held pending so the
        // transition state is observable.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request) => {
                if (String(input).includes('search=next')) return new Promise<Response>(() => {});
                return Response.json({ data: [{ id: 't-1', name: 'North' }], count: 1, limit: 25, page: 0 });
            }),
        );
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        const { result, rerender } = renderHook(({ params }: { params: ListParams }) => useTenants(params), {
            wrapper: createWrapper(queryClient),
            initialProps: { params: {} as ListParams },
        });
        await waitFor(() => expect(result.current.isSuccess).toBe(true));

        rerender({ params: { search: 'next' } });

        // The grid keeps the loaded rows (isBusy covers the refetch) instead of
        // dropping to the skeleton.
        expect(result.current.isFetching).toBe(true);
        expect(result.current.isPlaceholderData).toBe(true);
        expect(result.current.data?.data[0]?.name).toBe('North');
    });

    it('useTenant surfaces the row AND its ETag for the edit form', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ id: 't-1', name: 'North', version: 7 }, { headers: { etag: '"7"' } })),
        );
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

        const { result } = renderHook(() => useTenant('t-1'), { wrapper: createWrapper(queryClient) });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.data.name).toBe('North');
        expect(result.current.data?.etag).toBe('"7"');
    });

    it('useUpdateTenant sends the OCC headers and invalidates the tenants namespace', async () => {
        const fetchMock = vi.fn(async () => Response.json({ id: 't-1', version: 8 }, { headers: { etag: '"8"' } }));
        vi.stubGlobal('fetch', fetchMock);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

        const { result } = renderHook(() => useUpdateTenant(), { wrapper: createWrapper(queryClient) });
        result.current.mutate({ id: 't-1', patch: { name: 'Renamed' }, etag: '"7"' });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(new Headers(init.headers).get('if-match')).toBe('"7"');
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Renamed', expectedVersion: 7 });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: tenantKeys.root });
    });

    // TASK-497 §3.5 — global-admin create-tenant-with-admin.
    it('useProvisionTenant posts to admin/tenants/provision and invalidates the tenants namespace', async () => {
        const fetchMock = vi.fn(async () => Response.json({ tenant: { id: 't-1' }, adminUserId: 'u1', tenantKey: 'acme' }));
        vi.stubGlobal('fetch', fetchMock);
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

        const { result } = renderHook(() => useProvisionTenant(), { wrapper: createWrapper(queryClient) });
        result.current.mutate({ tenantName: 'Acme', admin: { mode: 'existing', userId: 'u1' } });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(String(url)).toContain('admin/tenants/provision');
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: tenantKeys.root });
    });
});
