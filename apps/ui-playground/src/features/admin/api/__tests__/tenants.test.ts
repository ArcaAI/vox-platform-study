import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useTenantConfigs,
  useUpdateTenantConfigs,
  useMyTenantConfigs,
  useUpdateMyTenantConfigs,
  useTenants,
  useTenant,
  useTenantUsage,
  useTenantsInfinite,
  useCreateTenant,
  useUpdateTenant,
  useDeleteTenant,
  useToggleTenantStatus,
  type TenantConfig,
  type Tenant,
  type TenantUsage,
  type UpdateTenantConfigItem,
} from '../tenants';

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
const mockPatch = adminClient.patch as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;
const mockDelete = adminClient.delete as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const TENANT_ID = 't-100';

function makeTenantConfig(overrides?: Partial<TenantConfig>): TenantConfig {
  return {
    id: 'cfg-001',
    name: 'Default Language',
    key: 'default-language',
    value: 'en',
    dataType: 'String',
    namespace: 'general',
    tenantId: TENANT_ID,
    tenantCode: 'ACME',
    ...overrides,
  };
}

function makeTenant(overrides?: Partial<Tenant>): Tenant {
  return {
    id: TENANT_ID,
    name: 'Acme Corp',
    key: 'acme',
    resourceStatus: 'ENABLED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function paginatedResponse<T>(data: T[], count?: number) {
  return { data, count: count ?? data.length, limit: 25, page: 1 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Tenant API hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // useTenants
  // -----------------------------------------------------------------------
  describe('useTenants', () => {
    it('should call GET /admin/tenants', async () => {
      const tenants = [makeTenant()];
      mockGet.mockResolvedValueOnce(paginatedResponse(tenants));

      const { result } = renderHook(() => useTenants(), { wrapper: createWrapper() });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/admin/tenants');
      expect(result.current.data?.data).toEqual(tenants);
    });

    it('should pass pagination params as query string', async () => {
      mockGet.mockResolvedValueOnce(paginatedResponse([]));

      const { result } = renderHook(
        () => useTenants({ page: 2, limit: 10 }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(
        expect.stringContaining('/admin/tenants?'),
      );
      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=10');
    });
  });

  // -----------------------------------------------------------------------
  // useTenantsInfinite
  // -----------------------------------------------------------------------
  describe('useTenantsInfinite', () => {
    it('should call GET /admin/tenants with page 1 initially', async () => {
      mockGet.mockResolvedValueOnce(paginatedResponse([makeTenant()], 1));

      const { result } = renderHook(
        () => useTenantsInfinite(25),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=1');
      expect(calledUrl).toContain('limit=25');
    });
  });

  // -----------------------------------------------------------------------
  // useTenant (single)
  // -----------------------------------------------------------------------
  describe('useTenant', () => {
    it('should call GET /admin/tenants/:id', async () => {
      const tenant = makeTenant();
      mockGet.mockResolvedValueOnce(tenant);

      const { result } = renderHook(
        () => useTenant(TENANT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/tenants/${TENANT_ID}`);
      expect(result.current.data).toEqual(tenant);
    });

    it('should not fetch when id is empty', async () => {
      const { result } = renderHook(
        () => useTenant(''),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // useTenantUsage
  // -----------------------------------------------------------------------
  describe('useTenantUsage', () => {
    it('should call GET /admin/tenants/:id/usage', async () => {
      const usage: TenantUsage = {
        totalUsers: 5,
        totalDepartments: 2,
        totalPromptTemplates: 3,
        totalPipelines: 1,
      };
      mockGet.mockResolvedValueOnce(usage);

      const { result } = renderHook(
        () => useTenantUsage(TENANT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/tenants/${TENANT_ID}/usage`);
      expect(result.current.data).toEqual(usage);
    });
  });

  // -----------------------------------------------------------------------
  // useTenantConfigs
  // -----------------------------------------------------------------------
  describe('useTenantConfigs', () => {
    it('should call GET /admin/tenants/configs/:identifier', async () => {
      const configs = [makeTenantConfig()];
      mockGet.mockResolvedValueOnce(paginatedResponse(configs));

      const { result } = renderHook(
        () => useTenantConfigs(TENANT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith(`/admin/tenants/configs/${TENANT_ID}`);
      expect(result.current.data?.data).toEqual(configs);
    });

    it('should pass pagination query params', async () => {
      mockGet.mockResolvedValueOnce(paginatedResponse([]));

      const { result } = renderHook(
        () => useTenantConfigs(TENANT_ID, { page: 1, limit: 300 }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const calledUrl = mockGet.mock.calls[0][0] as string;
      expect(calledUrl).toContain('page=1');
      expect(calledUrl).toContain('limit=300');
    });

    it('should not fetch when identifier is empty', async () => {
      const { result } = renderHook(
        () => useTenantConfigs(''),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('should return configs with locked field (TASK-244)', async () => {
      const configs = [
        makeTenantConfig({ id: 'cfg-locked', locked: true }),
        makeTenantConfig({ id: 'cfg-unlocked' }),
      ];
      mockGet.mockResolvedValueOnce(paginatedResponse(configs));

      const { result } = renderHook(
        () => useTenantConfigs(TENANT_ID),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      const data = result.current.data!.data;
      expect(data[0]).toHaveProperty('locked', true);
      expect(data[1]).not.toHaveProperty('locked');
    });
  });

  // -----------------------------------------------------------------------
  // useMyTenantConfigs
  // -----------------------------------------------------------------------
  describe('useMyTenantConfigs', () => {
    it('should call GET /tenant/me/config', async () => {
      const configs = [makeTenantConfig({ tenantId: 'my-tenant' })];
      mockGet.mockResolvedValueOnce(paginatedResponse(configs));

      const { result } = renderHook(
        () => useMyTenantConfigs(),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockGet).toHaveBeenCalledWith('/tenant/me/config');
      expect(result.current.data?.data).toEqual(configs);
    });

    it('should respect enabled option', async () => {
      const { result } = renderHook(
        () => useMyTenantConfigs({ enabled: false }),
        { wrapper: createWrapper() },
      );

      await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // useUpdateTenantConfigs
  // -----------------------------------------------------------------------
  describe('useUpdateTenantConfigs', () => {
    it('should call PATCH /admin/tenants/configs/:identifier with config array', async () => {
      const updated = paginatedResponse([makeTenantConfig({ value: 'fr' })]);
      mockPatch.mockResolvedValueOnce(updated);

      const { result } = renderHook(
        () => useUpdateTenantConfigs(),
        { wrapper: createWrapper() },
      );

      const payload: UpdateTenantConfigItem[] = [
        { id: 'cfg-001', value: 'fr' },
      ];

      result.current.mutate({ identifier: TENANT_ID, configs: payload });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        `/admin/tenants/configs/${TENANT_ID}`,
        payload,
      );
    });

    it('should send description when provided', async () => {
      mockPatch.mockResolvedValueOnce(paginatedResponse([]));

      const { result } = renderHook(
        () => useUpdateTenantConfigs(),
        { wrapper: createWrapper() },
      );

      const payload: UpdateTenantConfigItem[] = [
        { id: 'cfg-001', value: 'updated', description: 'New desc' },
      ];

      result.current.mutate({ identifier: TENANT_ID, configs: payload });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ description: 'New desc' }),
        ]),
      );
    });

    it('should propagate API errors', async () => {
      mockPatch.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(
        () => useUpdateTenantConfigs(),
        { wrapper: createWrapper() },
      );

      result.current.mutate({
        identifier: TENANT_ID,
        configs: [{ id: 'cfg-001', value: 'bad' }],
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toBe('Network error');
    });
  });

  // -----------------------------------------------------------------------
  // useUpdateMyTenantConfigs
  // -----------------------------------------------------------------------
  describe('useUpdateMyTenantConfigs', () => {
    it('should call PATCH /tenant/me/config with config array', async () => {
      const updated = paginatedResponse([makeTenantConfig({ value: 'ja' })]);
      mockPatch.mockResolvedValueOnce(updated);

      const { result } = renderHook(
        () => useUpdateMyTenantConfigs(),
        { wrapper: createWrapper() },
      );

      const payload: UpdateTenantConfigItem[] = [
        { id: 'cfg-001', value: 'ja' },
      ];

      result.current.mutate(payload);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith('/tenant/me/config', payload);
    });

    it('should propagate API errors', async () => {
      mockPatch.mockRejectedValueOnce(new Error('Forbidden'));

      const { result } = renderHook(
        () => useUpdateMyTenantConfigs(),
        { wrapper: createWrapper() },
      );

      result.current.mutate([{ id: 'cfg-001', value: 'bad' }]);

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error?.message).toBe('Forbidden');
    });
  });

  // -----------------------------------------------------------------------
  // useCreateTenant
  // -----------------------------------------------------------------------
  describe('useCreateTenant', () => {
    it('should call POST /admin/tenants with tenant input', async () => {
      const created = makeTenant({ id: 't-new', name: 'New Org', key: 'new-org' });
      mockPost.mockResolvedValueOnce(created);

      const { result } = renderHook(
        () => useCreateTenant(),
        { wrapper: createWrapper() },
      );

      result.current.mutate({ name: 'New Org', key: 'new-org' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPost).toHaveBeenCalledWith('/admin/tenants', {
        name: 'New Org',
        key: 'new-org',
      });
    });
  });

  // -----------------------------------------------------------------------
  // useUpdateTenant
  // -----------------------------------------------------------------------
  describe('useUpdateTenant', () => {
    it('should call PATCH /admin/tenants/:id with update payload', async () => {
      const updated = makeTenant({ name: 'Renamed Corp' });
      mockPatch.mockResolvedValueOnce(updated);

      const { result } = renderHook(
        () => useUpdateTenant(),
        { wrapper: createWrapper() },
      );

      result.current.mutate({ id: TENANT_ID, name: 'Renamed Corp' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        `/admin/tenants/${TENANT_ID}`,
        { name: 'Renamed Corp' },
      );
    });
  });

  // -----------------------------------------------------------------------
  // useToggleTenantStatus
  // -----------------------------------------------------------------------
  describe('useToggleTenantStatus', () => {
    it('should call PATCH /admin/tenants/:id with resourceStatus', async () => {
      mockPatch.mockResolvedValueOnce(makeTenant({ resourceStatus: 'DISABLED' }));

      const { result } = renderHook(
        () => useToggleTenantStatus(),
        { wrapper: createWrapper() },
      );

      result.current.mutate({ id: TENANT_ID, resourceStatus: 'DISABLED' });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockPatch).toHaveBeenCalledWith(
        `/admin/tenants/${TENANT_ID}`,
        { resourceStatus: 'DISABLED' },
      );
    });
  });

  // -----------------------------------------------------------------------
  // useDeleteTenant
  // -----------------------------------------------------------------------
  describe('useDeleteTenant', () => {
    it('should call DELETE /admin/tenants/:id', async () => {
      mockDelete.mockResolvedValueOnce(undefined);

      const { result } = renderHook(
        () => useDeleteTenant(),
        { wrapper: createWrapper() },
      );

      result.current.mutate(TENANT_ID);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockDelete).toHaveBeenCalledWith(`/admin/tenants/${TENANT_ID}`);
    });
  });
});
