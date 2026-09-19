/**
 * @arcaai/vox - DNA Writing Style Types Tests
 *
 * Tests that DNA types are properly defined and exported,
 * and that they are compatible with existing DNAStyle/DNAStyleData.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import type { DnaReport, DnaReportData, DnaStyleVersion, DnaGenerateInput, DnaUpdateInput, DnaReportWithFallback } from '../dna';

import type { DNAStyle, DNAStyleData } from '../summary';

// =============================================================================
// Helper factories
// =============================================================================

function makeDnaReport(overrides: Partial<DnaReport> = {}): DnaReport {
  return {
    id: 'dna-report-001',
    doctorId: 'doctor-456',
    reportData: { formality: 'high', sentenceLength: 'medium' },
    isLatest: true,
    currentVersionNumber: 1,
    createdAt: '2026-02-18T10:00:00Z',
    updatedAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

function makeDnaVersion(overrides: Partial<DnaStyleVersion> = {}): DnaStyleVersion {
  return {
    id: 'dna-version-001',
    dnaReportId: 'dna-report-001',
    versionNumber: 1,
    reportData: { formality: 'high' },
    createdAt: '2026-02-18T10:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// DnaReport
// =============================================================================

describe('DNA Writing Style types', () => {
  describe('DnaReport interface', () => {
    it('should accept a valid DnaReport with required fields', () => {
      const report = makeDnaReport();
      expect(report.id).toBe('dna-report-001');
      expect(report.doctorId).toBe('doctor-456');
      expect(report.isLatest).toBe(true);
      expect(report.currentVersionNumber).toBe(1);
    });

    it('should accept all optional fields', () => {
      const report = makeDnaReport({
        version: 3,
        styleText: 'Formal clinical writing with standard abbreviations.',
      });
      expect(report.version).toBe(3);
      expect(report.styleText).toBeDefined();
    });

    it('should accept reportData as a flexible record', () => {
      const report = makeDnaReport({
        reportData: {
          formality: 'high',
          sentenceLength: 'medium',
          medicalTermUsage: 'frequent',
          abbreviationStyle: 'standard',
        },
      });
      expect(report.reportData.formality).toBe('high');
    });
  });

  // ===========================================================================
  // DnaReportData
  // ===========================================================================

  describe('DnaReportData interface', () => {
    it('should extend DNAStyleData with additional fields', () => {
      const data: DnaReportData = {
        avgSentenceLength: 15,
        vocabularyComplexity: 0.8,
        formalityLevel: 0.9,
        commonPhrases: ['patient presents with'],
        formality: 'high',
      };
      expect(data.avgSentenceLength).toBe(15);
      expect(data.formality).toBe('high');
    });

    it('should be assignable from DNAStyleData fields', () => {
      const styleData: DNAStyleData = {
        avgSentenceLength: 12,
        vocabularyComplexity: 0.7,
        formalityLevel: 0.85,
      };
      const reportData: DnaReportData = {
        ...styleData,
        formality: 'medium',
      };
      expect(reportData.avgSentenceLength).toBe(12);
    });
  });

  // ===========================================================================
  // DnaStyleVersion
  // ===========================================================================

  describe('DnaStyleVersion interface', () => {
    it('should accept required fields', () => {
      const version = makeDnaVersion();
      expect(version.id).toBe('dna-version-001');
      expect(version.dnaReportId).toBe('dna-report-001');
      expect(version.versionNumber).toBe(1);
    });

    it('should accept optional change metadata', () => {
      const version = makeDnaVersion({
        styleText: 'Updated style text',
        changeReason: 'Refined analysis',
        changedBy: 'doctor-456',
      });
      expect(version.changeReason).toBe('Refined analysis');
      expect(version.changedBy).toBe('doctor-456');
    });
  });

  // ===========================================================================
  // Input types
  // ===========================================================================

  describe('DnaGenerateInput', () => {
    it('should accept empty input (generate from existing samples)', () => {
      const input: DnaGenerateInput = {};
      expect(input.textSamples).toBeUndefined();
    });

    it('should accept text samples', () => {
      const input: DnaGenerateInput = {
        textSamples: ['Sample text 1', 'Sample text 2'],
        sourceIds: ['ctx-1'],
      };
      expect(input.textSamples).toHaveLength(2);
    });

    it('should accept promptTemplateId and editedSummary', () => {
      const input: DnaGenerateInput = {
        promptTemplateId: 'tmpl-001',
        editedSummary: 'Patient presents with mild cough.',
      };
      expect(input.promptTemplateId).toBe('tmpl-001');
      expect(input.editedSummary).toBeDefined();
    });
  });

  describe('DnaUpdateInput', () => {
    it('should accept partial update fields', () => {
      const input: DnaUpdateInput = {
        styleText: 'Updated style',
        changeReason: 'Manual correction',
      };
      expect(input.styleText).toBe('Updated style');
    });

    it('should accept redactionRules, resourceStatus and expectedVersion', () => {
      const input: DnaUpdateInput = {
        redactionRules: { rules: [{ id: 'r-1', type: 'remove', match: 'literal', pattern: 'SSN' }] },
        resourceStatus: 'DISABLED',
        expectedVersion: 2,
      };
      expect(input.resourceStatus).toBe('DISABLED');
      expect(input.expectedVersion).toBe(2);
    });
  });

  // ===========================================================================
  // DnaReportWithFallback
  // ===========================================================================

  describe('DnaReportWithFallback', () => {
    it('should include fallback source indicator', () => {
      const result: DnaReportWithFallback = {
        ...makeDnaReport(),
        fallbackSource: 'department',
      };
      expect(result.fallbackSource).toBe('department');
    });

    it('should indicate doctor source when no fallback', () => {
      const result: DnaReportWithFallback = {
        ...makeDnaReport(),
        fallbackSource: 'doctor',
      };
      expect(result.fallbackSource).toBe('doctor');
    });
  });
});
