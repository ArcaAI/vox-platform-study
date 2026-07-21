/**
 * SummaryMetaFactory + SummaryMetaEntityMapper — promptResolvedFrom/resolvedPromptId.
 *
 * The prompt-resolution tier (`'preferred' | 'department' |
 * 'default'`) and the prompt id actually used must be persisted on SummaryMeta so
 * the summary surface can show which tier produced a given summary. This slice
 * threads the two new columns through the domain layer (entity ⇄ model).
 */
import { describe, it, expect } from 'vitest';
import { SummaryMetaFactory } from '../SummaryMetaFactory';
import { SummaryMetaEntityMapper } from '../../../../mappers/generated/core/SummaryMetaEntityMapper';
import { SummaryMeta } from '../../../../models/generated/core/SummaryMetaModel';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('SummaryMetaFactory — promptResolvedFrom/resolvedPromptId (TASK-331 F4)', () => {
  it('threads promptResolvedFrom/resolvedPromptId onto the created entity', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      promptResolvedFrom: 'department',
      resolvedPromptId: 'prompt-123',
    });

    expect(entity.promptResolvedFrom).toBe('department');
    expect(entity.resolvedPromptId).toBe('prompt-123');
  });

  it('defaults promptResolvedFrom/resolvedPromptId to null when omitted', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
    });

    expect(entity.promptResolvedFrom).toBeNull();
    expect(entity.resolvedPromptId).toBeNull();
  });
});

describe('SummaryMetaEntityMapper — promptResolvedFrom/resolvedPromptId round-trip (TASK-331 F4)', () => {
  const mapper = new SummaryMetaEntityMapper();

  it('toPersistence carries promptResolvedFrom/resolvedPromptId to the data model', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      promptResolvedFrom: 'preferred',
      resolvedPromptId: 'prompt-abc',
    });

    const model = mapper.toPersistence(entity);

    expect(model.promptResolvedFrom).toBe('preferred');
    expect(model.resolvedPromptId).toBe('prompt-abc');
  });

  it('toDomainEntity carries promptResolvedFrom/resolvedPromptId from the database row', () => {
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
      cacheHit: null,
      qualityScore: null,
      promptResolvedFrom: 'default',
      resolvedPromptId: 'prompt-default',
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as SummaryMeta);

    const entity = mapper.toDomainEntity(row);

    expect(entity.promptResolvedFrom).toBe('default');
    expect(entity.resolvedPromptId).toBe('prompt-default');
  });
});
