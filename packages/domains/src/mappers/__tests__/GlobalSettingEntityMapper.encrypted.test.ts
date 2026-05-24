// TASK-302 Phase 4 Task 4.3 — mapper round-trips encryptedValue + keyVersion
// between persistence model and domain entity via AutoClassMapper.
import { describe, it, expect } from 'vitest';
import { GlobalSettingEntityMapper } from '../generated/core/GlobalSettingEntityMapper';
import { GlobalSettingEntity } from '../../entities/generated/core/GlobalSettingEntity';
import { GlobalSetting } from '../../models/generated/core/GlobalSettingModel';
import { ValueType, ResourceStatusType } from '../../enums';

describe('GlobalSettingEntityMapper — Vault envelope-encryption fields', () => {
  const mapper = new GlobalSettingEntityMapper();

  function makeModel(overrides: Partial<GlobalSetting> = {}): GlobalSetting {
    return new GlobalSetting({
      id: 'b0000000-0000-0000-0000-000000000001',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      updatedBy: null,
      tenantId: 'tenant-1',
      name: 'JWT_SECRET_KEY',
      description: '',
      key: 'JWT_SECRET_KEY',
      defaultValue: '',
      value: 'legacy-plaintext',
      encryptedValue: null,
      keyVersion: null,
      locked: false,
      dataType: ValueType.String,
      namespace: '',
      resourceStatus: ResourceStatusType.ENABLED,
      resourceStatusUpdatedAt: null,
      resourceStatusUpdatedBy: null,
      tags: [],
      ...overrides,
    } as any);
  }

  // Compare ciphertexts as raw byte arrays so the test tolerates
  // Buffer ↔ Uint8Array constructor differences (the entity types it as
  // Buffer, the model as Uint8Array; AutoClassMapper passes the object
  // through by reference — the bytes are identical).
  function bytes(b: Uint8Array | Buffer | null | undefined): number[] {
    if (!b) return [];
    return Array.from(b);
  }

  it('toDomainEntity carries ciphertext + key version from model into entity', () => {
    const ciphertext = Buffer.from('vault:v1:abcdef==', 'utf8');
    const model = makeModel({ encryptedValue: ciphertext, keyVersion: 2 });
    const entity = mapper.toDomainEntity(model);
    expect(bytes(entity.encryptedValue)).toEqual(bytes(ciphertext));
    expect(entity.keyVersion).toBe(2);
  });

  it('toPersistence carries ciphertext + key version from entity into model', () => {
    const ciphertext = Buffer.from('vault:v2:xyz==', 'utf8');
    const sourceModel = makeModel({ encryptedValue: ciphertext, keyVersion: 5 });
    const entity = mapper.toDomainEntity(sourceModel);
    const out = mapper.toPersistence(entity);
    expect(bytes(out.encryptedValue)).toEqual(bytes(ciphertext));
    expect(out.keyVersion).toBe(5);
  });

  it('round-trips null when row is not yet migrated to Vault Transit', () => {
    const model = makeModel({ encryptedValue: null, keyVersion: null });
    const entity = mapper.toDomainEntity(model);
    expect(entity.encryptedValue).toBeNull();
    expect(entity.keyVersion).toBeNull();
    const back = mapper.toPersistence(entity);
    expect(back.encryptedValue).toBeNull();
    expect(back.keyVersion).toBeNull();
  });
});
