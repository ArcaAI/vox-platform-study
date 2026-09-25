/**
 * UserSettingsController — per-namespace value guards.
 *
 * TASK-1006: `arcaai-sdk:selectedPipelineId` is no longer validated against an `AsrPipeline`
 * catalogue (there is none) — it is an ordinary client-owned key. The `ui.data-grid` guard stays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserSettingsController } from '../user-settings.controller';

const createMockUserSettingsService = () => ({
  fetchAllByUserId: vi.fn(),
  upsertByUserKeyNamespace: vi.fn(),
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

describe('UserSettingsController — per-namespace value guards', () => {
  let controller: UserSettingsController;
  let userSettingsService: ReturnType<typeof createMockUserSettingsService>;
  let clsService: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    userSettingsService = createMockUserSettingsService();
    clsService = createMockClsService({ id: 'user-1', tenantId: 'tenant-A' });

    userSettingsService.upsertByUserKeyNamespace.mockResolvedValue(fakeSettingEntity);

    controller = new UserSettingsController(userSettingsService as never, clsService as never);
  });

  describe('updateSetting — arcaai-sdk:selectedPipelineId (TASK-1006: no longer validated)', () => {
    it('persists the value as an ordinary client-owned setting — there is no pipeline catalogue to check it against', async () => {
      await controller.updateSetting('arcaai-sdk', 'selectedPipelineId', {
        value: 'pipe-anything',
        dataType: 'STRING' as never,
      } as never);

      expect(userSettingsService.upsertByUserKeyNamespace).toHaveBeenCalledWith(
        'user-1',
        'arcaai-sdk',
        'selectedPipelineId',
        expect.objectContaining({ value: 'pipe-anything' }),
      );
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
      controller = new UserSettingsController(userSettingsService as never, clsService as never);

      await expect(controller.getMySettings()).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
