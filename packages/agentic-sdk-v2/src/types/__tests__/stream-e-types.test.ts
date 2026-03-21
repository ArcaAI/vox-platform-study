/**
 * @arcaai/vox - Stream E Types Tests (Layer 2 — Feature Parity)
 *
 * Tests for new type definitions required by Stream E gaps:
 * - SUM-01: AsyncJobResponse, SummaryJobStatus
 * - SUM-02: ComprehensiveSummaryResponse, ComprehensiveSummaryOptions
 * - SES-04: TimelineEntry, TimelineScope
 * - SES-05: ContextVersionEntry
 * - SES-06: PaginationParams usage in existing interfaces
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// SUM-01: Async summary job types
// =============================================================================

describe('SUM-01: async summary job types', () => {
  it('should define AsyncJobResponse interface', async () => {
    const types = await import('../summary');
    const sample: import('../summary').AsyncJobResponse = {
      jobId: 'job-1',
      status: 'pending',
      consultationId: 'c-1',
      createdAt: '2026-02-17T00:00:00Z',
    };
    expect(sample.jobId).toBe('job-1');
    expect(sample.status).toBe('pending');
    expect(sample.consultationId).toBe('c-1');
    expect(sample.createdAt).toBe('2026-02-17T00:00:00Z');
  });

  it('should define SummaryJobStatus enum/type', async () => {
    const statuses: import('../summary').SummaryJobStatus[] = [
      'pending',
      'processing',
      'completed',
      'failed',
    ];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('processing');
    expect(statuses).toContain('completed');
    expect(statuses).toContain('failed');
  });

  it('should allow optional progress and result fields on AsyncJobResponse', async () => {
    const sample: import('../summary').AsyncJobResponse = {
      jobId: 'job-2',
      status: 'completed',
      consultationId: 'c-1',
      createdAt: '2026-02-17T00:00:00Z',
      progress: 100,
      result: { id: 's-1', content: 'Summary', type: 'summary' },
    };
    expect(sample.progress).toBe(100);
    expect(sample.result).toBeDefined();
  });
});

// =============================================================================
// SUM-02: Comprehensive summary types
// =============================================================================

describe('SUM-02: comprehensive summary types', () => {
  it('should define ComprehensiveSummaryResponse interface', async () => {
    const sample: import('../summary').ComprehensiveSummaryResponse = {
      id: 'cs-1',
      content: 'Comprehensive summary across consultations',
      consultationIds: ['c-1', 'c-2', 'c-3'],
      createdAt: '2026-02-17T00:00:00Z',
    };
    expect(sample.id).toBe('cs-1');
    expect(sample.consultationIds).toHaveLength(3);
    expect(sample.content).toContain('Comprehensive');
  });

  it('should define ComprehensiveSummaryOptions interface', async () => {
    const options: import('../summary').ComprehensiveSummaryOptions = {
      dnaStyleId: 'dna-1',
      includeNER: true,
    };
    expect(options.dnaStyleId).toBe('dna-1');
    expect(options.includeNER).toBe(true);
  });

  it('should allow optional fields on ComprehensiveSummaryResponse', async () => {
    const sample: import('../summary').ComprehensiveSummaryResponse = {
      id: 'cs-2',
      content: 'Summary',
      consultationIds: ['c-1'],
      createdAt: '2026-02-17T00:00:00Z',
      modelName: 'gpt-4',
      processingTimeMs: 1234,
    };
    expect(sample.modelName).toBe('gpt-4');
    expect(sample.processingTimeMs).toBe(1234);
  });
});

// =============================================================================
// SES-04: Timeline types
// =============================================================================

describe('SES-04: timeline types', () => {
  it('should define TimelineEntry interface', async () => {
    const entry: import('../consultation').TimelineEntry = {
      id: 't-1',
      consultationId: 'c-1',
      type: 'context_added',
      timestamp: '2026-02-17T10:00:00Z',
      description: 'Case note added',
    };
    expect(entry.id).toBe('t-1');
    expect(entry.type).toBe('context_added');
    expect(entry.timestamp).toBeDefined();
  });

  it('should define TimelineScope type', async () => {
    const scopes: import('../consultation').TimelineScope[] = ['single', 'chain'];
    expect(scopes).toContain('single');
    expect(scopes).toContain('chain');
  });

  it('should allow optional metadata on TimelineEntry', async () => {
    const entry: import('../consultation').TimelineEntry = {
      id: 't-2',
      consultationId: 'c-1',
      type: 'summary_generated',
      timestamp: '2026-02-17T11:00:00Z',
      description: 'Summary generated',
      metadata: { model: 'gpt-4', processingTimeMs: 500 },
    };
    expect(entry.metadata).toBeDefined();
    expect(entry.metadata!.model).toBe('gpt-4');
  });
});

// =============================================================================
// SES-05: Context version history types
// =============================================================================

describe('SES-05: context version history types', () => {
  it('should define ContextVersionEntry interface', async () => {
    const version: import('../context').ContextVersionEntry = {
      versionNumber: 1,
      content: 'Original content',
      updatedAt: '2026-02-17T10:00:00Z',
      updatedBy: 'doctor-1',
    };
    expect(version.versionNumber).toBe(1);
    expect(version.content).toBe('Original content');
    expect(version.updatedAt).toBeDefined();
  });

  it('should allow optional fields on ContextVersionEntry', async () => {
    const version: import('../context').ContextVersionEntry = {
      versionNumber: 2,
      content: 'Updated content',
      updatedAt: '2026-02-17T11:00:00Z',
      changeDescription: 'Fixed typo',
    };
    expect(version.changeDescription).toBe('Fixed typo');
    expect(version.updatedBy).toBeUndefined();
  });
});

// =============================================================================
// SES-06: Pagination params on ContextFilters
// =============================================================================

describe('SES-06: pagination params in ContextFilters', () => {
  it('should accept page and limit in ContextFilters', async () => {
    const filters: import('../context').ContextFilters = {
      type: 'case_note',
      page: 1,
      limit: 20,
    };
    expect(filters.page).toBe(1);
    expect(filters.limit).toBe(20);
  });
});
