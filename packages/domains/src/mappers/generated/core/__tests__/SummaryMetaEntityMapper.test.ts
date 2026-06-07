/**
 * SummaryMetaEntityMapper — versionless persistence (TASK-330).
 *
 * `core.SummaryMeta` has `id`, `tenantId`, `createdAt`, `updatedAt` but NO
 * `_version` / `_metadata` / `createdBy` / `updatedBy` columns. The shared
 * `BaseTenantEntity`/`BaseTenantDataModel` still carry those meta fields, and
 * `AutoClassMapper` would otherwise echo `version: 1` into the insert payload —
 * which makes Prisma reject the harness `persist_draft` write with
 * `Unknown argument 'version'`. The mapper must strip the absent meta fields
 * while preserving `createdAt`/`updatedAt`, which DO exist.
 *
 * @see TASK-330 Phase 1 — harness `persist_draft` SummaryMeta persistence
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { SummaryMetaEntityMapper } from '../SummaryMetaEntityMapper';
import { SummaryMeta } from '../../../../models/generated/core/SummaryMetaModel';

const sampleRow = (overrides: Partial<SummaryMeta> = {}): SummaryMeta =>
  new SummaryMeta({
    id: 'sm-1',
    tenantId: 't-1',
    version: 1,
    metaData: null,
    createdBy: 'u-1',
    updatedBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    contextItemId: 'ci-1',
    aiModelId: null,
    aiModelVersion: null,
    promptVersion: '1',
    processingTimeMs: null,
    inputTokens: null,
    outputTokens: null,
    caseNoteIds: [],
    preSummaryIds: [],
    previousSummaryIds: [],
    generatedAt: new Date(),
    cacheHit: null,
    qualityScore: null,
    promptResolvedFrom: null,
    resolvedPromptId: null,
    entityFaithfulnessScore: 0.875,
    coverageScore: 0.9,
    ragTriadScore: null,
    citationsMap: { claims: [] },
    guardrailDecisions: null,
    attestationRef: null,
    modelName: 'gemma3:latest',
    ...overrides,
  } as SummaryMeta);

describe('SummaryMetaEntityMapper — versionless persistence (TASK-330)', () => {
  const mapper = new SummaryMetaEntityMapper();

  it('toDomainEntity carries scalar fields from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.contextItemId).toBe('ci-1');
    expect(entity.entityFaithfulnessScore).toBe(0.875);
  });

  it('toPersistence omits base meta columns the SummaryMeta table does not define', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    const persisted = mapper.toPersistence(entity);

    // Absent columns — emitting them makes Prisma reject the insert.
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).not.toHaveProperty('createdBy');
    expect(persisted).not.toHaveProperty('updatedBy');
    expect(persisted).not.toHaveProperty('metaData');

    // Columns that DO exist must still be written.
    expect(persisted).toMatchObject({ contextItemId: 'ci-1', promptVersion: '1' });
    expect(persisted).toHaveProperty('createdAt');
    expect(persisted).toHaveProperty('updatedAt');
  });
});
