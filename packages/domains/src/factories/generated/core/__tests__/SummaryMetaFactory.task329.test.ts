/**
 * SummaryMetaFactory + SummaryMetaEntityMapper — cacheHit/qualityScore threading.
 *
 * Summarization completeness: the Prisma columns
 * `SummaryMeta.cacheHit` (Boolean?) and `SummaryMeta.qualityScore` (Float?)
 * already exist; this slice threads them through the domain layer
 * (entity ⇄ model) so the application/API layers can surface them.
 */
import { describe, it, expect } from 'vitest';
import { SummaryMetaFactory } from '../SummaryMetaFactory';
import { SummaryMetaEntityMapper } from '../../../../mappers/generated/core/SummaryMetaEntityMapper';
import { SummaryMeta } from '../../../../models/generated/core/SummaryMetaModel';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('SummaryMetaFactory — cacheHit/qualityScore (TASK-329)', () => {
  it('threads cacheHit/qualityScore onto the created entity', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      cacheHit: true,
      qualityScore: 0.87,
    });

    expect(entity.cacheHit).toBe(true);
    expect(entity.qualityScore).toBe(0.87);
  });

  it('defaults cacheHit/qualityScore to null when omitted', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
    });

    expect(entity.cacheHit).toBeNull();
    expect(entity.qualityScore).toBeNull();
  });
});

describe('SummaryMetaEntityMapper — cacheHit/qualityScore round-trip (TASK-329)', () => {
  const mapper = new SummaryMetaEntityMapper();

  it('toPersistence carries cacheHit/qualityScore to the data model', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      cacheHit: false,
      qualityScore: 0.42,
    });

    const model = mapper.toPersistence(entity);

    expect(model.cacheHit).toBe(false);
    expect(model.qualityScore).toBe(0.42);
  });

  it('toDomainEntity carries cacheHit/qualityScore from the database row', () => {
    const row = new SummaryMeta({
      id: 'sm-1',
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      aiModelId: null,
      aiModelVersion: null,
      promptVersion: null,
      processingTimeMs: null,
      inputTokens: null,
      outputTokens: null,
      caseNoteIds: [],
      preSummaryIds: [],
      previousSummaryIds: [],
      generatedAt: null,
      cacheHit: true,
      qualityScore: 0.95,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as SummaryMeta);

    const entity = mapper.toDomainEntity(row);

    expect(entity.cacheHit).toBe(true);
    expect(entity.qualityScore).toBe(0.95);
  });
});
