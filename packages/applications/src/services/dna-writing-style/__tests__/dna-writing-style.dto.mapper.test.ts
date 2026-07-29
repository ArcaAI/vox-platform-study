/**
 * DnaWritingStyleDtoMapper Unit Tests
 *
 * Tests entity-to-response mapping with real-like entity structures.
 * No mocks needed — pure function testing.
 */

import { describe, it, expect } from 'vitest';
import { DnaWritingStyleDtoMapper } from '../dna-writing-style.dto.mapper';

describe('DnaWritingStyleDtoMapper', () => {
  describe('toReportResponse', () => {
    it('should map all fields correctly with populated entity', () => {
      const entity = {
        id: 'report-1',
        doctorId: 'doctor-1',
        reportData: { formality: 'high', sentenceLength: 'medium' },
        styleText: 'Doctor writes in a formal, concise style.',
        isLatest: true,
        currentVersionNumber: 2,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T12:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.id).toBe('report-1');
      expect(result.doctorId).toBe('doctor-1');
      expect(result).not.toHaveProperty('departmentId');
      expect(result.reportData).toEqual({ formality: 'high', sentenceLength: 'medium' });
      expect(result.styleText).toBe('Doctor writes in a formal, concise style.');
      expect(result.isLatest).toBe(true);
      expect(result.currentVersionNumber).toBe(2);
      expect(result.createdAt).toBe('2026-02-18T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-02-18T12:00:00.000Z');
    });

    it('should handle null/undefined fields with fallback defaults', () => {
      const entity = {
        id: 'report-2',
        doctorId: null,
        reportData: null,
        styleText: null,
        isLatest: null,
        currentVersionNumber: null,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.doctorId).toBe('');
      expect(result).not.toHaveProperty('departmentId');
      expect(result.reportData).toBeUndefined();
      expect(result.styleText).toBeUndefined();
      expect(result.isLatest).toBe(false);
      expect(result.currentVersionNumber).toBe(1);
    });

    it('should surface the row _version OCC token', () => {
      const entity = {
        id: 'report-occ',
        doctorId: 'doc-1',
        version: 7,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.version).toBe(7);
    });

    it('should convert date fields to ISO string', () => {
      const entity = {
        id: 'report-3',
        doctorId: 'doc-1',
        createdAt: new Date('2026-02-18T14:30:45.123Z'),
        updatedAt: new Date('2026-02-18T15:45:00.999Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.createdAt).toBe('2026-02-18T14:30:45.123Z');
      expect(result.updatedAt).toBe('2026-02-18T15:45:00.999Z');
    });

    it('should use empty string default for required doctorId when null', () => {
      const entity = {
        id: 'report-4',
        doctorId: undefined,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.doctorId).toBe('');
    });

    it('should use undefined for optional fields when null', () => {
      const entity = {
        id: 'report-5',
        doctorId: 'doc-1',
        reportData: null,
        styleText: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result).not.toHaveProperty('departmentId');
      expect(result.reportData).toBeUndefined();
      expect(result.styleText).toBeUndefined();
    });

    it('should handle entity with all null optional fields', () => {
      const entity = {
        id: 'report-minimal',
        doctorId: 'doc-1',
        reportData: null,
        styleText: null,
        isLatest: null,
        currentVersionNumber: null,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.id).toBe('report-minimal');
      expect(result.doctorId).toBe('doc-1');
      expect(result).not.toHaveProperty('departmentId');
      expect(result.reportData).toBeUndefined();
      expect(result.styleText).toBeUndefined();
      expect(result.isLatest).toBe(false);
      expect(result.currentVersionNumber).toBe(1);
    });

    it('should handle entity with complex JSON in reportData', () => {
      const complexReportData = {
        formality: 'high',
        sentenceLength: 'medium',
        nested: {
          traits: ['concise', 'technical'],
          scores: { clarity: 0.9, brevity: 0.85 },
        },
        array: [{ key: 'value' }, { another: 123 }],
      };

      const entity = {
        id: 'report-6',
        doctorId: 'doc-1',
        reportData: complexReportData,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.reportData).toEqual(complexReportData);
    });

    it('should map resourceStatus ENABLED from entity', () => {
      const entity = {
        id: 'report-rs-1',
        doctorId: 'doc-1',
        resourceStatus: 'ENABLED',
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.resourceStatus).toBe('ENABLED');
    });

    it('should map resourceStatus DISABLED from entity', () => {
      const entity = {
        id: 'report-rs-2',
        doctorId: 'doc-1',
        resourceStatus: 'DISABLED',
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.resourceStatus).toBe('DISABLED');
    });

    it('should return undefined resourceStatus when entity has null resourceStatus', () => {
      const entity = {
        id: 'report-rs-3',
        doctorId: 'doc-1',
        resourceStatus: null,
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.resourceStatus).toBeUndefined();
    });

    it('should return undefined resourceStatus when entity has no resourceStatus field', () => {
      const entity = {
        id: 'report-rs-4',
        doctorId: 'doc-1',
        createdAt: new Date('2026-02-18T10:00:00Z'),
        updatedAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toReportResponse(entity as any);

      expect(result.resourceStatus).toBeUndefined();
    });
  });

  describe('toVersionResponse', () => {
    it('should map version response correctly', () => {
      const entity = {
        id: 'ver-1',
        dnaReportId: 'report-1',
        versionNumber: 2,
        reportData: { formality: 'medium' },
        styleText: 'Updated style text',
        changeReason: 'Manual refinement',
        changedBy: 'user-1',
        createdAt: new Date('2026-02-18T11:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toVersionResponse(entity as any);

      expect(result.id).toBe('ver-1');
      expect(result.dnaReportId).toBe('report-1');
      expect(result.versionNumber).toBe(2);
      expect(result.reportData).toEqual({ formality: 'medium' });
      expect(result.styleText).toBe('Updated style text');
      expect(result.changeReason).toBe('Manual refinement');
      expect(result.changedBy).toBe('user-1');
      expect(result.createdAt).toBe('2026-02-18T11:00:00.000Z');
    });

    it('should handle null/undefined version fields with defaults', () => {
      const entity = {
        id: 'ver-2',
        dnaReportId: null,
        versionNumber: null,
        reportData: null,
        styleText: null,
        changeReason: null,
        changedBy: null,
        createdAt: new Date('2026-02-18T11:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toVersionResponse(entity as any);

      expect(result.dnaReportId).toBe('');
      expect(result.versionNumber).toBe(0);
      expect(result.reportData).toBeUndefined();
      expect(result.styleText).toBeUndefined();
      expect(result.changeReason).toBeUndefined();
      expect(result.changedBy).toBeUndefined();
    });

    it('should convert version createdAt to ISO string', () => {
      const entity = {
        id: 'ver-3',
        dnaReportId: 'report-1',
        versionNumber: 1,
        createdAt: new Date('2026-02-18T09:15:30.500Z'),
      };

      const result = DnaWritingStyleDtoMapper.toVersionResponse(entity as any);

      expect(result.createdAt).toBe('2026-02-18T09:15:30.500Z');
    });

    it('should handle version with complex JSON in reportData', () => {
      const complexReportData = {
        deep: { nested: { value: 42 } },
        list: [1, 2, 3],
        metadata: { source: 'ai', confidence: 0.95 },
      };

      const entity = {
        id: 'ver-4',
        dnaReportId: 'report-1',
        versionNumber: 1,
        reportData: complexReportData,
        createdAt: new Date('2026-02-18T10:00:00Z'),
      };

      const result = DnaWritingStyleDtoMapper.toVersionResponse(entity as any);

      expect(result.reportData).toEqual(complexReportData);
    });
  });
});
