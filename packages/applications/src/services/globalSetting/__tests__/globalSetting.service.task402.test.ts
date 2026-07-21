/**
 * (Defect 2, half B) — re-creating a soft-deleted GlobalSetting must
 * REVIVE the deleted row instead of 409ing on the DB unique index.
 *
 * The `@@unique([tenantId, name, key])` index counts DELETED rows, so a plain
 * `create` after a soft-delete throws P2002 and the admin can never bring the
 * key back (or, with a different name, silently accumulates a DELETED+ENABLED
 * pair for one key). Contract pinned here (userRoleAssignment.service
 * restore-on-create precedent, UPDATE-only):
 *
 *   - create() with a matching DELETED (tenantId, name, key) row → restore()
 *     that row (ENABLED + version bump), apply the request's value/dataType/
 *     namespace/description onto it, emit ResourceCreated (marked as a
 *     revive), return the SAME row id. `repository.create` is never called.
 *   - identical field values after restore → no redundant update write.
 *   - no DELETED match (DataNotFoundException) → plain create, unchanged.
 *   - no resolvable tenant context → no revive probe at all (plain create).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalSettingService } from '../globalSetting.service';
import { SysEventType, ValueType } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';

const TENANT = 'tenant-1';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockGlobalSettingRepository = {
  findFirst: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
};
const mockUserRepository = { findById: vi.fn() };
const mockCryptoService = { hash: vi.fn(), verify: vi.fn() };
const mockSecretsService = { encrypt: vi.fn(), decrypt: vi.fn() };

// Bare-object "entity": applyChangesToEntity assigns fields directly and the
// service reads hasChanges/changes for the follow-up write decision.
const buildDeletedRow = (overrides: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 'deleted-row-1',
    tenantId: TENANT,
    name: 'Task402 Revive',
    key: 'task402.revive.key',
    value: 'old-value',
    dataType: ValueType.String,
    namespace: 'com.flw.test',
    description: 'old',
    resourceStatus: 'DELETED',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    hasChanges: true,
    changes: {},
    ...overrides,
  };
  row.toObject = vi.fn().mockReturnValue({ id: row.id, key: row.key, value: row.value });
  return row;
};

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    GlobalSettingFactory: {
      CreateGlobalSetting: vi.fn((data) => ({
        ...data,
        id: 'brand-new-id',
        createdAt: new Date(),
        toObject: vi.fn().mockReturnValue({ id: 'brand-new-id', key: data.key }),
      })),
    },
  };
});

describe('GlobalSettingService — TASK-402 revive-on-create for soft-deleted keys', () => {
  let service: GlobalSettingService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'user':
          return { id: 'admin-1' };
        case 'tenantId':
          return TENANT;
        default:
          return null;
      }
    });
    service = new GlobalSettingService(
      mockGlobalSettingRepository as any,
      mockUserRepository as any,
      mockCryptoService as any,
      mockSecretsService as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  it('revives a matching DELETED row: restore + apply request fields, same row id, no create', async () => {
    const restored = buildDeletedRow({ resourceStatus: 'ENABLED' });
    mockGlobalSettingRepository.findFirst.mockResolvedValue(buildDeletedRow());
    mockGlobalSettingRepository.restore.mockResolvedValue(restored);
    mockGlobalSettingRepository.update.mockImplementation(async (_id: string, entity: any) => entity);

    const result = await service.create({
      tenantId: TENANT,
      name: 'Task402 Revive',
      key: 'task402.revive.key',
      value: 'new-value',
      dataType: ValueType.String,
    });

    // The DELETED probe targeted exactly (tenantId, name, key) + DELETED.
    expect(mockGlobalSettingRepository.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          name: 'Task402 Revive',
          key: 'task402.revive.key',
          resourceStatus: 'DELETED',
        }),
      }),
    );
    expect(mockGlobalSettingRepository.restore).toHaveBeenCalledWith('deleted-row-1', 'admin-1');
    // Request fields were applied to the restored entity and written.
    expect(restored.value).toBe('new-value');
    expect(mockGlobalSettingRepository.update).toHaveBeenCalledWith('deleted-row-1', restored);
    expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
    expect(result.id).toBe('deleted-row-1');

    // Audited as a creation (marked as revive).
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({
        resourceId: 'deleted-row-1',
        data: expect.objectContaining({ revivedFromDeleted: true }),
      }),
    );
  });

  it('skips the redundant update write when the restored row already matches the request', async () => {
    const restored = buildDeletedRow({ resourceStatus: 'ENABLED', value: 'same-value', hasChanges: false });
    mockGlobalSettingRepository.findFirst.mockResolvedValue(buildDeletedRow());
    mockGlobalSettingRepository.restore.mockResolvedValue(restored);

    const result = await service.create({
      tenantId: TENANT,
      name: 'Task402 Revive',
      key: 'task402.revive.key',
      value: 'same-value',
      dataType: ValueType.String,
    });

    expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
    expect(result.id).toBe('deleted-row-1');
  });

  it('falls back to a plain create when no DELETED row matches', async () => {
    mockGlobalSettingRepository.findFirst.mockRejectedValue(new DataNotFoundException('globalSetting', '{}'));
    mockGlobalSettingRepository.create.mockImplementation(async (entity: any) => entity);

    const result = await service.create({
      tenantId: TENANT,
      name: 'Fresh Setting',
      key: 'task402.fresh.key',
      value: 'v',
      dataType: ValueType.String,
    });

    expect(mockGlobalSettingRepository.restore).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('brand-new-id');
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ resourceId: 'brand-new-id' }),
    );
  });

  it('does not probe for DELETED rows when no tenant context is resolvable', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1' } : null));
    mockGlobalSettingRepository.create.mockImplementation(async (entity: any) => entity);

    await service.create({
      name: 'No Tenant',
      key: 'task402.notenant.key',
      value: 'v',
      dataType: ValueType.String,
    });

    expect(mockGlobalSettingRepository.findFirst).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.create).toHaveBeenCalledTimes(1);
  });

  it('propagates unexpected probe errors instead of masking them as creates', async () => {
    mockGlobalSettingRepository.findFirst.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.create({ tenantId: TENANT, name: 'X', key: 'task402.err.key', value: 'v', dataType: ValueType.String }),
    ).rejects.toThrow('connection reset');
    expect(mockGlobalSettingRepository.create).not.toHaveBeenCalled();
  });
});
