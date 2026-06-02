/**
 * TASK-327 T1 — ScopeSyncInit invalidates the React Query cache on tenant
 * change (but not on initial mount). `@arcaai/vox` / `@arcaai/ui/*` are
 * irrelevant here, so the global vitest stubs are left in place; the auth
 * store and QueryClient are exercised for real.
 */
import { act } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScopeSyncInit } from '../scope-sync';
import { useAuthStore } from '@/store/auth-store';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={qc}>
      <ScopeSyncInit />
    </QueryClientProvider>,
  );
  return { spy };
}

describe('ScopeSyncInit (TASK-327 T1)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
  });

  it('does not invalidate queries on initial mount', () => {
    const { spy } = setup();
    expect(spy).not.toHaveBeenCalled();
  });

  it('invalidates all queries when the tenant changes', () => {
    const { spy } = setup();
    act(() => {
      useAuthStore.getState().setTenant('tenant-A', 'Tenant A');
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('invalidates again on a subsequent tenant change', () => {
    const { spy } = setup();
    act(() => {
      useAuthStore.getState().setTenant('tenant-A', 'Tenant A');
    });
    act(() => {
      useAuthStore.getState().setTenant('tenant-B', 'Tenant B');
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not re-invalidate when the tenant is re-selected with the same id', () => {
    const { spy } = setup();
    act(() => {
      useAuthStore.getState().setTenant('tenant-A', 'Tenant A');
    });
    act(() => {
      useAuthStore.getState().setTenant('tenant-A', 'Tenant A');
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
