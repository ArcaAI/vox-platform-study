/**
 * RotateSecret unit tests.
 *
 * Rotation = an atomic, step-up-gated, distinctly-audited replace-with-new-value
 * under OCC: the plaintext `value` column is replaced, and — when the provider
 * has Vault Transit — `encryptedValue` is envelope re-wrapped, in ONE versioned
 * write. Mirrors revealSecret's gating (super-admin + password step-up) and
 * update's OCC write (`updateWithVersion`); audited via ResourceUpdated +
 * `data.action: GLOBAL_SETTING_SECRET_ROTATED` + `forceAuditLog: true`, with
 * the secret plaintext (old AND new) excluded from the event.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GlobalSettingService, GLOBAL_SETTING_SECRET_ROTATED } from '../globalSetting.service';
import { SysEventType, ValueType } from '@arcaai/domains';
import { DataNotFoundException } from '@arcaai/exceptions';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

const mockEventEmitter = {
  emit: vi.fn(),
};

const mockGlobalSettingRepository = {
  findById: vi.fn(),
  findAll: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  softDelete: vi.fn(),
  findByIdWithDecryptedValue: vi.fn(),
  encryptValueIntoEntity: vi.fn(),
  findFirst: vi.fn(),
  restore: vi.fn(),
};

const mockUserRepository = {
  findById: vi.fn(),
};
const mockCryptoService = {
  hash: vi.fn(),
  verify: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
};
const mockSecretsService = {
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  // Default: no Transit (env/test posture) — existing rotate tests exercise
  // the plaintext-replace path unchanged. The re-wrap tests flip this to true.
  supportsTransit: vi.fn(() => false),
};

const OLD_SECRET = 'old-secret-value';
const NEW_SECRET = 'brand-new-secret-value';

/**
 * Minimal secret-row mock with REAL change tracking on `value`: `hasChanges` /
 * `changes` derive from whether `value` moved off its initial state, so the
 * tests fail if the service skips `updateEntity` (behavior, not mock-behavior).
 */
const createMockSecretEntity = (overrides: Record<string, unknown> = {}) => {
  const entity: Record<string, any> = {
    id: 'secret-1',
    tenantId: 'tenant-1',
    name: 'API token',
    description: null,
    key: 'secrets.api-token',
    value: OLD_SECRET,
    dataType: ValueType.String,
    namespace: 'secrets',
    encryptedValue: null,
    locked: false,
    version: 4,
    createdBy: 'user-1',
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    resourceStatus: 'ENABLED',
    ...overrides,
  };
  const initialValue = entity.value;
  Object.defineProperty(entity, 'hasChanges', { get: () => entity.value !== initialValue });
  Object.defineProperty(entity, 'changes', { get: () => (entity.value !== initialValue ? { value: entity.value } : {}) });
  entity.toObject = vi.fn().mockReturnValue({ ...entity });
  return entity;
};

describe('GlobalSettingService.rotateSecret', () => {
  let service: GlobalSettingService;

  const asSuperAdmin = (tenantId: string | null = null) =>
    mockClsService.get.mockImplementation((key: string) =>
      key === 'user'
        ? { id: 'super-1', roles: ['GLOBAL_ADMIN'] }
        : key === 'tenantId'
          ? tenantId
          : key === 'correlationId'
            ? 'corr-1'
            : key === 'requestIp'
              ? '10.0.0.1'
              : null,
    );

  /** Wire the happy path: super-admin, password ok, row found, CAS succeeds. */
  const wireHappyPath = (entityOverrides: Record<string, unknown> = {}) => {
    const entity = createMockSecretEntity(entityOverrides);
    // updateEntity(entity, { value }) mutates via setProperty → simulate change tracking.
    mockGlobalSettingRepository.findById.mockResolvedValue(entity);
    mockUserRepository.findById.mockResolvedValue({ id: 'super-1', password: 'bcrypt-hash' });
    mockCryptoService.verify.mockResolvedValue(true);
    const persisted = createMockSecretEntity({ ...entityOverrides, value: NEW_SECRET, version: (entity.version as number) + 1 });
    mockGlobalSettingRepository.updateWithVersion.mockResolvedValue(persisted);
    return { entity, persisted };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps implementations, so re-pin the Transit default to
    // false each test (a re-wrap test that flips it to true must not leak).
    mockSecretsService.supportsTransit.mockReturnValue(false);
    // Default CLS user: NOT a super-admin.
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-1' } : key === 'tenantId' ? 'tenant-1' : null));
    service = new GlobalSettingService(
      mockGlobalSettingRepository as any,
      mockUserRepository as any,
      mockCryptoService as any,
      mockSecretsService as any,
      mockEventEmitter as any,
      mockClsService as any,
    );
  });

  it('rejects a non-super-admin with ForbiddenException before touching anything (fail-closed)', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mockCryptoService.verify).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.findById).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('requires a step-up password (empty ⇒ UnauthorizedException, no read, no write)', async () => {
    asSuperAdmin();
    const { UnauthorizedException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: '', newValue: NEW_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(mockCryptoService.verify).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rejects a wrong password with UnauthorizedException (no write, no audit)', async () => {
    asSuperAdmin();
    wireHappyPath();
    mockCryptoService.verify.mockResolvedValue(false);

    const { UnauthorizedException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: 'wrong', newValue: NEW_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(mockCryptoService.verify).toHaveBeenCalledWith('wrong', 'bcrypt-hash');
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  // NestJS BadRequestException (not @arcaai/exceptions ArgumentInvalidException):
  // these are HTTP-ish client-input checks, and the ExceptionInterceptor maps any
  // BaseException subclass to a generic 500 — a client mistake must render 400.
  it('rejects an empty newValue with BadRequestException → 400 (nothing to rotate to)', async () => {
    asSuperAdmin();
    wireHappyPath();

    const { BadRequestException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: 'pw', newValue: '', expectedVersion: 4 })).rejects.toBeInstanceOf(BadRequestException);
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('rejects a NON-secret target with BadRequestException → 400 (rotate is secrets-only)', async () => {
    asSuperAdmin();
    // Plain feature flag: not `secrets` namespace, key does not match the secret pattern, no encryptedValue.
    wireHappyPath({ key: 'feature.enable', namespace: 'features', encryptedValue: null });

    const { BadRequestException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rejects a replacement equal to the current value with BadRequestException → 400 (no silent version bump)', async () => {
    asSuperAdmin();
    wireHappyPath();

    const { BadRequestException } = await import('@nestjs/common');
    await expect(service.rotateSecret('secret-1', { password: 'pw', newValue: OLD_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('propagates DataNotFoundException from the read (404-over-403 posture)', async () => {
    asSuperAdmin();
    mockUserRepository.findById.mockResolvedValue({ id: 'super-1', password: 'bcrypt-hash' });
    mockCryptoService.verify.mockResolvedValue(true);
    mockGlobalSettingRepository.findById.mockRejectedValue(new DataNotFoundException('globalSetting', 'missing-1'));

    await expect(service.rotateSecret('missing-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 1 })).rejects.toBeInstanceOf(
      DataNotFoundException,
    );
    expect(mockGlobalSettingRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('replaces the value atomically via updateWithVersion (OCC compare-and-set, single versioned write)', async () => {
    asSuperAdmin();
    const { entity, persisted } = wireHappyPath();

    const result = await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    // One CAS write against the client's expectedVersion — no plain update path.
    expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalledWith('secret-1', entity, 4);
    expect(mockGlobalSettingRepository.update).not.toHaveBeenCalled();
    expect(result).toBe(persisted);
    // The old value is gone from the entity the write persisted.
    expect(result.value).toBe(NEW_SECRET);
  });

  // Envelope re-wrap: when the provider has Vault Transit,
  // rotation envelope-encrypts the NEW value into `encryptedValue` under the
  // current key version BEFORE the versioned write, so the ciphertext (which
  // the reveal path prefers) is refreshed atomically with the value.
  it('envelope re-wraps the new value via the repository when Transit is available (before the CAS write)', async () => {
    asSuperAdmin();
    mockSecretsService.supportsTransit.mockReturnValue(true);
    const { entity } = wireHappyPath();

    await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    // The new plaintext is encrypted into the SAME entity the CAS write persists…
    expect(mockGlobalSettingRepository.encryptValueIntoEntity).toHaveBeenCalledWith(entity, mockSecretsService);
    // …and the encrypt happens before the versioned write (re-wrap is part of the atomic rotation).
    const encryptOrder = mockGlobalSettingRepository.encryptValueIntoEntity.mock.invocationCallOrder[0];
    const writeOrder = mockGlobalSettingRepository.updateWithVersion.mock.invocationCallOrder[0];
    expect(encryptOrder).toBeLessThan(writeOrder);
  });

  it('skips the envelope re-wrap when the provider has no Transit (env/test) — plaintext replace still succeeds', async () => {
    asSuperAdmin();
    // supportsTransit stays false (beforeEach default).
    const { persisted } = wireHappyPath();

    const result = await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    expect(mockGlobalSettingRepository.encryptValueIntoEntity).not.toHaveBeenCalled();
    expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
    expect(result).toBe(persisted);
  });

  it('propagates OptimisticConcurrencyException on version drift (HTTP 412)', async () => {
    asSuperAdmin();
    wireHappyPath();
    const { OptimisticConcurrencyException } = await import('@arcaai/exceptions');
    mockGlobalSettingRepository.updateWithVersion.mockRejectedValue(
      new OptimisticConcurrencyException('GlobalSetting', 'secret-1', { expectedVersion: 4, currentVersion: 5 }),
    );

    await expect(service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 })).rejects.toBeInstanceOf(
      OptimisticConcurrencyException,
    );
    // Failed CAS ⇒ no rotation audit event.
    expect(mockEventEmitter.emit).not.toHaveBeenCalled();
  });

  it('allows a GLOBAL_ADMIN to rotate a locked platform row (rotate is already manage:all-gated)', async () => {
    asSuperAdmin();
    wireHappyPath({ locked: true });

    await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    expect(mockGlobalSettingRepository.updateWithVersion).toHaveBeenCalled();
  });

  it('emits a force-audited ResourceUpdated tagged GLOBAL_SETTING_SECRET_ROTATED — with NEITHER the old nor the new plaintext', async () => {
    asSuperAdmin();
    wireHappyPath();

    await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({
        resourceId: 'secret-1',
        responsibleEntityId: 'super-1',
        forceAuditLog: true,
        data: expect.objectContaining({
          action: GLOBAL_SETTING_SECRET_ROTATED,
          key: 'secrets.api-token',
          previousVersion: 4,
          newVersion: 5,
        }),
      }),
    );
    // Belt-and-suspenders: no plaintext (old or new) and no password anywhere in the event.
    const emitted = mockEventEmitter.emit.mock.calls.find((c) => c[0] === SysEventType.ResourceUpdated);
    const serialized = JSON.stringify(emitted?.[1] ?? {});
    expect(serialized).not.toContain(OLD_SECRET);
    expect(serialized).not.toContain(NEW_SECRET);
    expect(serialized).not.toContain('pw');
  });

  it('attributes the audit to the RESOURCE tenant when the super-admin has no CLS tenant', async () => {
    asSuperAdmin(null);
    wireHappyPath({ tenantId: 'owning-tenant-9' });

    await service.rotateSecret('secret-1', { password: 'pw', newValue: NEW_SECRET, expectedVersion: 4 });

    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({
        resourceId: 'secret-1',
        forceAuditLog: true,
        tenantId: 'owning-tenant-9',
      }),
    );
  });
});
