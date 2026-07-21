// GlobalSettingRepository encryption
// helpers, exercised via the prototype-augmentation sibling file. We don't
// touch a real Prisma client here; the repository's findById is monkeypatched
// per test where needed.
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { GlobalSettingRepository } from '../generated/core/GlobalSettingRepository';
import type { SecretsServiceLike } from '../generated/core/GlobalSettingRepository.encryption';
import { GlobalSettingEntity } from '../../entities/generated/core/GlobalSettingEntity';
import { ValueType } from '../../enums';

// Side-effect import that registers the prototype methods.
import '../generated/core/GlobalSettingRepository.encryption';

function makeEntity(
  overrides: Partial<ConstructorParameters<typeof GlobalSettingEntity>[0]> = {},
): GlobalSettingEntity {
  return new GlobalSettingEntity({
    id: 'b0000000-0000-0000-0000-000000000001',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    tenantId: 'tenant-1',
    Tenant: null,
    tags: [],
    Tags: [],
    name: 'JWT_SECRET_KEY',
    description: '',
    key: 'JWT_SECRET_KEY',
    defaultValue: '',
    value: 'legacy-plaintext-jwt',
    encryptedValue: null,
    keyVersion: null,
    locked: true,
    dataType: ValueType.String,
    namespace: '',
    ...overrides,
  } as any);
}

function makeRepo(): GlobalSettingRepository {
  // Skip the real constructor (which needs a UoW). Casting through unknown
  // because we only exercise the prototype-merged methods.
  return Object.create(GlobalSettingRepository.prototype) as GlobalSettingRepository;
}

describe('GlobalSettingRepository.encryptValueIntoEntity (Phase 4 Task 4.6)', () => {
  it('encrypts value via SecretsService, populating encryptedValue + keyVersion', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async (b: Buffer) => `vault:v3:${b.toString('base64')}`),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ value: 'plain-jwt' });

    await repo.encryptValueIntoEntity(entity, secrets);

    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
    expect(entity.encryptedValue).toBeInstanceOf(Buffer);
    expect(entity.encryptedValue?.toString('utf8')).toBe('vault:v3:cGxhaW4tand0');
    expect(entity.keyVersion).toBe(3);
  });

  it('parses keyVersion=1 fallback when ciphertext is malformed', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async () => 'not-a-valid-vault-ciphertext'),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ value: 'plain' });

    await repo.encryptValueIntoEntity(entity, secrets);
    expect(entity.keyVersion).toBe(1);
  });

  it('no-ops when entity.value is empty (nothing to encrypt)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ value: '' });

    await repo.encryptValueIntoEntity(entity, secrets);
    expect(secrets.encrypt).not.toHaveBeenCalled();
    expect(entity.encryptedValue).toBeNull();
    expect(entity.keyVersion).toBeNull();
  });

  it('does NOT clear the plaintext value (one-release readback window)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ value: 'keep-me' });

    await repo.encryptValueIntoEntity(entity, secrets);
    expect(entity.value).toBe('keep-me');
  });
});

describe('GlobalSettingRepository.decryptValueFromEntity (Phase 4 Task 4.6)', () => {
  it('decrypts encryptedValue via SecretsService', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async (ct: string) => {
        const b64 = ct.split(':').pop()!;
        return Buffer.from(b64, 'base64');
      }),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      encryptedValue: Buffer.from('vault:v2:cGxhaW4tand0', 'utf8'),
      value: '',
    });

    const pt = await repo.decryptValueFromEntity(entity, secrets);
    expect(pt).toBe('plain-jwt');
    expect(secrets.decrypt).toHaveBeenCalledWith('vault:v2:cGxhaW4tand0');
  });

  it('falls back to entity.value when encryptedValue is null (legacy bridge)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    const entity = makeEntity({ value: 'legacy-jwt', encryptedValue: null });

    const pt = await repo.decryptValueFromEntity(entity, secrets);
    expect(pt).toBe('legacy-jwt');
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });

  it('prefers encryptedValue when both are present', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('from-vault', 'utf8')),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      value: 'from-plaintext',
      encryptedValue: Buffer.from('vault:v1:Zg==', 'utf8'),
    });

    const pt = await repo.decryptValueFromEntity(entity, secrets);
    expect(pt).toBe('from-vault');
    expect(secrets.decrypt).toHaveBeenCalledTimes(1);
  });
});

describe('GlobalSettingRepository.findByIdWithDecryptedValue (Phase 4 Task 4.9)', () => {
  it('wraps findById + decryptValueFromEntity into a single call', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async () => Buffer.from('decrypted-payload', 'utf8')),
    };
    const repo = makeRepo();
    const entity = makeEntity({
      encryptedValue: Buffer.from('vault:v1:ZA==', 'utf8'),
      value: '',
    });
    // Monkeypatch findById on this single instance — the generic
    // Repository.findById path hits Prisma which we are not booting.
    (repo as { findById: typeof repo.findById }).findById = vi.fn(async () => entity);

    const out = await repo.findByIdWithDecryptedValue('any-id', secrets);
    expect(out.entity).toBe(entity);
    expect(out.plaintext).toBe('decrypted-payload');
    expect(repo.findById).toHaveBeenCalledWith('any-id');
  });

  it('propagates the not-found error from findById (no try/catch swallow)', async () => {
    const secrets: SecretsServiceLike = {
      encrypt: vi.fn(),
      decrypt: vi.fn(),
    };
    const repo = makeRepo();
    (repo as { findById: typeof repo.findById }).findById = vi.fn(async () => {
      throw new Error('DataNotFound: GlobalSetting/nope');
    });

    await expect(repo.findByIdWithDecryptedValue('nope', secrets)).rejects.toThrow(/DataNotFound/);
  });
});
