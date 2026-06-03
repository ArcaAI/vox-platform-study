/**
 * TASK-331 doc-06 F4 — surface the prompt-resolution tier on the summary DTO.
 *
 * `SummaryMeta` now persists `promptResolvedFrom` (preferred/department/default)
 * and `resolvedPromptId`; `SummaryDtoMapper.toResponse` must expose both inside
 * `structuredData` so the playground summary panel can render which tier produced
 * the summary.
 */
import { describe, it, expect } from 'vitest';
import { SummaryMetaFactory, ContextItemEntity } from '@arcaai/domains';
import { SummaryDtoMapper } from '../summary.dto.mapper';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('SummaryDtoMapper.toResponse — promptResolvedFrom/resolvedPromptId (TASK-331 F4)', () => {
  it('includes promptResolvedFrom and resolvedPromptId in structuredData when SummaryMeta is present', () => {
    const meta = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      promptResolvedFrom: 'department',
      resolvedPromptId: 'prompt-123',
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

    expect(response.structuredData?.promptResolvedFrom).toBe('department');
    expect(response.structuredData?.resolvedPromptId).toBe('prompt-123');
  });
});
