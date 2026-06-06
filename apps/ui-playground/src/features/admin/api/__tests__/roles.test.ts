import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useRoles, type Role } from '../roles';

vi.mock('../admin-client', () => ({
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

function makeRole(overrides?: Partial<Role>): Role {
  return {
    id: 'role-1',
    name: 'TENANT_ADMIN',
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// AC-04 (TASK-336): RBAC returns `{ data, total, page, pageSize }` and reads the
// page-size query param as `pageSize` — NOT the admin `count`/`limit` envelope the
// FE types declared. These tests lock the FE-side normalization in both
// directions: outgoing `limit` → `pageSize` (fixes "page size stuck"), and the
// incoming RBAC envelope → admin `{ count, limit }`.
describe('useRoles — AC-04 RBAC pagination envelope normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests the RBAC `pageSize` param (not `limit`) so the requested page size is honored', async () => {
    mockGet.mockResolvedValueOnce({ data: [], total: 0, page: 1, pageSize: 100 });

    const { result } = renderHook(() => useRoles({ page: 1, limit: 100 }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const calledUrl = mockGet.mock.calls[0][0] as string;
    expect(calledUrl).toContain('pageSize=100');
    expect(calledUrl).not.toContain('limit=100');
  });

  it('normalizes the RBAC `{ total, pageSize }` envelope to admin `{ count, limit }`', async () => {
    const roles = [makeRole()];
    mockGet.mockResolvedValueOnce({ data: roles, total: 42, page: 2, pageSize: 20 });

    const { result } = renderHook(() => useRoles({ page: 2, limit: 20 }), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ data: roles, count: 42, limit: 20, page: 2 });
  });
});
