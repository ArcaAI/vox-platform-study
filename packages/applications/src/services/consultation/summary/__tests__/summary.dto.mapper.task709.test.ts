/**
 * TASK-709 — Optimistic Concurrency Control on note-content writes.
 *
 * `SummaryDtoMapper.toResponse` maps a `SummaryResponse` FROM a
 * `ContextItemEntity` (the summary IS a ContextItem row), so it must surface
 * `entity.version` — the OCC compare-and-set counter — the same way
 * `ContextDtoMapper.toResponse` does, so SDK clients can echo it back via
 * `If-Match`/`expectedVersion` on `PATCH :id/summary/:summaryId` and
 * `POST :id/summary/:contextItemId/approve`.
 */
import { describe, it, expect } from 'vitest';
import type { ContextItemEntity } from '@arcaai/domains';
import { SummaryDtoMapper } from '../summary.dto.mapper';

describe('SummaryDtoMapper.toResponse — version (TASK-709 OCC)', () => {
  it('maps entity.version onto the response version field', () => {
    const now = new Date();
    const entity = {
      id: 'ctx-1',
      consultationId: 'consult-1',
      type: 'summary',
      content: 'A generated summary',
      createdAt: now,
      updatedAt: now,
      version: 7,
    } as unknown as ContextItemEntity;

    const response = SummaryDtoMapper.toResponse(entity);

    expect(response.version).toBe(7);
  });
});
