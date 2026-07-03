import { describe, expect, it } from 'vitest';
import {
  canStartSandboxConsultation,
  consultationOptionLabel,
  consultationStatusRole,
  contextTypeLabel,
  dnaAttributeEntries,
  formatProcessingTime,
  isSummaryContextType,
  splitPlaygroundContext,
  splitTextSamples,
  voiceProfileState,
} from '../playground-format';

describe('TASK-408 — playground-format', () => {
  describe('consultationStatusRole', () => {
    it('maps terminal-success statuses to success', () => {
      expect(consultationStatusRole('CLOSED')).toBe('success');
      expect(consultationStatusRole('completed')).toBe('success');
    });

    it('maps in-flight statuses to info', () => {
      expect(consultationStatusRole('OPEN')).toBe('info');
      expect(consultationStatusRole('RECORDING')).toBe('info');
      expect(consultationStatusRole('TRANSCRIBING')).toBe('info');
      expect(consultationStatusRole('SUMMARIZING')).toBe('info');
      expect(consultationStatusRole('active')).toBe('info');
    });

    it('maps review to warning and cancelled to destructive', () => {
      expect(consultationStatusRole('REVIEW')).toBe('warning');
      expect(consultationStatusRole('CANCELLED')).toBe('destructive');
      expect(consultationStatusRole('cancelled')).toBe('destructive');
    });

    it('falls back to neutral for unknown/absent statuses', () => {
      expect(consultationStatusRole(undefined)).toBe('neutral');
      expect(consultationStatusRole('SOMETHING_NEW')).toBe('neutral');
    });
  });

  describe('consultationOptionLabel', () => {
    it('joins short id, patient, status and date', () => {
      const label = consultationOptionLabel({
        id: 'abcdef1234567890',
        patientId: 'PAT-42-XYZ',
        status: 'OPEN',
        appointmentDate: '2026-07-01',
      });
      expect(label).toContain('#abcdef12');
      expect(label).toContain('patient PAT-42');
      expect(label).toContain('OPEN');
      expect(label).toContain('2026'); // formatted date keeps the year
    });

    it('omits missing parts and survives an unparseable date', () => {
      const label = consultationOptionLabel({ id: 'deadbeef99', createdAt: 'not-a-date' });
      expect(label).toBe('#deadbeef  ·  not-a-date');
    });
  });

  describe('canStartSandboxConsultation (doctor-identity gate)', () => {
    it('allows doctor-tier roles (matches the legacy playground access rule)', () => {
      expect(canStartSandboxConsultation(['DOCTOR'])).toBe(true);
      expect(canStartSandboxConsultation(['SPECIALIST'])).toBe(true);
      expect(canStartSandboxConsultation(['NURSE', 'DOCTOR'])).toBe(true);
    });

    it('denies plain admins — consultations are doctor-owned records', () => {
      expect(canStartSandboxConsultation(['SUPER_ADMIN'])).toBe(false);
      expect(canStartSandboxConsultation(['TENANT_ADMIN'])).toBe(false);
      expect(canStartSandboxConsultation([])).toBe(false);
      expect(canStartSandboxConsultation(null)).toBe(false);
      expect(canStartSandboxConsultation(undefined)).toBe(false);
    });
  });

  describe('voiceProfileState', () => {
    it('derives Active (success) and Inactive (neutral) — dot+label, never color-only', () => {
      expect(voiceProfileState({ isActive: true })).toEqual({ label: 'Active', colorRole: 'success' });
      expect(voiceProfileState({ isActive: false })).toEqual({ label: 'Inactive', colorRole: 'neutral' });
      expect(voiceProfileState({})).toEqual({ label: 'Inactive', colorRole: 'neutral' });
    });
  });

  describe('dnaAttributeEntries', () => {
    it('extracts only the attributes present, with human labels', () => {
      const entries = dnaAttributeEntries({
        formality: 'formal',
        medicalTermUsage: 'frequent',
        avgSentenceLength: 18.4,
        vocabularyComplexity: 0.72,
      });
      expect(entries).toEqual([
        { label: 'Formality', value: 'formal' },
        { label: 'Medical terms', value: 'frequent' },
        { label: 'Avg sentence length', value: '18.4' },
        { label: 'Vocabulary complexity', value: '0.72' },
      ]);
    });

    it('returns an empty list for absent report data', () => {
      expect(dnaAttributeEntries(undefined)).toEqual([]);
      expect(dnaAttributeEntries({})).toEqual([]);
    });
  });

  describe('formatProcessingTime', () => {
    it('renders ms below a second and seconds above', () => {
      expect(formatProcessingTime(850)).toBe('850 ms');
      expect(formatProcessingTime(1234)).toBe('1.2 s');
      expect(formatProcessingTime(60_000)).toBe('60.0 s');
    });

    it('renders an em-dash for absent values', () => {
      expect(formatProcessingTime(undefined)).toBe('—');
    });
  });

  describe('isSummaryContextType', () => {
    it('classifies summary-ish context item types', () => {
      expect(isSummaryContextType('RAW_SUMMARY')).toBe(true);
      expect(isSummaryContextType('MODIFIED_SUMMARY')).toBe(true);
      expect(isSummaryContextType('PRE_SUMMARY')).toBe(true);
    });

    it('rejects non-summary types', () => {
      expect(isSummaryContextType('CASE_NOTE')).toBe(false);
      expect(isSummaryContextType('TRANSCRIPT')).toBe(false);
      expect(isSummaryContextType(undefined)).toBe(false);
    });
  });

  describe('contextTypeLabel', () => {
    it('gives summary types friendly names and lowercases the rest', () => {
      expect(contextTypeLabel('RAW_SUMMARY')).toBe('Summary');
      expect(contextTypeLabel('MODIFIED_SUMMARY')).toBe('Modified summary');
      expect(contextTypeLabel('PRE_SUMMARY')).toBe('Pre-summary');
      expect(contextTypeLabel('CASE_NOTE')).toBe('case note');
      expect(contextTypeLabel(undefined)).toBe('unknown');
    });
  });

  describe('splitPlaygroundContext', () => {
    it('separates summary items from the rest, preserving order', () => {
      const { items, summaries } = splitPlaygroundContext([
        { id: 'a', type: 'CASE_NOTE' },
        { id: 'b', type: 'RAW_SUMMARY' },
        { id: 'c', type: 'TRANSCRIPT' },
        { id: 'd', type: 'PRE_SUMMARY' },
      ]);
      expect(items.map((i) => i.id)).toEqual(['a', 'c']);
      expect(summaries.map((i) => i.id)).toEqual(['b', 'd']);
    });

    it('handles absent input', () => {
      expect(splitPlaygroundContext(undefined)).toEqual({ items: [], summaries: [] });
    });
  });

  describe('splitTextSamples', () => {
    it('splits on blank lines, trims, and drops empties', () => {
      const raw = 'First sample line one.\nStill first sample.\n\n  Second sample.  \n\n\n';
      expect(splitTextSamples(raw)).toEqual(['First sample line one.\nStill first sample.', 'Second sample.']);
    });

    it('returns an empty list for whitespace-only input', () => {
      expect(splitTextSamples('   \n \n')).toEqual([]);
    });
  });
});
