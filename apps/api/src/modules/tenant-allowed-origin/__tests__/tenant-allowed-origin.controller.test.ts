import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { TenantAllowedOriginController } from '../tenant-allowed-origin.controller';

// CLS mock — the controller reads `user` (for the imperative
// global-admin gate, TASK-610 §3.4 item 6) off CLS, matching the house
// pattern in `department.controller.test.ts` / `harness-admin.controller.ts`.
function createMockCls(user: { id?: string; tenantId?: string | null; roles?: string[] } | null) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      return undefined;
    }),
  };
}

const GLOBAL_ADMIN_USER = { id: 'u-admin', tenantId: 'tenant-1', roles: ['GLOBAL_ADMIN'] };
const TENANT_ADMIN_USER = { id: 'u-tenant', tenantId: 'tenant-1', roles: ['TENANT_ADMIN'] };

const createMockRow = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'origin-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  isPlatform: overrides.isPlatform ?? false,
  origin: overrides.origin ?? 'https://arcaai-staging.bcmch.org',
  label: overrides.label ?? 'BCMCH staging',
  description: overrides.description,
  resourceStatus: overrides.resourceStatus ?? 'ENABLED',
  createdAt: overrides.createdAt ?? '2026-08-04T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-08-04T00:00:00.000Z',
  version: overrides.version ?? 1,
});

const createMockService = () => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
});

describe('TenantAllowedOriginController', () => {
  let mockService: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockService();
  });

  function build(user: { id?: string; tenantId?: string | null; roles?: string[] } | null) {
    const cls = createMockCls(user);
    return new TenantAllowedOriginController(mockService as any, cls as any);
  }

  describe('global-admin gate (AUTH-NOTE — imperative, decorator alone cannot express it)', () => {
    it('refuses getAll for a non-global-admin caller and never reaches the service', async () => {
      const controller = build(TENANT_ADMIN_USER);
      await expect(controller.getAll()).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockService.getAll).not.toHaveBeenCalled();
    });

    it('refuses getById for a non-global-admin caller', async () => {
      const controller = build(TENANT_ADMIN_USER);
      await expect(controller.getById('origin-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockService.getById).not.toHaveBeenCalled();
    });

    it('refuses create for a non-global-admin caller', async () => {
      const controller = build(TENANT_ADMIN_USER);
      await expect(controller.create({ origin: 'https://x.org', label: 'X' } as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockService.create).not.toHaveBeenCalled();
    });

    it('refuses update for a non-global-admin caller', async () => {
      const controller = build(TENANT_ADMIN_USER);
      await expect(controller.update('origin-1', { expectedVersion: 1 } as any, 1)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockService.update).not.toHaveBeenCalled();
    });

    it('refuses deleteById for a non-global-admin caller', async () => {
      const controller = build(TENANT_ADMIN_USER);
      await expect(controller.deleteById('origin-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockService.deleteById).not.toHaveBeenCalled();
    });

    it('refuses every route for an unauthenticated (null) caller', async () => {
      const controller = build(null);
      await expect(controller.getAll()).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GET /admin/allowed-origins (getAll) — global admin', () => {
    it('delegates to service.getAll with no arguments', async () => {
      const rows = [createMockRow()];
      mockService.getAll.mockResolvedValue(rows);
      const controller = build(GLOBAL_ADMIN_USER);

      const result = await controller.getAll();

      expect(mockService.getAll).toHaveBeenCalledWith();
      expect(result).toBe(rows);
    });
  });

  describe('GET /admin/allowed-origins/:id (getById) — global admin', () => {
    it('delegates to service.getById with the id param', async () => {
      const row = createMockRow();
      mockService.getById.mockResolvedValue(row);
      const controller = build(GLOBAL_ADMIN_USER);

      const result = await controller.getById('origin-1');

      expect(mockService.getById).toHaveBeenCalledWith('origin-1');
      expect(result).toBe(row);
    });
  });

  describe('POST /admin/allowed-origins (create) — global admin', () => {
    it('delegates to service.create with the request body', async () => {
      const dto = { origin: 'https://arcaai-staging.bcmch.org', label: 'BCMCH staging' };
      const row = createMockRow();
      mockService.create.mockResolvedValue(row);
      const controller = build(GLOBAL_ADMIN_USER);

      const result = await controller.create(dto as any);

      expect(mockService.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(row);
    });
  });

  describe('PATCH /admin/allowed-origins/:id (update) — global admin + OCC', () => {
    it('carries @RequiresIfMatch and @ExpectedVersion (OCC decorators) on the route handler', () => {
      // Reflect on the metadata the decorators attach — mirrors how
      // `admin-route-permission-audit.ts` reads route metadata, and proves
      // the PATCH route is wired for the house OCC pattern
      // (`department.controller.ts#update`) without needing a live guard.
      const handler = TenantAllowedOriginController.prototype.update;
      const requiresIfMatch = Reflect.getMetadata('requiresIfMatch', handler);
      expect(requiresIfMatch).toBe(true);
    });

    it('prefers the If-Match header version over the body expectedVersion', async () => {
      const row = createMockRow({ version: 2 });
      mockService.update.mockResolvedValue(row);
      const controller = build(GLOBAL_ADMIN_USER);

      const result = await controller.update('origin-1', { label: 'Renamed', expectedVersion: 1 } as any, 7);

      expect(mockService.update).toHaveBeenCalledWith('origin-1', { label: 'Renamed', expectedVersion: 7 });
      expect(result).toBe(row);
    });

    it('falls back to the body expectedVersion when the header is absent', async () => {
      const row = createMockRow({ version: 2 });
      mockService.update.mockResolvedValue(row);
      const controller = build(GLOBAL_ADMIN_USER);

      await controller.update('origin-1', { label: 'Renamed', expectedVersion: 1 } as any, undefined);

      expect(mockService.update).toHaveBeenCalledWith('origin-1', { label: 'Renamed', expectedVersion: 1 });
    });
  });

  describe('DELETE /admin/allowed-origins/:id (deleteById) — global admin', () => {
    it('delegates to service.deleteById with the id param', async () => {
      const row = createMockRow({ resourceStatus: 'DELETED' });
      mockService.deleteById.mockResolvedValue(row);
      const controller = build(GLOBAL_ADMIN_USER);

      const result = await controller.deleteById('origin-1');

      expect(mockService.deleteById).toHaveBeenCalledWith('origin-1');
      expect(result).toBe(row);
    });
  });
});
