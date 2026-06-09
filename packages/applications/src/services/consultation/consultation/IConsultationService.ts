import { ConsultationStatus } from '@arcaai/domains';
import { OpenConsultationRequest, UpdateConsultationRequest, ConsultationResponse, PaginatedConsultationResponse } from './dto';

/**
 * Consultation Service Interface
 *
 * Simplified workflow using natural key (patientId, doctorId, appointmentDate)
 */
export abstract class IConsultationService {
  /**
   * Get or create consultation for (patientId, doctorId, appointmentDate)
   * If exists: returns existing consultation
   * If not: creates new consultation
   */
  abstract getOrCreate(request: OpenConsultationRequest, doctorId: string): Promise<ConsultationResponse>;

  /**
   * Create a re-visit/follow-up consultation
   */
  abstract createRevisit(request: OpenConsultationRequest, doctorId: string, parentConsultationId: string): Promise<ConsultationResponse>;

  /**
   * Get consultation by ID with context
   */
  abstract getById(id: string): Promise<ConsultationResponse | null>;

  /**
   * Get consultation by ID with all relations (Doctor, Department, Context)
   */
  abstract getByIdWithRelations(id: string): Promise<ConsultationResponse | null>;

  /**
   * Get all consultations for a patient (across all dates and doctors)
   */
  abstract getPatientHistory(patientId: string): Promise<ConsultationResponse[]>;

  /**
   * Get all consultations for a patient on a specific date (all doctors)
   */
  abstract getByPatientAndDate(patientId: string, date: string): Promise<ConsultationResponse[]>;

  /**
   * Get consultation chain (parent + all children)
   */
  abstract getConsultationChain(consultationId: string): Promise<ConsultationResponse[]>;

  /**
   * Get paginated consultation history for a patient.
   * Returns a page of consultations with total count.
   */
  abstract getPatientHistoryPaginated(patientId: string, page: number, limit: number): Promise<PaginatedConsultationResponse>;

  /**
   * Get paginated consultations for a patient on a specific date.
   * Returns a page of consultations with total count.
   */
  abstract getByPatientAndDatePaginated(patientId: string, date: string, page: number, limit: number): Promise<PaginatedConsultationResponse>;

  /**
   * List all consultations (paginated) with optional filters.
   */
  abstract listConsultations(params: {
    page: number;
    pageSize: number;
    doctorId?: string;
    patientId?: string;
  }): Promise<PaginatedConsultationResponse>;

  /**
   * TASK-319 F1 — tenant-wide (admin) listing.
   * Lists EVERY consultation in the caller's tenant with no owner/shared-patient
   * scoping. Intended for the admin surface gated by `@CanManage('Consultation')`.
   */
  abstract listConsultationsForTenant(params: {
    page: number;
    pageSize: number;
    patientId?: string;
    doctorId?: string;
    departmentId?: string;
    status?: ConsultationStatus;
  }): Promise<PaginatedConsultationResponse>;

  /**
   * Check whether a doctor has any consultation with a given patient
   * within the same tenant. Used for patient-scoped access control:
   * doctors who share a patient can see each other's consultations.
   */
  abstract doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean>;

  /**
   * TASK-322 — Close a consultation (transition lifecycle status to CLOSED).
   * Idempotent: a no-op (no write, no event) when already CLOSED.
   */
  abstract closeConsultation(id: string): Promise<ConsultationResponse>;

  /**
   * TASK-322 — Reopen a consultation (transition lifecycle status back to OPEN).
   * Idempotent: a no-op (no write, no event) when already OPEN.
   */
  abstract reopenConsultation(id: string): Promise<ConsultationResponse>;

  /**
   * TASK-322 — Update safely-mutable fields of an existing consultation
   * (appointmentDate / departmentId / metadata-merge / status).
   */
  abstract updateConsultation(id: string, request: UpdateConsultationRequest): Promise<ConsultationResponse>;

  /**
   * Clinical Workflow Playground (WS2) — flip the typed `status` COLUMN to
   * RECORDING. No auto-transition exists today; the harness later promotes a
   * recorded consult to PENDING_REVIEW once a draft note is generated. The
   * LiveDocumentationService session is started by the controller around this.
   */
  abstract startRecording(id: string): Promise<ConsultationResponse>;

  /**
   * Clinical Workflow Playground (WS2) — revert the `status` COLUMN to OPEN
   * when recording stops (the harness later promotes it to PENDING_REVIEW).
   */
  abstract stopRecording(id: string): Promise<ConsultationResponse>;
}

export const IConsultationServiceToken = Symbol('IConsultationService');
