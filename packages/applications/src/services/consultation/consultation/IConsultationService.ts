import { ConsultationStatus } from '@arcaai/domains';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  ConsultationWorkflowResponse,
  PaginatedConsultationResponse,
} from './dto';
import { SelectableConsultationWorkflowListResponse } from '../workflow-dispatch/dto';

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
   * which engine governs this consultation, and the identity of the
   * tenant-authored graph when one does. `NotFoundException` for an unknown or
   * cross-tenant id (404-over-403).
   */
  abstract getGoverningWorkflow(consultationId: string): Promise<ConsultationWorkflowResponse>;

  /**
   * the workflows the CLS-resolved tenant may name in
   * `OpenConsultationRequest.workflowDefinitionSlug`. Same predicate as the
   * selection gate, so the list and the gate cannot disagree. An empty set is a
   * real answer; a deployment with no dispatcher raises `ServiceUnavailable`
   * rather than reporting one.
   */
  abstract listSelectableWorkflows(): Promise<SelectableConsultationWorkflowListResponse>;

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
   * Tenant-wide (admin) listing.
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
   * Zero-filled, server-side date-range aggregation of
   * new vs. revisit consultation counts (day/month buckets). SUPER_ADMIN with
   * no working tenant aggregates cross-tenant; everyone else is pinned to their
   * CLS tenant.
   */
  abstract aggregateConsultationsForTenant(params: {
    from: string | Date;
    to: string | Date;
    granularity?: 'day' | 'month';
  }): Promise<ConsultationAggregateResponse>;

  /**
   * Check whether a doctor has any consultation with a given patient
   * within the same tenant. Used for patient-scoped access control:
   * doctors who share a patient can see each other's consultations.
   */
  abstract doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean>;

  /**
   * `OPEN → PRIMED`, the session state machine's first
   * checkpoint (the state consent enforcement hangs on).
   * Idempotent: a no-op when already `PRIMED`. `expectedVersion` is the
   * `@RequiresIfMatch()`/`@ExpectedVersion()` OCC CAS predicate; absent ⇒
   * falls back to the freshly-read row version.
   */
  abstract primeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Close a consultation. The terminal is derived from the current status
   * (`SIGNED → CLOSED_COMPLETE`, `TIMED_OUT → CLOSED_INCOMPLETE` —
   * any other predecessor is illegal (409).
   * Idempotent: a no-op when already terminal. `expectedVersion` — see
   * `primeConsultation`.
   */
  abstract closeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Reopen a consultation → `REOPENED`. Legal from `TIMED_OUT`, `SIGNED`,
   * `CLOSED_COMPLETE`, or `CLOSED_INCOMPLETE`. Idempotent: a no-op when
   * already `REOPENED`. `expectedVersion` — see `primeConsultation`.
   */
  abstract reopenConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Update safely-mutable fields of an existing consultation
   * (appointmentDate / departmentId / metadata-merge). The typed `status`
   * COLUMN is NOT settable here — see `primeConsultation`/
   * `closeConsultation`/`reopenConsultation`/`startRecording`/`stopRecording`.
   */
  abstract updateConsultation(id: string, request: UpdateConsultationRequest, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Clinical Workflow Playground (WS2) — `PRIMED → RECORDING` (;
   * the one flagged precondition in the whole matrix — see
   * `consultation.state.requirePrimedBeforeRecording`). The harness later
   * promotes a drained consult to PENDING_REVIEW once a draft note is
   * generated. The LiveDocumentationService session is started by the
   * controller around this.
   */
  abstract startRecording(id: string): Promise<ConsultationResponse>;

  /**
   * Clinical Workflow Playground (WS2) — `RECORDING → DRAINING`
   * when recording stops (the harness later promotes it to
   * DRAFT_PENDING_SENSORS/PENDING_REVIEW via `persistDraft`).
   */
  abstract stopRecording(id: string): Promise<ConsultationResponse>;
}

export const IConsultationServiceToken = Symbol('IConsultationService');
