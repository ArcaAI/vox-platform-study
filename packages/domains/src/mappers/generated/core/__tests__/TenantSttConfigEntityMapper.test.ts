/**
 * TenantSttConfigEntityMapper — round-trip + OCC-guard tests.
 *
 * TenantSttConfig is OCC-written, so `_version` MUST be stripped from every
 * write path. Mirrors the AiProviderConnectionEntityMapper suite.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { TenantSttConfigEntityMapper } from '../TenantSttConfigEntityMapper';
import { TenantSttConfig } from '../../../../models/generated/core/TenantSttConfigModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const sampleRow = (overrides: Partial<TenantSttConfig> = {}): TenantSttConfig =>
  new TenantSttConfig({
    id: 'stt-cfg-1',
    tenantId: 't-1',
    fallbackPipelineId: 'pipe-fallback-1',
    autoSwitchEnabled: true,
    configJson: { nested: { list: [1, 2] } },
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 5,
    metaData: null,
    ...overrides,
  } as TenantSttConfig);

describe('TenantSttConfigEntityMapper', () => {
  const mapper = new TenantSttConfigEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.fallbackPipelineId).toBe('pipe-fallback-1');
    expect(entity.autoSwitchEnabled).toBe(true);
    expect(entity.version).toBe(5);
  });

  it('round-trips `configJson` (JsonB) intact through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted.configJson).toEqual({ nested: { list: [1, 2] } });
    expect(persisted.fallbackPipelineId).toBe('pipe-fallback-1');
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 } as any));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    (entity as any)._changes = { autoSwitchEnabled: false, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ autoSwitchEnabled: false });
  });
});
