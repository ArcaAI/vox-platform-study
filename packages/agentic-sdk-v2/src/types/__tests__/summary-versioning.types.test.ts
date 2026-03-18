/**
 * @arcaai/vox - Summary Versioning Types Tests
 *
 * Tests for new summary versioning types added by WS-3.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import type {
  UpdateSummaryOptions,
  SummaryVersionEntry,
  SummaryMeta,
} from '../summary';

// =============================================================================
// UpdateSummaryOptions
// =============================================================================

describe('Summary versioning types', () => {
  describe('UpdateSummaryOptions', () => {
    it('should accept change metadata', () => {
      const options: UpdateSummaryOptions = {
        changeReason: 'Doctor corrected diagnosis',
        changeSummary: 'Changed primary diagnosis from X to Y',
        changeSource: 'doctor_edit',
      };
      expect(options.changeReason).toBe('Doctor corrected diagnosis');
      expect(options.changeSource).toBe('doctor_edit');
    });

    it('should accept all valid change sources', () => {
      const sources: UpdateSummaryOptions['changeSource'][] = [
        'doctor_edit', 'ai_regeneration', 'system',
      ];
      sources.forEach(source => {
        const options: UpdateSummaryOptions = { changeSource: source };
        expect(options.changeSource).toBe(source);
      });
    });

    it('should accept empty options', () => {
      const options: UpdateSummaryOptions = {};
      expect(options.changeReason).toBeUndefined();
    });
  });

  // ===========================================================================
  // SummaryVersionEntry
  // ===========================================================================

  describe('SummaryVersionEntry', () => {
    it('should accept required fields', () => {
      const entry: SummaryVersionEntry = {
        id: 'version-001',
        contextItemId: 'ctx-001',
        versionNumber: 1,
        content: 'Original summary content',
        createdAt: '2026-02-18T10:00:00Z',
      };
      expect(entry.versionNumber).toBe(1);
      expect(entry.content).toBe('Original summary content');
    });

    it('should accept optional change metadata', () => {
      const entry: SummaryVersionEntry = {
        id: 'version-002',
        contextItemId: 'ctx-001',
        versionNumber: 2,
        content: 'Updated summary content',
        changeReason: 'Doctor edit',
        changeSource: 'doctor_edit',
        changedBy: 'doctor-456',
        createdAt: '2026-02-18T11:00:00Z',
      };
      expect(entry.changeReason).toBe('Doctor edit');
      expect(entry.changedBy).toBe('doctor-456');
    });
  });

  // ===========================================================================
  // SummaryMeta
  // ===========================================================================

  describe('SummaryMeta', () => {
    it('should provide summary metadata', () => {
      const meta: SummaryMeta = {
        id: 'summary-001',
        type: 'summary',
        versionNumber: 3,
        status: 'active',
        createdAt: '2026-02-18T10:00:00Z',
        updatedAt: '2026-02-18T12:00:00Z',
      };
      expect(meta.versionNumber).toBe(3);
      expect(meta.type).toBe('summary');
    });
  });
});
