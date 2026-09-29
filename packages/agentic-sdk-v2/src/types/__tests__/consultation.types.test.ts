/**
 * @arcaai/vox - Consultation Types Tests (SES-02)
 *
 * Tests that consultation types are properly defined and exported,
 * and that utility functions (isNewVisit, isRevisit) behave correctly.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import type {
  Consultation,
  ConsultationStatus,
  CreateConsultationInput,
  StartRevisitInput,
  UpdateConsultationInput,
  OpenSessionInput,
  TimelineEntry,
  TimelineScope,
} from '../consultation';

import { CONSULTATION_STATUS_ORDER, isNewVisit, isRevisit, normalizeConsultationStatus } from '../consultation';

// =============================================================================
// Helper: minimal valid Consultation factory
// =============================================================================

function makeConsultation(overrides: Partial<Consultation> = {}): Consultation {
  return {
    id: 'consult-001',
    patientId: 'patient-123',
    doctorId: 'doctor-456',
    appointmentDate: '2026-02-17',
    createdAt: '2026-02-17T10:00:00Z',
    updatedAt: '2026-02-17T10:00:00Z',
    ...overrides,
  };
}

// =============================================================================
// Existing Types (should already work)
// =============================================================================

describe('consultation types', () => {
  describe('Consultation interface', () => {
    it('should accept a valid Consultation with only required fields', () => {
      const consultation = makeConsultation();
      expect(consultation.id).toBe('consult-001');
      expect(consultation.patientId).toBe('patient-123');
      expect(consultation.doctorId).toBe('doctor-456');
      expect(consultation.appointmentDate).toBe('2026-02-17');
      expect(consultation.createdAt).toBeDefined();
      expect(consultation.updatedAt).toBeDefined();
    });

    it('should accept all optional fields', () => {
      const consultation = makeConsultation({
        doctorName: 'Dr. Smith',
        department: 'Cardiology',
        metadata: { room: '3A' },
        isNew: true,
        contextItems: [],
      });
      expect(consultation.doctorName).toBe('Dr. Smith');
      expect(consultation.department).toBe('Cardiology');
      expect(consultation.isNew).toBe(true);
      expect(consultation.contextItems).toEqual([]);
    });

    it('should allow undefined optional fields', () => {
      const consultation = makeConsultation();
      expect(consultation.doctorName).toBeUndefined();
      expect(consultation.department).toBeUndefined();
      expect(consultation.metadata).toBeUndefined();
      expect(consultation.isNew).toBeUndefined();
      expect(consultation.contextItems).toBeUndefined();
    });
  });

  describe('OpenSessionInput interface', () => {
    it('should accept minimal input (only patientId)', () => {
      const input: OpenSessionInput = {
        patientId: 'patient-123',
      };
      expect(input.patientId).toBe('patient-123');
      expect(input.appointmentDate).toBeUndefined();
      expect(input.department).toBeUndefined();
      expect(input.metadata).toBeUndefined();
    });

    it('should accept all optional fields', () => {
      const input: OpenSessionInput = {
        patientId: 'patient-123',
        appointmentDate: '2026-02-17',
        department: 'ENT',
        metadata: { referralSource: 'GP' },
      };
      expect(input.appointmentDate).toBe('2026-02-17');
      expect(input.department).toBe('ENT');
      expect(input.metadata).toEqual({ referralSource: 'GP' });
    });
  });

  describe('TimelineEntry and TimelineScope (SES-04)', () => {
    it('should accept a valid TimelineEntry', () => {
      const entry: TimelineEntry = {
        id: 'tl-001',
        consultationId: 'consult-001',
        type: 'context_added',
        timestamp: '2026-02-17T10:05:00Z',
        description: 'Case note added',
      };
      expect(entry.type).toBe('context_added');
      expect(entry.metadata).toBeUndefined();
    });

    it('should accept TimelineEntry with optional metadata', () => {
      const entry: TimelineEntry = {
        id: 'tl-002',
        consultationId: 'consult-001',
        type: 'ner_extracted',
        timestamp: '2026-02-17T10:06:00Z',
        description: '3 entities extracted',
        metadata: { entityCount: 3 },
      };
      expect(entry.metadata).toEqual({ entityCount: 3 });
    });

    it('should accept valid TimelineScope values', () => {
      const single: TimelineScope = 'single';
      const chain: TimelineScope = 'chain';
      expect(single).toBe('single');
      expect(chain).toBe('chain');
    });
  });
});

// =============================================================================
// SES-02: New Types (were missing, now defined)
// =============================================================================

describe('consultation types (SES-02)', () => {
  describe('ConsultationStatus', () => {
    it('is exactly the 12 Prisma ConsultationStatus values', () => {
      const all: Record<ConsultationStatus, true> = {
        OPEN: true,
        PRIMED: true,
        RECORDING: true,
        DRAINING: true,
        DRAFT_PENDING_SENSORS: true,
        PENDING_REVIEW: true,
        SIGNED: true,
        TIMED_OUT: true,
        REOPENED: true,
        CLOSED_COMPLETE: true,
        CLOSED_INCOMPLETE: true,
        CLOSED: true,
      };
      expect(Object.keys(all)).toHaveLength(12);
    });

    it('CONSULTATION_STATUS_ORDER lists the live-to-note phases in lifecycle order', () => {
      expect(CONSULTATION_STATUS_ORDER).toEqual(['OPEN', 'PRIMED', 'RECORDING', 'DRAINING', 'PENDING_REVIEW', 'SIGNED']);
    });

    it('normalizeConsultationStatus passes real values through and maps the three legacy strings', () => {
      expect(normalizeConsultationStatus('PENDING_REVIEW')).toBe('PENDING_REVIEW');
      expect(normalizeConsultationStatus('active')).toBe('OPEN');
      expect(normalizeConsultationStatus('completed')).toBe('CLOSED');
      expect(normalizeConsultationStatus('cancelled')).toBe('CLOSED_INCOMPLETE');
    });
  });

  describe('CreateConsultationInput', () => {
    it('should require patientId and appointmentDate', () => {
      const input: CreateConsultationInput = {
        patientId: 'patient-123',
        appointmentDate: '2026-02-17',
      };
      expect(input.patientId).toBe('patient-123');
      expect(input.appointmentDate).toBe('2026-02-17');
      expect(input.department).toBeUndefined();
      expect(input.metadata).toBeUndefined();
    });

    it('should accept optional department and metadata', () => {
      const input: CreateConsultationInput = {
        patientId: 'patient-123',
        appointmentDate: '2026-02-17',
        department: 'Cardiology',
        metadata: { urgency: 'high' },
      };
      expect(input.department).toBe('Cardiology');
      expect(input.metadata).toEqual({ urgency: 'high' });
    });
  });

  describe('StartRevisitInput', () => {
    it('should require parentConsultationId', () => {
      const input: StartRevisitInput = {
        parentConsultationId: 'consult-001',
      };
      expect(input.parentConsultationId).toBe('consult-001');
      expect(input.appointmentDate).toBeUndefined();
      expect(input.metadata).toBeUndefined();
    });

    it('should accept optional appointmentDate and metadata', () => {
      const input: StartRevisitInput = {
        parentConsultationId: 'consult-001',
        appointmentDate: '2026-02-18',
        metadata: { reason: 'Follow-up' },
      };
      expect(input.appointmentDate).toBe('2026-02-18');
      expect(input.metadata).toEqual({ reason: 'Follow-up' });
    });
  });

  describe('UpdateConsultationInput', () => {
    it('should accept partial update with department only', () => {
      const input: UpdateConsultationInput = { department: 'Neurology' };
      expect(input.department).toBe('Neurology');
      expect(input.status).toBeUndefined();
      expect(input.metadata).toBeUndefined();
    });

    it('should accept status update', () => {
      const input: UpdateConsultationInput = { status: 'CLOSED_COMPLETE' };
      expect(input.status).toBe('CLOSED_COMPLETE');
    });

    it('should accept metadata update', () => {
      const input: UpdateConsultationInput = {
        metadata: { notes: 'Updated by Dr. Smith' },
      };
      expect(input.metadata).toEqual({ notes: 'Updated by Dr. Smith' });
    });

    it('should accept combined update with all fields', () => {
      const input: UpdateConsultationInput = {
        department: 'Oncology',
        status: 'CLOSED_INCOMPLETE',
        metadata: { reason: 'Patient transferred' },
      };
      expect(input.department).toBe('Oncology');
      expect(input.status).toBe('CLOSED_INCOMPLETE');
      expect(input.metadata).toEqual({ reason: 'Patient transferred' });
    });

    it('should accept empty object (no changes)', () => {
      const input: UpdateConsultationInput = {};
      expect(Object.keys(input)).toHaveLength(0);
    });
  });
});

// =============================================================================
// Utility Functions: isNewVisit / isRevisit
// =============================================================================

describe('isNewVisit()', () => {
  it('should return true when consultation.isNew is true', () => {
    expect(isNewVisit(makeConsultation({ isNew: true }))).toBe(true);
  });

  it('should return false when consultation.isNew is false', () => {
    expect(isNewVisit(makeConsultation({ isNew: false }))).toBe(false);
  });

  it('should return false when consultation.isNew is undefined', () => {
    expect(isNewVisit(makeConsultation())).toBe(false);
  });

  it('should return false when consultation is null', () => {
    expect(isNewVisit(null)).toBe(false);
  });
});

describe('isRevisit()', () => {
  it('should return true when the top-level parentConsultationId is set (the gateway field)', () => {
    expect(isRevisit(makeConsultation({ parentConsultationId: 'consult-parent' }))).toBe(true);
  });

  it('should return false when the top-level parentConsultationId is null and nothing else says revisit', () => {
    expect(isRevisit(makeConsultation({ parentConsultationId: null }))).toBe(false);
  });

  it("should trust visitType when present: 'revisit' is true, 'new-visit' is false", () => {
    expect(isRevisit(makeConsultation({ visitType: 'revisit' }))).toBe(true);
    expect(isRevisit(makeConsultation({ visitType: 'new-visit', parentConsultationId: null }))).toBe(false);
  });

  it('should prefer the top-level parentConsultationId over a stale metadata marker', () => {
    expect(isRevisit(makeConsultation({ parentConsultationId: null, visitType: 'new-visit', metadata: { parentConsultationId: 'old' } }))).toBe(false);
  });

  it('should return true when metadata has parentConsultationId', () => {
    const consultation = makeConsultation({
      metadata: { parentConsultationId: 'consult-parent' },
    });
    expect(isRevisit(consultation)).toBe(true);
  });

  it('should return false when metadata has no parentConsultationId', () => {
    const consultation = makeConsultation({
      metadata: { room: '3A' },
    });
    expect(isRevisit(consultation)).toBe(false);
  });

  it('should return false when metadata is undefined', () => {
    expect(isRevisit(makeConsultation())).toBe(false);
  });

  it('should return false when consultation is null', () => {
    expect(isRevisit(null)).toBe(false);
  });

  it('should return false when metadata has empty parentConsultationId', () => {
    const consultation = makeConsultation({
      metadata: { parentConsultationId: '' },
    });
    expect(isRevisit(consultation)).toBe(false);
  });

  it('should return true even if metadata has other fields alongside parentConsultationId', () => {
    const consultation = makeConsultation({
      metadata: { parentConsultationId: 'consult-parent', room: '5B' },
    });
    expect(isRevisit(consultation)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-932 — the summary language on `session.open()`
// ─────────────────────────────────────────────────────────────────────────────

describe('TASK-932 — OpenSessionInput.language', () => {
  it('is accepted alongside every other open field and is forwarded verbatim', () => {
    // The whole input object is POSTed as the body (`openSessionOperation`), so "the type accepts
    // it" IS the forwarding contract — there is no per-field mapping to get wrong.
    const input: OpenSessionInput = {
      patientId: 'p-1',
      appointmentDate: '2026-09-09',
      departmentId: 'dept-gen',
      workflowDefinitionSlug: 'arcaai-gen-consultation',
      language: 'ml',
      metadata: { source: 'playground' },
    };
    expect(input.language).toBe('ml');
  });

  it('is OPTIONAL — omitting it is undeclared, which is not English', () => {
    const input: OpenSessionInput = { patientId: 'p-1' };
    expect(input.language).toBeUndefined();
  });

  it('is a different axis from the STT language mode: neither type mentions the other', () => {
    // A regional tag is a legal value; the STT channel is reached through
    // `audio.start({ languageMode })` and never through this field.
    const input: OpenSessionInput = { patientId: 'p-1', language: 'en-IN' };
    expect(input.language).toBe('en-IN');
    expect(Object.keys(input)).not.toContain('languageMode');
  });

  it('is readable back off the consultation the open returns', () => {
    const consultation: Consultation = {
      id: 'c-1',
      patientId: 'p-1',
      doctorId: 'd-1',
      appointmentDate: '2026-09-09',
      language: 'ml',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    expect(consultation.language).toBe('ml');
  });
});

describe('OpenSessionInput (TASK-1020)', () => {
  it('accepts parentConsultationId, context and metadata', () => {
    const input: OpenSessionInput = {
      patientId: 'patient-123',
      parentConsultationId: 'consult-001',
      context: { encounter: { event_id: 'evt-2' } },
      metadata: { source: 'emr' },
    };
    expect(input.parentConsultationId).toBe('consult-001');
    expect(input.context).toEqual({ encounter: { event_id: 'evt-2' } });
  });
});
