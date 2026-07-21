/**
 * NotificationService — field-encryption wiring.
 *
 * Verifies the service dual-writes encrypted message fields (messageText /
 * messageRichText / messageContent via `NotificationRepository.encryptFieldsIntoEntity`
 * + the injected SecretsService) before create/update, is best-effort during the
 * soak, and NEVER leaks the ciphertext columns (or keyVersion) into the
 * ResourceCreated / ResourceUpdated SysEvent audit payloads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationType, ResourceStatusType, SysEventType } from '@arcaai/domains';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    NotificationFactory: {
      CreateNotification: vi.fn((data: Record<string, unknown>) => {
        const entity: Record<string, unknown> = {
          ...data,
          id: 'new-notification-id',
          createdAt: new Date('2026-02-01T00:00:00Z'),
          updatedAt: new Date('2026-02-01T00:00:00Z'),
        };
        // toObject() leaks the ciphertext columns (the entity serializer iterates
        // every backing field; @Secret() only redacts when locked===true). The
        // service must strip them from the audit payload.
        entity.toObject = vi.fn().mockReturnValue({
          id: 'new-notification-id',
          ...data,
          encryptedMessageText: Buffer.from('vault:v1:ct'),
          encryptedMessageRichText: null,
          encryptedMessageContent: null,
          keyVersion: 1,
        });
        return entity;
      }),
    },
  };
});

import { NotificationService } from '../notification.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockNotificationRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};
const mockUserRoleAssignmentRepository = { findFirst: vi.fn() };
const mockUserDepartmentRepository = { findFirst: vi.fn() };
const mockUserRepository = { findFirst: vi.fn() };
const mockResourceSubscriptionRepository = { findById: vi.fn() };
const mockSecretsService = {
  encrypt: vi.fn(async () => 'vault:v1:ct'),
  decrypt: vi.fn(),
  getPhiTransitKeyName: () => 'hope-phi',
};

function buildService(withSecrets = true): NotificationService {
  return new NotificationService(
    mockNotificationRepository as never,
    mockUserRoleAssignmentRepository as never,
    mockUserDepartmentRepository as never,
    mockUserRepository as never,
    mockResourceSubscriptionRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    withSecrets ? (mockSecretsService as never) : undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotificationRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockClsService.get.mockImplementation((key: string) => {
    switch (key) {
      case 'user':
        return { id: 'current-user-id' };
      case 'tenantId':
        return 'tenant-1';
      default:
        return null;
    }
  });
  mockUserRoleAssignmentRepository.findFirst.mockResolvedValue({ id: 'ura-1', userId: 'user-1', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED });
  mockUserDepartmentRepository.findFirst.mockResolvedValue({ id: 'ud-1', userId: 'user-1', tenantId: 'tenant-1', resourceStatus: ResourceStatusType.ENABLED });
  mockUserRepository.findFirst.mockResolvedValue({ id: 'user-1', isServiceAccount: false });
});

describe('create — encrypts message fields + strips ciphertext from audit (Phase 3C)', () => {
  it('calls encryptFieldsIntoEntity with the entity + SecretsService BEFORE create', async () => {
    mockNotificationRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(true);
    await service.create({ tenantId: 'tenant-1', targetUserId: 'user-1', title: 'T', messageText: 'PHI body', type: NotificationType.INFO } as never);

    expect(mockNotificationRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockNotificationRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(expect.objectContaining({ messageText: 'PHI body' }), mockSecretsService);
    const encOrder = mockNotificationRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockNotificationRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('excludes encrypted*/keyVersion from the ResourceCreated payload data', async () => {
    mockNotificationRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(true);
    await service.create({ tenantId: 'tenant-1', targetUserId: 'user-1', title: 'T', messageText: 'PHI body', type: NotificationType.INFO } as never);

    const created = mockEventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceCreated);
    expect(created).toBeDefined();
    const data = (created![1] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('encryptedMessageText');
    expect(data).not.toHaveProperty('encryptedMessageRichText');
    expect(data).not.toHaveProperty('encryptedMessageContent');
    expect(data).not.toHaveProperty('keyVersion');
  });

  it('is best-effort: a SecretsService failure does NOT break the write', async () => {
    mockNotificationRepository.create.mockImplementation((e) => Promise.resolve(e));
    mockNotificationRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const service = buildService(true);
    const res = await service.create({ tenantId: 'tenant-1', targetUserId: 'user-1', title: 'T', messageText: 'PHI body', type: NotificationType.INFO } as never);

    expect(res.id).toBe('new-notification-id');
    expect(mockNotificationRepository.create).toHaveBeenCalledTimes(1);
  });

  it('skips encryption when no SecretsService is wired', async () => {
    mockNotificationRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(false);
    await service.create({ tenantId: 'tenant-1', targetUserId: 'user-1', title: 'T', messageText: 'PHI body', type: NotificationType.INFO } as never);

    expect(mockNotificationRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockNotificationRepository.create).toHaveBeenCalledTimes(1);
  });
});

describe('update — re-encrypts on message change + strips ciphertext from audit (Phase 3C)', () => {
  function existing() {
    return {
      id: 'notification-id-1',
      tenantId: 'tenant-1',
      targetUserId: 'user-1',
      messageText: 'old',
      hasChanges: true,
      // changes carries the ciphertext columns (populated by encrypt) — must be stripped.
      changes: { messageText: 'new', encryptedMessageText: Buffer.from('vault:v1:ct'), keyVersion: 1 },
      toObject: vi.fn().mockReturnValue({
        id: 'notification-id-1',
        messageText: 'old',
        encryptedMessageText: Buffer.from('vault:v1:old'),
        keyVersion: 1,
      }),
    };
  }

  it('encrypts when messageText changes and strips ciphertext from data + previousData', async () => {
    const item = existing();
    mockNotificationRepository.findById.mockResolvedValue(item);
    mockNotificationRepository.update.mockResolvedValue(item);

    const service = buildService(true);
    await service.update('notification-id-1', { messageText: 'new' } as never);

    expect(mockNotificationRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    const encOrder = mockNotificationRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const updateOrder = mockNotificationRepository.update.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(updateOrder);

    const updated = mockEventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    expect(updated).toBeDefined();
    const payload = updated![1] as { data: Record<string, unknown>; previousData: Record<string, unknown> };
    expect(payload.data).not.toHaveProperty('encryptedMessageText');
    expect(payload.data).not.toHaveProperty('keyVersion');
    expect(payload.previousData).not.toHaveProperty('encryptedMessageText');
    expect(payload.previousData).not.toHaveProperty('keyVersion');
  });

  it('does NOT encrypt when no message field changed (e.g. read toggle)', async () => {
    const item = existing();
    // A read-only update: the entity change-set carries no message field.
    item.changes = { read: true } as never;
    mockNotificationRepository.findById.mockResolvedValue(item);
    mockNotificationRepository.update.mockResolvedValue(item);

    const service = buildService(true);
    await service.update('notification-id-1', { read: true } as never);

    expect(mockNotificationRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
  });
});
