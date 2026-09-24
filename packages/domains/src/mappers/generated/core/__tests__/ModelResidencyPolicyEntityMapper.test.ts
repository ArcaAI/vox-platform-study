/**
 * ModelResidencyPolicyEntityMapper — round-trip tests
 *
 * Mirrors the `AiRoutingPolicyEntityMapper` suite's OCC assertion: `_version`
 * is stripped from both write paths (this model is OCC-written — versioned
 * PATCH routes on the admin residency-policy surface), while every other
 * field survives the round trip intact.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { ModelResidencyPolicyEntityMapper } from '../ModelResidencyPolicyEntityMapper';
import { ModelResidencyPolicy } from '../../../../models/generated/core/ModelResidencyPolicyModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { ModelResidencyClass } from '../../../../enums/generated/ModelResidencyClass';

const sampleRow = (overrides: Partial<ModelResidencyPolicy> = {}): ModelResidencyPolicy =>
  new ModelResidencyPolicy({
    id: 'mrp-1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    aiModelId: 'model-1',
    service: 'stt',
    class: ModelResidencyClass.PINNED,
    idleTtlSeconds: 900,
    priority: 5,
    maxInstances: 2,
    preferredDevice: 'cuda:0',
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
  } as ModelResidencyPolicy);

describe('ModelResidencyPolicyEntityMapper', () => {
  const mapper = new ModelResidencyPolicyEntityMapper();

  it('toDomainEntity carries every field + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('00000000-0000-0000-0000-000000000000');
    expect(entity.aiModelId).toBe('model-1');
    expect(entity.service).toBe('stt');
    expect(entity.class).toBe(ModelResidencyClass.PINNED);
    expect(entity.idleTtlSeconds).toBe(900);
    expect(entity.priority).toBe(5);
    expect(entity.maxInstances).toBe(2);
    expect(entity.preferredDevice).toBe('cuda:0');
    expect(entity.version).toBe(3);
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted.aiModelId).toBe('model-1');
    expect(persisted.class).toBe(ModelResidencyClass.PINNED);
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { priority: 9, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ priority: 9 });
  });
});
