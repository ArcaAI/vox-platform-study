/**
 * POST /admin/settings/:id/rotate controller unit tests.
 *
 * The rotate route mirrors reveal's gating (method-level `@Authorize(['manage','all'])`
 * overriding the class `@CanManage('GlobalSetting')`) and update's OCC contract
 * (`@RequiresIfMatch()` + `@ExpectedVersion()` header override). The response is
 * the MASKED GlobalSettingResponse — the new plaintext is never returned.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { GlobalSettingController } from '../global-setting.controller';

const fakeSecretEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'gs-7',
  name: 'API token',
  description: null,
  key: 'secrets.api-token',
  value: 'rotated-plaintext-never-shown',
  dataType: 'String',
  namespace: 'secrets',
  tenantId: null,
  version: 5,
  locked: false,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-07-08T00:00:00Z'),
  createdBy: 'system',
  updatedBy: 'super-1',
  resourceStatus: 'ENABLED',
  ...overrides,
});

const createMockService = () => ({
  create: vi.fn(),
  fetchAll: vi.fn(),
  fetchAllByTenantId: vi.fn(),
  fetchById: vi.fn(),
  update: vi.fn(),
  deleteById: vi.fn(),
  revealSecret: vi.fn(),
  rotateSecret: vi.fn(),
});

describe('GlobalSettingController — POST /admin/settings/:id/rotate', () => {
  let controller: GlobalSettingController;
  let mockService: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockService();
    controller = new GlobalSettingController(mockService as any, { get: vi.fn() } as any);
  });

  it('delegates to service.rotateSecret with the If-Match header version folded over the body expectedVersion', async () => {
    mockService.rotateSecret.mockResolvedValue(fakeSecretEntity());

    await controller.rotate('gs-7', { password: 'pw', newValue: 'new-secret' } as any, 4);

    expect(mockService.rotateSecret).toHaveBeenCalledWith('gs-7', { password: 'pw', newValue: 'new-secret', expectedVersion: 4 });
  });

  it('passes the body expectedVersion through unchanged when no header version is present', async () => {
    mockService.rotateSecret.mockResolvedValue(fakeSecretEntity());

    await controller.rotate('gs-7', { password: 'pw', newValue: 'new-secret', expectedVersion: 2 } as any, undefined);

    expect(mockService.rotateSecret).toHaveBeenCalledWith('gs-7', { password: 'pw', newValue: 'new-secret', expectedVersion: 2 });
  });

  it('returns the MASKED setting response — never the rotated plaintext', async () => {
    mockService.rotateSecret.mockResolvedValue(fakeSecretEntity({ value: 'rotated-plaintext-never-shown' }));

    const result = await controller.rotate('gs-7', { password: 'pw', newValue: 'rotated-plaintext-never-shown' } as any, 4);

    // The real GlobalSettingDtoMapper masks secret values (isSecret convention).
    expect(result.isSecret).toBe(true);
    expect(result.value).toBe('');
    expect(result.version).toBe(5);
    expect(JSON.stringify(result)).not.toContain('rotated-plaintext-never-shown');
  });

  it('is gated GLOBAL_ADMIN-only via @Authorize(["manage","all"]) (overrides the class gate)', () => {
    const methodMeta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, GlobalSettingController.prototype.rotate) as
      Array<{ action: string; subject: string }> | undefined;
    expect(methodMeta).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('requires If-Match (OCC) — the route carries the @RequiresIfMatch() metadata', () => {
    // Same metadata key the RequiresIfMatchGuard reads (mirrors the update route's contract).
    const requiresIfMatch = Reflect.getMetadata('requiresIfMatch', GlobalSettingController.prototype.rotate);
    expect(requiresIfMatch).toBe(true);
  });
});
