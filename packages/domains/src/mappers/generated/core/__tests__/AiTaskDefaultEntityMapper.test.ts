/**
 * AiTaskDefaultEntityMapper — round-trip tests (TASK-506 Phase 3).
 *
 * Mirrors the `GlobalSettingEntityMapper` version-round-trip suite:
 *  - `version` is carried DB row → entity (read),
 *  - `version` is stripped from BOTH write paths (`FIELDS_NOT_WRITABLE`),
 *  - the JsonB `configJson` column round-trips intact.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiTaskDefaultEntityMapper } from '../AiTaskDefaultEntityMapper';
import { AiTaskDefault } from '../../../../models/generated/core/AiTaskDefaultModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';

const sampleRow = (overrides: Partial<AiTaskDefault> = {}): AiTaskDefault =>
  new AiTaskDefault({
    id: 'atd-1',
    tenantId: 't-1',
    taskKey: 'guardrail.validate',
    modelSlug: 'granite-guardian-4.1-8b',
    configJson: { threshold: 0.8, nested: { list: [1, 2, 3] } },
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 4,
    metaData: null,
  } as AiTaskDefault);

describe('AiTaskDefaultEntityMapper (TASK-506)', () => {
  const mapper = new AiTaskDefaultEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.taskKey).toBe('guardrail.validate');
    expect(entity.modelSlug).toBe('granite-guardian-4.1-8b');
    expect(entity.version).toBe(4);
  });

  it('round-trips `configJson` (JsonB) intact through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.configJson).toEqual({ threshold: 0.8, nested: { list: [1, 2, 3] } });

    const persisted = mapper.toPersistence(entity);
    expect(persisted.configJson).toEqual({ threshold: 0.8, nested: { list: [1, 2, 3] } });
    expect(persisted.taskKey).toBe('guardrail.validate');
    expect(persisted.modelSlug).toBe('granite-guardian-4.1-8b');
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { modelSlug: 'other-slug', version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ modelSlug: 'other-slug' });
  });
});
