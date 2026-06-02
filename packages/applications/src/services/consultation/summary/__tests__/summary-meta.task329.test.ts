/**
 * TASK-329 (P6 — Summarization completeness)
 *
 * The summary list + version browser response DTOs must surface the
 * `cacheHit` / `qualityScore` fields that were threaded through the
 * SummaryMeta domain entity in this slice.
 */
import { describe, it, expect } from 'vitest';
import { SummaryMetaFactory, ContextItemEntity } from '@arcaai/domains';
import { ContextDtoMapper } from '../../context/context.dto.mapper';
import { SummaryDtoMapper } from '../summary.dto.mapper';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('ContextDtoMapper.toSummaryMetaResponse — cacheHit/qualityScore (TASK-329)', () => {
  it('surfaces cacheHit and qualityScore from the entity', () => {
    const meta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      cacheHit: true,
      qualityScore: 0.88,
    });

    const response = ContextDtoMapper.toSummaryMetaResponse(meta);

    expect(response.cacheHit).toBe(true);
    expect(response.qualityScore).toBe(0.88);
  });
});

describe('SummaryDtoMapper.toResponse — cacheHit/qualityScore (TASK-329)', () => {
  it('includes cacheHit and qualityScore in structuredData when SummaryMeta is present', () => {
    const meta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      cacheHit: false,
      qualityScore: 0.73,
    });

    const now = new Date();
    const entity = {
      id: 'ctx-1',
      consultationId: 'consult-1',
      type: 'summary',
      content: 'A generated summary',
      createdAt: now,
      updatedAt: now,
      SummaryMeta: meta,
    } as unknown as ContextItemEntity;

    const response = SummaryDtoMapper.toResponse(entity);

    expect(response.structuredData?.cacheHit).toBe(false);
    expect(response.structuredData?.qualityScore).toBe(0.73);
  });
});
