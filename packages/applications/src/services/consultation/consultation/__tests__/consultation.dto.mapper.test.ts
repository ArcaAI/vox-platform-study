/**
 * ConsultationDtoMapper Unit Tests
 *
 * Tests for the ConsultationDtoMapper that transforms entities to response DTOs.
 */

import { describe, it, expect } from 'vitest';
import { ConsultationDtoMapper } from '../consultation.dto.mapper';

// Helper to create mock consultation entity
const createMockConsultationEntity = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    patientId: string;
    doctorId: string;
    appointmentDate: Date;
    departmentId: string | null;
    parentConsultationId: string | null;
    status: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
    Doctor: any;
    Department: any;
    ContextItems: any[];
  }> = {},
) => ({
  id: 'id' in overrides ? overrides.id : 'consultation-id-1',
  tenantId: 'tenantId' in overrides ? overrides.tenantId : 'tenant-1',
  patientId: 'patientId' in overrides ? overrides.patientId : 'patient-1',
  doctorId: 'doctorId' in overrides ? overrides.doctorId : 'doctor-1',
  appointmentDate: 'appointmentDate' in overrides ? overrides.appointmentDate : new Date('2026-01-29'),
  departmentId: 'departmentId' in overrides ? overrides.departmentId : null,
  parentConsultationId: 'parentConsultationId' in overrides ? overrides.parentConsultationId : null,
  status: 'status' in overrides ? overrides.status : undefined,
  metadata: 'metadata' in overrides ? overrides.metadata : null,
  createdAt: 'createdAt' in overrides ? overrides.createdAt : new Date('2026-01-29T10:00:00Z'),
  updatedAt: 'updatedAt' in overrides ? overrides.updatedAt : new Date('2026-01-29T10:30:00Z'),
  Doctor: 'Doctor' in overrides ? overrides.Doctor : undefined,
  Department: 'Department' in overrides ? overrides.Department : undefined,
  ContextItems: 'ContextItems' in overrides ? overrides.ContextItems : [],
});

// Helper to create mock context item entity
const createMockContextItemEntity = (
  overrides: Partial<{
    id: string;
    consultationId: string;
    type: string;
    content: string | null;
    mediaId: string | null;
    structuredData: Record<string, unknown> | null;
    source: string;
    currentVersionNumber: number;
    qdrantSynced: boolean;
    qdrantSyncedAt: Date | null;
    isSummary: boolean;
    isFinalSummary: boolean;
    isPreSummary: boolean;
    isTranscript: boolean;
    isAiGenerated: boolean;
    isMediaType: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> = {},
) => ({
  id: overrides.id ?? 'context-item-id-1',
  consultationId: overrides.consultationId ?? 'consultation-id-1',
  type: overrides.type ?? 'transcription',
  content: overrides.content ?? 'Test content',
  mediaId: overrides.mediaId ?? null,
  structuredData: overrides.structuredData ?? null,
  source: overrides.source ?? 'user',
  currentVersionNumber: overrides.currentVersionNumber ?? 1,
  qdrantSynced: overrides.qdrantSynced ?? false,
  qdrantSyncedAt: overrides.qdrantSyncedAt ?? null,
  isSummary: overrides.isSummary ?? false,
  isFinalSummary: overrides.isFinalSummary ?? false,
  isPreSummary: overrides.isPreSummary ?? false,
  isTranscript: overrides.isTranscript ?? true,
  isAiGenerated: overrides.isAiGenerated ?? false,
  isMediaType: overrides.isMediaType ?? false,
  createdAt: overrides.createdAt ?? new Date('2026-01-29T10:00:00Z'),
  updatedAt: overrides.updatedAt ?? new Date('2026-01-29T10:00:00Z'),
});

describe('ConsultationDtoMapper', () => {
  describe('toResponse', () => {
    it('should map basic consultation entity to response', () => {
      const entity = createMockConsultationEntity();

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.id).toBe('consultation-id-1');
      expect(result.patientId).toBe('patient-1');
      expect(result.doctorId).toBe('doctor-1');
      expect(result.appointmentDate).toBe('2026-01-29');
      expect(result.createdAt).toBe('2026-01-29T10:00:00.000Z');
      expect(result.updatedAt).toBe('2026-01-29T10:30:00.000Z');
      expect(result.isNew).toBe(false);
    });

    it('should set isNew to true when specified', () => {
      const entity = createMockConsultationEntity();

      const result = ConsultationDtoMapper.toResponse(entity as any, true);

      expect(result.isNew).toBe(true);
    });

    it('should map departmentId when present', () => {
      const entity = createMockConsultationEntity({ departmentId: 'dept-1' });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.departmentId).toBe('dept-1');
    });

    it('should return undefined for departmentId when null', () => {
      const entity = createMockConsultationEntity({ departmentId: null });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.departmentId).toBeUndefined();
    });

    it('should map parentConsultationId when present', () => {
      const entity = createMockConsultationEntity({
        parentConsultationId: 'parent-consultation-id',
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.parentConsultationId).toBe('parent-consultation-id');
    });

    it('should return undefined for parentConsultationId when null', () => {
      const entity = createMockConsultationEntity({ parentConsultationId: null });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.parentConsultationId).toBeUndefined();
    });

    it('should map metadata when present', () => {
      const metadata = { visitType: 'follow-up', priority: 'high' };
      const entity = createMockConsultationEntity({ metadata });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.metadata).toEqual(metadata);
    });

    it('should return null for metadata when null', () => {
      const entity = createMockConsultationEntity({ metadata: null });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      // Note: metadata is cast as-is without ?? undefined, so null passes through
      expect(result.metadata).toBeNull();
    });

    it('should map Doctor when present', () => {
      const entity = createMockConsultationEntity({
        Doctor: {
          id: 'doctor-1',
          username: 'dr.smith',
          UserProfile: {
            firstName: 'John',
            lastName: 'Smith',
          },
        },
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.doctor).toBeDefined();
      expect(result.doctor?.id).toBe('doctor-1');
      expect(result.doctor?.username).toBe('dr.smith');
      expect(result.doctor?.firstName).toBe('John');
      expect(result.doctor?.lastName).toBe('Smith');
    });

    it('should return undefined for doctor when not present', () => {
      const entity = createMockConsultationEntity({ Doctor: undefined });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.doctor).toBeUndefined();
    });

    it('should handle Doctor without UserProfile', () => {
      const entity = createMockConsultationEntity({
        Doctor: {
          id: 'doctor-1',
          username: 'dr.smith',
        },
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.doctor).toBeDefined();
      expect(result.doctor?.id).toBe('doctor-1');
      expect(result.doctor?.username).toBe('dr.smith');
      expect(result.doctor?.firstName).toBeUndefined();
      expect(result.doctor?.lastName).toBeUndefined();
    });

    it('should map Department when present', () => {
      const entity = createMockConsultationEntity({
        Department: {
          id: 'dept-1',
          code: 'CARDIO',
          name: 'Cardiology',
        },
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.department).toBeDefined();
      expect(result.department?.id).toBe('dept-1');
      expect(result.department?.code).toBe('CARDIO');
      expect(result.department?.name).toBe('Cardiology');
    });

    it('should return undefined for department when not present', () => {
      const entity = createMockConsultationEntity({ Department: undefined });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.department).toBeUndefined();
    });

    it('should handle Department with null code and name', () => {
      const entity = createMockConsultationEntity({
        Department: {
          id: 'dept-1',
          code: null,
          name: null,
        },
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.department).toBeDefined();
      expect(result.department?.id).toBe('dept-1');
      expect(result.department?.code).toBeUndefined();
      expect(result.department?.name).toBeUndefined();
    });

    it('should format appointmentDate as YYYY-MM-DD', () => {
      const entity = createMockConsultationEntity({
        appointmentDate: new Date('2026-12-25T15:30:00Z'),
      });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.appointmentDate).toBe('2026-12-25');
    });

    // `Consultation.status` is now the SOLE lifecycle tracker
    // (`metadata.status` deleted; the mapper's former column-vs-metadata
    // precedence dance is gone with it). The mapper does a bare pass-through
    // of `entity.status` — every legality/idempotency/forgery-containment
    // concern now lives in `ConsultationEntity.transitionTo`
    // (packages/domains) and the service layer's `applyTransition`, not here.
    it('passes the typed status column straight through, whatever its value', () => {
      for (const status of ['OPEN', 'PRIMED', 'RECORDING', 'DRAINING', 'PENDING_REVIEW', 'SIGNED', 'TIMED_OUT', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE', 'REOPENED']) {
        const entity = createMockConsultationEntity({ status, metadata: null });

        const result = ConsultationDtoMapper.toResponse(entity as any);

        expect(result.status).toBe(status);
      }
    });

    it('ignores metadata.status entirely — it is no longer consulted', () => {
      // A stray `metadata.status` key (dead code elsewhere, a dirty row, or a
      // forged value) must never leak into the response now that the mapper
      // reads only the typed column.
      const entity = createMockConsultationEntity({ status: 'PENDING_REVIEW', metadata: { status: 'SIGNED' } });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.status).toBe('PENDING_REVIEW');
    });

    it('surfaces whatever the column literally holds, including undefined on a bare mock', () => {
      // The mock helper (unlike the real ConsultationEntity constructor,
      // which always defaults `status` to OPEN) leaves `status` undefined
      // when not overridden — this documents that the mapper does no
      // defaulting of its own; defaulting is the entity's job.
      const entity = createMockConsultationEntity({ metadata: null });

      const result = ConsultationDtoMapper.toResponse(entity as any);

      expect(result.status).toBeUndefined();
    });
  });

  describe('toResponseWithContext', () => {
    it('should include contextItems when present', () => {
      const entity = createMockConsultationEntity({
        ContextItems: [
          createMockContextItemEntity({ id: 'context-1', type: 'transcription' }),
          createMockContextItemEntity({ id: 'context-2', type: 'case_note' }),
        ],
      });

      const result = ConsultationDtoMapper.toResponseWithContext(entity as any);

      expect(result.contextItems).toBeDefined();
      expect(result.contextItems).toHaveLength(2);
      expect(result.contextItems?.[0].id).toBe('context-1');
      expect(result.contextItems?.[1].id).toBe('context-2');
    });

    it('should not include contextItems when empty', () => {
      const entity = createMockConsultationEntity({ ContextItems: [] });

      const result = ConsultationDtoMapper.toResponseWithContext(entity as any);

      expect(result.contextItems).toBeUndefined();
    });

    it('should not include contextItems when undefined', () => {
      const entity = createMockConsultationEntity();
      delete (entity as any).ContextItems;

      const result = ConsultationDtoMapper.toResponseWithContext(entity as any);

      expect(result.contextItems).toBeUndefined();
    });

    it('should include all base response fields with context', () => {
      const entity = createMockConsultationEntity({
        Doctor: {
          id: 'doctor-1',
          username: 'dr.smith',
          UserProfile: { firstName: 'John', lastName: 'Smith' },
        },
        Department: {
          id: 'dept-1',
          code: 'CARDIO',
          name: 'Cardiology',
        },
        ContextItems: [createMockContextItemEntity()],
      });

      const result = ConsultationDtoMapper.toResponseWithContext(entity as any);

      expect(result.id).toBe('consultation-id-1');
      expect(result.doctor).toBeDefined();
      expect(result.department).toBeDefined();
      expect(result.contextItems).toHaveLength(1);
    });

    it('should set isNew flag correctly with context', () => {
      const entity = createMockConsultationEntity({
        ContextItems: [createMockContextItemEntity()],
      });

      const resultNew = ConsultationDtoMapper.toResponseWithContext(entity as any, true);
      const resultExisting = ConsultationDtoMapper.toResponseWithContext(entity as any, false);

      expect(resultNew.isNew).toBe(true);
      expect(resultExisting.isNew).toBe(false);
    });

    it('should map context items with all fields', () => {
      const contextItem = createMockContextItemEntity({
        id: 'context-1',
        type: 'transcription',
        content: 'Test transcription',
        source: 'user',
        currentVersionNumber: 2,
        qdrantSynced: true,
        qdrantSyncedAt: new Date('2026-01-29T11:00:00Z'),
        isSummary: false,
        isFinalSummary: false,
        isPreSummary: false,
        isTranscript: true,
        isAiGenerated: false,
        isMediaType: false,
      });
      const entity = createMockConsultationEntity({
        ContextItems: [contextItem],
      });

      const result = ConsultationDtoMapper.toResponseWithContext(entity as any);

      expect(result.contextItems).toHaveLength(1);
      const mappedContext = result.contextItems?.[0];
      expect(mappedContext?.id).toBe('context-1');
      expect(mappedContext?.type).toBe('transcription');
      expect(mappedContext?.content).toBe('Test transcription');
      expect(mappedContext?.currentVersionNumber).toBe(2);
      expect(mappedContext?.qdrantSynced).toBe(true);
      expect(mappedContext?.isTranscript).toBe(true);
    });
  });
});
