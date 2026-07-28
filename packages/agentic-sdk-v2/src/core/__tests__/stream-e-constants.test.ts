/**
 * @arcaai/vox - Stream E Constants Tests (Layer 2 — Feature Parity)
 *
 * Tests for new endpoint constants required by Stream E gaps:
 * - SUM-01: Async summary endpoints
 * - SUM-02: Comprehensive summary endpoint
 * - SUM-03: getLatestPreSummary endpoint
 * - SUM-04: getSummaries (list all) endpoint
 * - SES-04: Timeline endpoint
 * - SES-05: Context version history endpoints
 * - NER-R-03: extractEntities wiring (already exists in SUMMARY_ENDPOINTS)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { SUMMARY_ENDPOINTS, CONSULTATION_ENDPOINTS, CONTEXT_ENDPOINTS } from '../constants';

// =============================================================================
// SUM-01: Async summary endpoints
// =============================================================================

describe('SUM-01: async summary endpoints', () => {
  it('should have GENERATE_ASYNC endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.GENERATE_ASYNC).toBe('function');
    expect(SUMMARY_ENDPOINTS.GENERATE_ASYNC('c-1')).toBe('/consultations/c-1/summary/async');
  });

  it('should have PRE_SUMMARY_ASYNC endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC).toBe('function');
    expect(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC('c-1')).toBe('/consultations/c-1/summary/pre-summary/async');
  });

  it('should have COMPREHENSIVE_ASYNC endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC).toBe('function');
    expect(SUMMARY_ENDPOINTS.COMPREHENSIVE_ASYNC('c-1')).toBe('/consultations/c-1/summary/comprehensive/async');
  });
});

// =============================================================================
// SUM-02: Comprehensive summary endpoint
// =============================================================================

describe('SUM-02: comprehensive summary endpoint', () => {
  it('should have COMPREHENSIVE endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.COMPREHENSIVE).toBe('function');
    expect(SUMMARY_ENDPOINTS.COMPREHENSIVE('c-1')).toBe('/consultations/c-1/summary/comprehensive');
  });
});

// =============================================================================
// SUM-03: getLatestPreSummary endpoint
// =============================================================================

describe('SUM-03: latest pre-summary endpoint', () => {
  it('should have LATEST_PRE_SUMMARY endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY).toBe('function');
    expect(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY('c-1')).toBe('/consultations/c-1/summary/pre-summary/latest');
  });
});

// =============================================================================
// SUM-04: List all summaries endpoint
// =============================================================================

describe('SUM-04: list all summaries endpoint', () => {
  it('should have LIST endpoint', () => {
    expect(typeof SUMMARY_ENDPOINTS.LIST).toBe('function');
    expect(SUMMARY_ENDPOINTS.LIST('c-1')).toBe('/consultations/c-1/summary');
  });
});

// =============================================================================
// SES-04: Timeline endpoint
// =============================================================================

describe('SES-04: timeline endpoint', () => {
  it('should have TIMELINE endpoint on CONSULTATION_ENDPOINTS', () => {
    expect(typeof CONSULTATION_ENDPOINTS.TIMELINE).toBe('function');
    expect(CONSULTATION_ENDPOINTS.TIMELINE('c-1')).toBe('/consultations/c-1/timeline');
  });
});

// =============================================================================
// SES-05: Context version history endpoints
// =============================================================================

describe('SES-05: context version history endpoints', () => {
  it('should have VERSIONS endpoint', () => {
    expect(typeof CONTEXT_ENDPOINTS.VERSIONS).toBe('function');
    expect(CONTEXT_ENDPOINTS.VERSIONS('c-1', 'ctx-1')).toBe('/consultations/c-1/context/ctx-1/versions');
  });

  it('should have VERSION endpoint for specific version', () => {
    expect(typeof CONTEXT_ENDPOINTS.VERSION).toBe('function');
    expect(CONTEXT_ENDPOINTS.VERSION('c-1', 'ctx-1', 3)).toBe('/consultations/c-1/context/ctx-1/versions/3');
  });
});

// =============================================================================
// NER-R-03: EXTRACT_ENTITIES already exists — verify it's correct
// =============================================================================

describe('NER-R-03: extract entities endpoint', () => {
  it('should have EXTRACT_ENTITIES endpoint (already existed)', () => {
    expect(typeof SUMMARY_ENDPOINTS.EXTRACT_ENTITIES).toBe('function');
    expect(SUMMARY_ENDPOINTS.EXTRACT_ENTITIES('c-1', 'ctx-1')).toBe('/consultations/c-1/summary/ctx-1/extract-entities');
  });
});

// =============================================================================
// Edge cases: special characters in IDs, boundary values
// =============================================================================

describe('Edge cases: special characters and boundary values', () => {
  it('should handle IDs with UUIDs correctly', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(SUMMARY_ENDPOINTS.GENERATE_ASYNC(uuid)).toBe(`/consultations/${uuid}/summary/async`);
    expect(CONSULTATION_ENDPOINTS.TIMELINE(uuid)).toBe(`/consultations/${uuid}/timeline`);
  });

  it('should handle CONTEXT_ENDPOINTS.VERSION with version 0', () => {
    expect(CONTEXT_ENDPOINTS.VERSION('c-1', 'ctx-1', 0)).toBe('/consultations/c-1/context/ctx-1/versions/0');
  });

  it('should handle CONTEXT_ENDPOINTS.VERSION with large version numbers', () => {
    expect(CONTEXT_ENDPOINTS.VERSION('c-1', 'ctx-1', 9999)).toBe('/consultations/c-1/context/ctx-1/versions/9999');
  });

  it('should handle IDs with numeric-only strings', () => {
    expect(CONTEXT_ENDPOINTS.VERSIONS('12345', '67890')).toBe('/consultations/12345/context/67890/versions');
  });

  it('should produce distinct paths for GENERATE vs GENERATE_ASYNC', () => {
    const id = 'c-1';
    expect(SUMMARY_ENDPOINTS.GENERATE(id)).not.toBe(SUMMARY_ENDPOINTS.GENERATE_ASYNC(id));
  });

  it('should produce distinct paths for PRE_SUMMARY vs PRE_SUMMARY_ASYNC', () => {
    const id = 'c-1';
    expect(SUMMARY_ENDPOINTS.PRE_SUMMARY(id)).not.toBe(SUMMARY_ENDPOINTS.PRE_SUMMARY_ASYNC(id));
  });

  it('should produce distinct paths for LATEST vs LATEST_PRE_SUMMARY', () => {
    const id = 'c-1';
    expect(SUMMARY_ENDPOINTS.LATEST(id)).not.toBe(SUMMARY_ENDPOINTS.LATEST_PRE_SUMMARY(id));
  });
});
