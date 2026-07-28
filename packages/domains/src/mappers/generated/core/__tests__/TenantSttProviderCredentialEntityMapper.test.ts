/**
 * TenantSttProviderCredentialEntityMapper — round-trip + OCC-guard tests (TASK-567).
 *
 * TenantSttProviderCredential is OCC-written, so `_version` MUST be stripped
 * from every write path. Mirrors the AiProviderConnectionEntityMapper suite.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { TenantSttProviderCredentialEntityMapper } from '../TenantSttProviderCredentialEntityMapper';
import { TenantSttProviderCredential } from '../../../../models/generated/core/TenantSttProviderCredentialModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const sampleRow = (
  overrides: Partial<TenantSttProviderCredential> = {},
): TenantSttProviderCredential =>
  new TenantSttProviderCredential({
    id: 'stt-cred-1',
    tenantId: 't-1',
    provider: 'azure-speech',
    endpoint: 'https://foundry.example',
    region: 'eastus',
    encryptedApiKey: new Uint8Array([1, 2, 3]),
    keyVersion: 2,
    enabled: true,
    extraJson: { foundryModel: 'mai-transcribe-1.5' },
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 3,
    metaData: null,
    ...overrides,
  } as TenantSttProviderCredential);

describe('TenantSttProviderCredentialEntityMapper', () => {
  const mapper = new TenantSttProviderCredentialEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.provider).toBe('azure-speech');
    expect(entity.region).toBe('eastus');
    expect(entity.keyVersion).toBe(2);
    expect(entity.enabled).toBe(true);
    expect(entity.version).toBe(3);
  });

  it('round-trips `encryptedApiKey` (Bytes) + `extraJson` intact through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted.encryptedApiKey).toEqual(new Uint8Array([1, 2, 3]));
    expect(persisted.extraJson).toEqual({ foundryModel: 'mai-transcribe-1.5' });
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 } as any));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    (entity as any)._changes = { enabled: false, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ enabled: false });
  });
});
