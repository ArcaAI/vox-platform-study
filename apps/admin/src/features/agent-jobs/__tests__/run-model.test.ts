/**
 * TASK-407 — Agent Jobs display model. NO drawn design exists for this surface
 * (flagged in the ticket): rows are the tenant's `PromptUsageRecord` run
 * history joined client-side to already-loaded templates/departments,
 * mirroring the TASK-379/380 tenant-detail grid patterns.
 */

import { describe, it, expect } from 'vitest';
import { resolveRunRows, agentSummaryRows, scoreColorRole } from '../run-model';

const templates = [
  { id: 'tpl-1', name: 'SOAP Summary', category: 'SUMMARY', status: 'PUBLISHED', lastTestScore: 87, lastTestAt: '2026-07-01T08:30:00Z' },
  { id: 'tpl-2', name: 'Explore', category: 'EXPLORE', status: 'DRAFT', lastTestScore: null, lastTestAt: null },
] as never[];

describe('resolveRunRows', () => {
  it('joins template names and department names onto run records', () => {
    const rows = resolveRunRows(
      [
        {
          id: 'run-1',
          promptTemplateId: 'tpl-1',
          promptVersionNumber: 3,
          consultationId: 'cons-1',
          doctorId: 'doc-1',
          departmentId: 'dept-1',
          createdAt: '2026-07-01T09:00:00Z',
        },
      ],
      templates,
      new Map([['dept-1', 'Cardiology']]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].templateName).toBe('SOAP Summary');
    expect(rows[0].category).toBe('SUMMARY');
    expect(rows[0].departmentName).toBe('Cardiology');
    expect(rows[0].version).toBe(3);
  });

  it('degrades to em-dash-able nulls when the template/department is unknown', () => {
    const rows = resolveRunRows(
      [
        {
          id: 'run-2',
          promptTemplateId: 'gone',
          promptVersionNumber: null,
          consultationId: null,
          doctorId: null,
          departmentId: null,
          createdAt: '2026-07-01T09:00:00Z',
        },
      ],
      templates,
      new Map(),
    );

    expect(rows[0].templateName).toBeNull();
    expect(rows[0].departmentName).toBeNull();
    expect(rows[0].version).toBeNull();
  });
});

describe('agentSummaryRows', () => {
  it('projects templates into the per-agent summary sorted by name', () => {
    const rows = agentSummaryRows(templates);
    expect(rows.map((r) => r.name)).toEqual(['Explore', 'SOAP Summary']);
    expect(rows[1].lastTestScore).toBe(87);
    expect(rows[0].lastTestScore).toBeNull();
  });
});

describe('scoreColorRole', () => {
  it('grades scores: ≥80 success, ≥50 warning, <50 destructive, null neutral', () => {
    expect(scoreColorRole(92)).toBe('success');
    expect(scoreColorRole(80)).toBe('success');
    expect(scoreColorRole(65)).toBe('warning');
    expect(scoreColorRole(30)).toBe('destructive');
    expect(scoreColorRole(null)).toBe('neutral');
    expect(scoreColorRole(undefined)).toBe('neutral');
  });
});
