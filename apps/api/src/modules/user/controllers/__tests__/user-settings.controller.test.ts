/**
 * UserSettingsController — selectedPipelineId validator
 *
 * Verifies that `PATCH /user/me/settings/arcaai-sdk/selectedPipelineId`
 * rejects cross-tenant pipeline ids with `BadRequestException` before
 * the value is persisted. Other namespace/key combinations remain
 * unaffected.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserSettingsController } from '../user-settings.controller';

const createMockUserSettingsService = () => ({
  fetchAllByUserId: vi.fn(),
  upsertByUserKeyNamespace: vi.fn(),
});

const createMockPipelineService = () => ({
  getById: vi.fn(),
  getBySlug: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getAll: vi.fn(),
  list: vi.fn(),
  validateYaml: vi.fn(),
});

const createMockClsService = (user?: { id: string; tenantId?: string | null }) => ({
  get: vi.fn((key: string) => {
    if (key === 'user') return user;
    return undefined;
  }),
});

const fakeSettingEntity = {
  id: 'setting-1',
  userId: 'user-1',
  namespace: 'arcaai-sdk',
  key: 'selectedPipelineId',
  value: 'pipe-OK',
  dataType: 'STRING',
  resourceStatus: 'ENABLED',
  createdAt: new Date(),
  updatedAt: new Date(),
  toObject: () => ({ id: 'setting-1' }),
};

describe('UserSettingsController — selectedPipelineId validator', () => {
  let controller: UserSettingsController;
  let userSettingsService: ReturnType<typeof createMockUserSettingsService>;
  let pipelineService: ReturnType<typeof createMockPipelineService>;
  let clsService: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    userSettingsService = createMockUserSettingsService();
    pipelineService = createMockPipelineService();
    clsService = createMockClsService({ id: 'user-1', tenantId: 'tenant-A' });

    userSettingsService.upsertByUserKeyNamespace.mockResolvedValue(fakeSettingEntity);

    controller = new UserSettingsController(
      userSettingsService as never,
      pipelineService as never,
      clsService as never,
    );
  });

  describe('updateSetting — arcaai-sdk:selectedPipelineId', () => {
    it('rejects cross-tenant pipeline id with BadRequestException', async () => {
      pipelineService.getById.mockResolvedValue(null);

      await expect(
        controller.updateSetting('arcaai-sdk', 'selectedPipelineId', {
          value: 'pipe-OTHER-TENANT',
          dataType: 'STRING' as never,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(pipelineService.getById).toHaveBeenCalledWith('pipe-OTHER-TENANT');
      expect(userSettingsService.upsertByUserKeyNamespace).not.toHaveBeenCalled();
    });

    it('accepts an in-tenant pipeline id and persists', async () => {
      pipelineService.getById.mockResolvedValue({
        id: 'pipe-OK',
        slug: 'doctor-default',
        name: 'Default',
      });

      await controller.updateSetting('arcaai-sdk', 'selectedPipelineId', {
        value: 'pipe-OK',
        dataType: 'STRING' as never,
      } as never);

      expect(pipelineService.getById).toHaveBeenCalledWith('pipe-OK');
      expect(userSettingsService.upsertByUserKeyNamespace).toHaveBeenCalledWith(
        'user-1',
        'arcaai-sdk',
        'selectedPipelineId',
        expect.objectContaining({ value: 'pipe-OK' }),
      );
    });

    it('does NOT validate for unrelated namespace/key combinations', async () => {
      await controller.updateSetting('arcaai-sdk', 'someOther', {
        value: 'whatever',
        dataType: 'STRING' as never,
      } as never);

      expect(pipelineService.getById).not.toHaveBeenCalled();
      expect(userSettingsService.upsertByUserKeyNamespace).toHaveBeenCalled();
    });

    it('does NOT validate for other namespaces with the same key', async () => {
      await controller.updateSetting('not-arcaai-sdk', 'selectedPipelineId', {
        value: 'pipe-x',
        dataType: 'STRING' as never,
      } as never);

      expect(pipelineService.getById).not.toHaveBeenCalled();
      expect(userSettingsService.upsertByUserKeyNamespace).toHaveBeenCalled();
    });
  });

  // The VirtualizedDataGrid persists per-user layout under the
  // `ui.data-grid` namespace via the existing PATCH endpoint. The namespace is
  // explicitly recognised and its value is guarded (valid JSON + size),
  // without breaking the open-namespace behaviour for other clients.
  describe('updateSetting — ui.data-grid namespace', () => {
    it('persists a valid JSON layout value (PATCH round-trip)', async () => {
      const layout = JSON.stringify({ columnOrder: ['a', 'b'], density: 'compact' });

      await controller.updateSetting('ui.data-grid', 'tenants-table', {
        value: layout,
        dataType: 'JSON' as never,
      } as never);

      // The pipeline validator must NOT fire for this namespace.
      expect(pipelineService.getById).not.toHaveBeenCalled();
      expect(userSettingsService.upsertByUserKeyNamespace).toHaveBeenCalledWith(
        'user-1',
        'ui.data-grid',
        'tenants-table',
        expect.objectContaining({ value: layout }),
      );
    });

    it('rejects a non-JSON value with BadRequestException (and never persists)', async () => {
      await expect(
        controller.updateSetting('ui.data-grid', 'tenants-table', {
          value: 'not-json{',
          dataType: 'JSON' as never,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userSettingsService.upsertByUserKeyNamespace).not.toHaveBeenCalled();
    });

    it('rejects an oversized value with BadRequestException', async () => {
      const huge = JSON.stringify({ blob: 'x'.repeat(20_000) });

      await expect(
        controller.updateSetting('ui.data-grid', 'tenants-table', {
          value: huge,
          dataType: 'JSON' as never,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(userSettingsService.upsertByUserKeyNamespace).not.toHaveBeenCalled();
    });
  });

  describe('getMySettings', () => {
    it('throws UnauthorizedException when no user is in CLS', async () => {
      clsService = createMockClsService(undefined);
      controller = new UserSettingsController(
        userSettingsService as never,
        pipelineService as never,
        clsService as never,
      );

      await expect(controller.getMySettings()).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
