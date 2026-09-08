/**
 * TASK-932 R-16a — DNA provenance on the summary response.
 *
 * `dnaStyleId` is a column on the NOTE row (`ContextItem.dnaWritingStyleId`), not on the
 * provenance row. `GET :id/summary/latest` reads the note through
 * `findLatestRawSummary` / `findLatestModifiedSummary`, neither of which loads the
 * `SummaryMeta` relation — so a `structuredData` block built only when the relation is
 * present reported `undefined` for a note whose row plainly names the clinician's report.
 * Observed live: the persisted RAW_SUMMARY carried `73000000-…-0001`, the route answered
 * `structuredData: undefined`.
 */
import { describe, it, expect } from 'vitest';
import { SummaryMetaFactory, ContextItemEntity } from '@arcaai/domains';
import { SummaryDtoMapper } from '../summary.dto.mapper';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const DNA_REPORT_ID = '73000000-0000-0000-0001-000000000001';

function note(overrides: Record<string, unknown> = {}): ContextItemEntity {
  const now = new Date();
  return {
    id: 'ctx-1',
    consultationId: 'consult-1',
    type: 'RAW_SUMMARY',
    content: 'A finalized note',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as unknown as ContextItemEntity;
}

describe('SummaryDtoMapper.toResponse — dnaStyleId provenance (TASK-932 R-16a)', () => {
  it('reports dnaStyleId from the note row when the SummaryMeta relation is NOT loaded (the latest-summary read path)', () => {
    const response = SummaryDtoMapper.toResponse(note({ dnaWritingStyleId: DNA_REPORT_ID }));

    expect(response.structuredData?.dnaStyleId).toBe(DNA_REPORT_ID);
  });

  it('reports dnaStyleId alongside the provenance fields when SummaryMeta IS loaded', () => {
    const meta = SummaryMetaFactory.CreateSummaryMeta({ tenantId: TENANT_ID, contextItemId: 'ctx-1', cacheHit: false, qualityScore: 0.5 });

    const response = SummaryDtoMapper.toResponse(note({ dnaWritingStyleId: DNA_REPORT_ID, SummaryMeta: meta }));

    expect(response.structuredData?.dnaStyleId).toBe(DNA_REPORT_ID);
    expect(response.structuredData?.qualityScore).toBe(0.5);
  });

  it('keeps structuredData absent for a note with neither provenance nor a style (byte-identical legacy shape)', () => {
    const response = SummaryDtoMapper.toResponse(note());

    expect(response.structuredData).toBeUndefined();
  });
});
