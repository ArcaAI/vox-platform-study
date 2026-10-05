/**
 * `ContextItemVersion._metadata` is written through the entity's typed `metaData` accessor: the
 * assignment is change-tracked, so `repository.update` (which persists `entity.changes` through
 * the mapper) carries it, exactly as `create` does.
 */
import { describe, expect, it } from 'vitest';
import { ContextItemVersionEntity } from '../ContextItemVersionEntity';
import { ContextItemVersionEntityMapper } from '../../../../mappers/generated/core/ContextItemVersionEntityMapper';

function version(): ContextItemVersionEntity {
  return new ContextItemVersionEntity({
    id: 'v1',
    tenantId: 't1',
    contextItemId: 'ci1',
    versionNumber: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date('2026-10-05T00:00:00Z'),
    updatedAt: null,
  });
}

describe('ContextItemVersionEntity.metaData', () => {
  it('is a typed, change-tracked accessor', () => {
    const entity = version();
    expect(entity.metaData).toBeUndefined();
    entity.metaData = { sttRunKey: 'run-1' };
    expect(entity.metaData).toEqual({ sttRunKey: 'run-1' });
    expect(entity.changes).toHaveProperty('metaData');
  });

  it('an update persists the metadata change', () => {
    const entity = version();
    entity.metaData = { derivedFrom: 3 };
    const changes = ContextItemVersionEntityMapper.getInstance().toPersistenceChanges(entity) as Record<string, unknown>;
    expect(changes.metaData).toEqual({ derivedFrom: 3 });
  });
});
