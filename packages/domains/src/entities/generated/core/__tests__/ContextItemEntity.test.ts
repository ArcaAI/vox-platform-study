/**
 * ContextItemEntity Unit Tests
 *
 * Covers the Qdrant sync markers, which must record their change so that
 * `toPersistenceChanges` emits the `qdrantSynced` column.
 */

import { describe, it, expect } from 'vitest';
import { ContextItemEntity } from '../ContextItemEntity';
import type { IContextItemEntity } from '../ContextItemEntity';
import { ContextItemSource, ContextItemType, ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IContextItemEntity> = {}) =>
  new ContextItemEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    consultationId: 'consult-1',
    type: ContextItemType.RAW_SUMMARY,
    source: ContextItemSource.USER,
    currentVersionNumber: 1,
    content: 'hello',
    dnaWritingStyleId: null,
    qdrantSynced: false,
    qdrantSyncedAt: null,
    createdBy: 'user-1',
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: null,
    version: 1,
    ...overrides,
  });

describe('ContextItemEntity Qdrant sync markers', () => {
  it('markQdrantNeedsSync records qdrantSynced in changes', () => {
    const entity = createEntity({ qdrantSynced: true, qdrantSyncedAt: new Date() });

    entity.markQdrantNeedsSync();

    expect(entity.isSyncedToQdrant).toBe(false);
    expect(entity.changes).toHaveProperty('qdrantSynced', false);
  });

  it('markQdrantSynced records qdrantSynced and qdrantSyncedAt in changes', () => {
    const entity = createEntity({ qdrantSynced: false, qdrantSyncedAt: null });

    entity.markQdrantSynced();

    expect(entity.isSyncedToQdrant).toBe(true);
    expect(entity.changes).toHaveProperty('qdrantSynced', true);
    expect(entity.changes.qdrantSyncedAt).toBeInstanceOf(Date);
  });
});
