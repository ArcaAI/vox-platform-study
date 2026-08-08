import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { TenantAllowedOriginController } from '../tenant-allowed-origin.controller';

// TASK-641: the blanket `assertGlobalAdmin()` imperative gate is GONE from
// this controller — see the rewritten class AUTH-NOTE. The controller no
// longer reads `user`/`roles` off CLS at all; it unconditionally delegates
// to `ITenantAllowedOriginService`, which is CLS-tenant-scoped on its own
// and (per Lane E) imperatively refuses a wildcard/SYSTEM write from a
// non-global caller ONE LAYER DOWN. That narrower boundary is out of scope
// for this file — it belongs to `tenant-allowed-origin.service.test.ts` —
// so these tests assert the controller behaves IDENTICALLY no matter who is
// calling (T-7): there is nothing left here to distinguish a TENANT_ADMIN
// from a GLOBAL_ADMIN caller.

vi.mock('../../../cors.config', () => ({
  isOriginEnforcementEnabled: vi.fn(),
}));

import { isOriginEnforcementEnabled } from '../../../cors.config';

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

  function build() {
    // No ClsService/user argument — the controller has no role awareness of
    // its own post-TASK-641. Any caller-role gate that survives lives in the
    // service (wildcard/SYSTEM) or in `@CanManage`/`UnifiedAuthGuard`
    // upstream of the handler (neither reachable from a unit test that
    // instantiates the controller directly).
    return new TenantAllowedOriginController(mockService as any);
  }

  describe('T-7 — every CRUD route is reachable regardless of caller role (FR-1, FR-5)', () => {
    it('getAll delegates straight to the service with no imperative gate', async () => {
      const rows = [createMockRow()];
      mockService.getAll.mockResolvedValue(rows);
      const controller = build();

      const result = await controller.getAll();

      expect(mockService.getAll).toHaveBeenCalledWith();
      expect(result).toBe(rows);
    });

    it('getById delegates straight to the service with no imperative gate', async () => {
      const row = createMockRow();
      mockService.getById.mockResolvedValue(row);
      const controller = build();

      const result = await controller.getById('origin-1');

      expect(mockService.getById).toHaveBeenCalledWith('origin-1');
      expect(result).toBe(row);
    });

    it('create delegates straight to the service with no imperative gate', async () => {
      const dto = { origin: 'https://arcaai-staging.bcmch.org', label: 'BCMCH staging' };
      const row = createMockRow();
      mockService.create.mockResolvedValue(row);
      const controller = build();

      const result = await controller.create(dto as any);

      expect(mockService.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(row);
    });

    it('update delegates straight to the service with no imperative gate, header version wins', async () => {
      const row = createMockRow({ version: 2 });
      mockService.update.mockResolvedValue(row);
      const controller = build();

      const result = await controller.update('origin-1', { label: 'Renamed', expectedVersion: 1 } as any, 7);

      expect(mockService.update).toHaveBeenCalledWith('origin-1', { label: 'Renamed', expectedVersion: 7 });
      expect(result).toBe(row);
    });

    it('update falls back to the body expectedVersion when the If-Match header is absent', async () => {
      const row = createMockRow({ version: 2 });
      mockService.update.mockResolvedValue(row);
      const controller = build();

      await controller.update('origin-1', { label: 'Renamed', expectedVersion: 1 } as any, undefined);

      expect(mockService.update).toHaveBeenCalledWith('origin-1', { label: 'Renamed', expectedVersion: 1 });
    });

    it('deleteById delegates straight to the service with no imperative gate', async () => {
      const row = createMockRow({ resourceStatus: 'DELETED' });
      mockService.deleteById.mockResolvedValue(row);
      const controller = build();

      const result = await controller.deleteById('origin-1');

      expect(mockService.deleteById).toHaveBeenCalledWith('origin-1');
      expect(result).toBe(row);
    });

    it('carries @RequiresIfMatch metadata on the update handler (OCC still wired)', () => {
      const handler = TenantAllowedOriginController.prototype.update;
      const requiresIfMatch = Reflect.getMetadata('requiresIfMatch', handler);
      expect(requiresIfMatch).toBe(true);
    });
  });

  describe('T-7 — cross-tenant id still answers 404, not 403, for every caller', () => {
    it('getById propagates the service NotFoundException verbatim (404-over-403)', async () => {
      mockService.getById.mockRejectedValue(new NotFoundException('Allowed origin origin-1 not found'));
      const controller = build();

      await expect(controller.getById('origin-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update propagates the service NotFoundException verbatim (404-over-403)', async () => {
      mockService.update.mockRejectedValue(new NotFoundException('Allowed origin origin-1 not found'));
      const controller = build();

      await expect(controller.update('origin-1', { label: 'X' } as any, 1)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deleteById propagates the service NotFoundException verbatim (404-over-403)', async () => {
      mockService.deleteById.mockRejectedValue(new NotFoundException('Allowed origin origin-1 not found'));
      const controller = build();

      await expect(controller.deleteById('origin-1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GET /admin/allowed-origins/posture (FR-4, §3.2 option A)', () => {
    it('reports enforcement ON when isOriginEnforcementEnabled() is true', () => {
      vi.mocked(isOriginEnforcementEnabled).mockReturnValue(true);
      const controller = build();

      expect(controller.getPosture()).toEqual({ enforcementEnabled: true });
    });

    it('reports enforcement OFF when isOriginEnforcementEnabled() is false', () => {
      vi.mocked(isOriginEnforcementEnabled).mockReturnValue(false);
      const controller = build();

      expect(controller.getPosture()).toEqual({ enforcementEnabled: false });
    });

    it('does not touch ITenantAllowedOriginService — posture is platform-wide, not a row', () => {
      vi.mocked(isOriginEnforcementEnabled).mockReturnValue(true);
      const controller = build();

      controller.getPosture();

      expect(mockService.getAll).not.toHaveBeenCalled();
      expect(mockService.getById).not.toHaveBeenCalled();
    });
  });
});
