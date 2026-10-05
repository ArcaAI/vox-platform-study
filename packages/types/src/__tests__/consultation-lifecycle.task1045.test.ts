import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_KINDS,
  ATTACHMENT_KINDS,
  ATTACHMENT_STATUSES,
  CONSULTATION_CLOSED_REASONS,
  CONSULTATION_PROCESSING,
  CONSULTATION_STATUSES,
  DEFAULT_FEEDBACK_REASON_CODES,
  FEEDBACK_RATINGS,
  FEEDBACK_TARGET_KINDS,
  LEGACY_STATUS_MAP,
  LIFECYCLE_EVENT_TYPES,
  isNoteReady,
  NOTE_READY_REASON,
  normalizeLegacyConsultationStatus,
} from '../consultation-lifecycle.js';

const LEGACY_VALUES = [
  'OPEN',
  'RECORDING',
  'DRAFT_PENDING_SENSORS',
  'PENDING_REVIEW',
  'SIGNED',
  'CLOSED',
  'REOPENED',
  'PRIMED',
  'DRAINING',
  'TIMED_OUT',
  'CLOSED_COMPLETE',
  'CLOSED_INCOMPLETE',
];

describe('consultation lifecycle vocabulary', () => {
  it('carries the seven statuses, six processing values and three closed reasons', () => {
    expect([...CONSULTATION_STATUSES]).toEqual([
      'OPEN',
      'RECORDING',
      'PAUSED',
      'STOPPED',
      'APPROVED',
      'CLOSED_COMPLETE',
      'CLOSED_INCOMPLETE',
    ]);
    expect([...CONSULTATION_PROCESSING]).toEqual([
      'IDLE',
      'FINALIZING_TRANSCRIPT',
      'SUMMARIZING',
      'PROCESSING_ATTACHMENT',
      'AWAITING_REVIEW',
      'FAILED',
    ]);
    expect([...CONSULTATION_CLOSED_REASONS]).toEqual(['AUTO', 'MANUAL', 'APPROVED']);
  });

  it('lists every lifecycle event type', () => {
    expect([...LIFECYCLE_EVENT_TYPES]).toEqual([
      'opened',
      'encounter_appended',
      'started',
      'paused',
      'stopped',
      'transcript_final',
      'processing_changed',
      'approved',
      'closed',
      'reopened',
    ]);
  });

  it('lists feedback, activity and attachment vocabularies', () => {
    expect([...FEEDBACK_RATINGS]).toEqual(['up', 'down', 'cleared']);
    expect([...FEEDBACK_TARGET_KINDS]).toEqual([
      'NOTE',
      'SECTION',
      'SEGMENT',
      'ENTITY',
      'TRANSCRIPT',
      'RECAP',
    ]);
    expect([...DEFAULT_FEEDBACK_REASON_CODES]).toEqual([
      'missing_information',
      'wrong_medication_or_dose',
      'wrong_patient_detail',
      'made_something_up',
      'wrong_section',
      'too_long',
      'wrong_language',
    ]);
    expect([...ACTIVITY_KINDS]).toEqual([
      'TRANSCRIPT_SEGMENT',
      'FULL_TRANSCRIPT',
      'NOTE',
      'PRE_SUMMARY',
      'CASE_NOTE',
      'ATTACHMENT',
      'RECORDING',
      'FACT_LEDGER',
      'ENCOUNTER_RECAP',
      'STRUCTURED',
      'FEEDBACK',
      'LIFECYCLE',
    ]);
    expect([...ATTACHMENT_KINDS]).toEqual(['document', 'image', 'audio', 'case_note']);
    expect([...ATTACHMENT_STATUSES]).toEqual([
      'INTENT',
      'UPLOADED',
      'PROCESSING',
      'READY',
      'FAILED',
      'EXPIRED',
    ]);
  });
});

describe('legacy status normalisation', () => {
  it('maps all twelve legacy values to a valid new status', () => {
    expect(Object.keys(LEGACY_STATUS_MAP).sort()).toEqual([...LEGACY_VALUES].sort());
    for (const v of LEGACY_VALUES) {
      expect(CONSULTATION_STATUSES).toContain(normalizeLegacyConsultationStatus(v).status);
    }
  });

  it.each([
    ['OPEN', 'OPEN', 'IDLE'],
    ['PRIMED', 'OPEN', 'IDLE'],
    ['REOPENED', 'OPEN', 'IDLE'],
    ['RECORDING', 'RECORDING', 'IDLE'],
    ['DRAINING', 'STOPPED', 'FINALIZING_TRANSCRIPT'],
    ['DRAFT_PENDING_SENSORS', 'STOPPED', 'SUMMARIZING'],
    ['SIGNED', 'APPROVED', 'IDLE'],
    ['TIMED_OUT', 'CLOSED_INCOMPLETE', 'IDLE'],
    ['CLOSED', 'CLOSED_COMPLETE', 'IDLE'],
    ['CLOSED_COMPLETE', 'CLOSED_COMPLETE', 'IDLE'],
    ['CLOSED_INCOMPLETE', 'CLOSED_INCOMPLETE', 'IDLE'],
  ])('%s -> %s / %s', (legacy, status, processing) => {
    expect(normalizeLegacyConsultationStatus(legacy)).toEqual({ status, processing });
  });

  it('maps PENDING_REVIEW to a ready note: STOPPED, IDLE, NOTE_READY', () => {
    expect(normalizeLegacyConsultationStatus('PENDING_REVIEW')).toEqual({
      status: 'STOPPED',
      processing: 'IDLE',
      processingReason: NOTE_READY_REASON,
    });
  });

  it('lets an explicit processing value win over the implied one', () => {
    expect(normalizeLegacyConsultationStatus('DRAINING', 'FAILED')).toEqual({
      status: 'STOPPED',
      processing: 'FAILED',
    });
  });

  it('passes through new-vocabulary values and PAUSED/STOPPED/APPROVED', () => {
    expect(normalizeLegacyConsultationStatus('PAUSED')).toEqual({
      status: 'PAUSED',
      processing: 'IDLE',
    });
    expect(normalizeLegacyConsultationStatus('APPROVED', 'IDLE').status).toBe('APPROVED');
  });

  it('returns null for an unknown value', () => {
    expect(normalizeLegacyConsultationStatus('NOPE')).toBeNull();
  });
});

describe('isNoteReady', () => {
  it('is true for STOPPED + IDLE + NOTE_READY and for STOPPED + AWAITING_REVIEW', () => {
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE', processingReason: 'NOTE_READY' })).toBe(true);
    expect(isNoteReady({ status: 'STOPPED', processing: 'AWAITING_REVIEW' })).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE' })).toBe(false);
    expect(isNoteReady({ status: 'STOPPED', processing: 'IDLE', processingReason: null })).toBe(false);
    expect(isNoteReady({ status: 'STOPPED', processing: 'SUMMARIZING', processingReason: 'NOTE_READY' })).toBe(false);
    expect(isNoteReady({ status: 'APPROVED', processing: 'IDLE', processingReason: 'NOTE_READY' })).toBe(false);
    expect(isNoteReady({ status: 'OPEN', processing: 'AWAITING_REVIEW' })).toBe(false);
  });

  it('treats a normalised PENDING_REVIEW as ready', () => {
    expect(isNoteReady(normalizeLegacyConsultationStatus('PENDING_REVIEW')!)).toBe(true);
  });
});
