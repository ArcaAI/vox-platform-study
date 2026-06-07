/**
 * NamedEntityEntityMapper — versionless, append-only persistence (TASK-330).
 *
 * The `core.NamedEntity` table is append-only: it has `createdAt` but NO
 * `version`, `updatedAt`, `createdBy`, or `updatedBy` columns. The shared
 * `BaseTenantEntity`/`BaseTenantDataModel` still carry those meta fields, and
 * `AutoClassMapper` would otherwise echo them into the insert payload — which
 * makes Prisma reject the write with `Unknown argument 'version'`. The mapper
 * must therefore strip every base meta field that the table does not define.
 *
 * @see TASK-330 Phase 1 — harness `persist_entities` + legacy NER persistence
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { NamedEntityEntityMapper } from '../NamedEntityEntityMapper';
import { NamedEntity } from '../../../../models/generated/core/NamedEntityModel';

const sampleRow = (overrides: Partial<NamedEntity> = {}): NamedEntity =>
  new NamedEntity({
    id: 'ne-1',
    tenantId: 't-1',
    version: 1,
    metaData: null,
    createdBy: 'u-1',
    updatedBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    contextItemId: 'ci-1',
    text: 'aspirin',
    className: 'MEDICATION',
    normalizedText: 'Aspirin',
    startOffset: 0,
    endOffset: 7,
    confidence: 0.9,
    aiModelId: null,
    aiModelVersion: null,
    processingTimeMs: null,
    metadata: null,
    umlsCui: null,
    snomedCode: null,
    rxnormCode: null,
    icdCode: null,
    loincCode: null,
    transcriptContextItemId: null,
    transcriptStartOffset: null,
    transcriptEndOffset: null,
    ...overrides,
  } as NamedEntity);

describe('NamedEntityEntityMapper — versionless append-only persistence (TASK-330)', () => {
  const mapper = new NamedEntityEntityMapper();

  it('toDomainEntity carries scalar fields from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.text).toBe('aspirin');
    expect(entity.className).toBe('MEDICATION');
  });

  it('toPersistence omits base meta columns the NamedEntity table does not define', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    const persisted = mapper.toPersistence(entity);

    // None of these columns exist on `core.NamedEntity`; emitting them makes
    // Prisma reject the insert (`Unknown argument 'version'`).
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).not.toHaveProperty('updatedAt');
    expect(persisted).not.toHaveProperty('createdBy');
    expect(persisted).not.toHaveProperty('updatedBy');

    // Columns that DO exist must still be written.
    expect(persisted).toMatchObject({
      text: 'aspirin',
      className: 'MEDICATION',
      contextItemId: 'ci-1',
    });
    // `createdAt` IS a real column, so it must survive (AutoClassMapper may
    // serialize the Date to an ISO string, which Prisma accepts).
    expect(persisted).toHaveProperty('createdAt');
    expect(persisted.createdAt).toBeTruthy();
  });

  it('toPersistenceChanges never re-emits the stripped meta columns', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    (entity as any)._changes = { normalizedText: 'ASA', version: 99, updatedAt: new Date() };
    const persisted = mapper.toPersistenceChanges(entity);

    expect(persisted).not.toHaveProperty('version');
    expect(persisted).not.toHaveProperty('updatedAt');
    expect(persisted).toMatchObject({ normalizedText: 'ASA' });
  });
});
