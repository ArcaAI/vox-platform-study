import { ConsultationProcessing, ConsultationStatus } from '@arcaai/domains';
import type { ClinicalCaller } from '../summary/clinician-attribution';
import {
  OpenConsultationRequest,
  UpdateConsultationRequest,
  ConsultationResponse,
  ConsultationAggregateResponse,
  ConsultationWorkflowResponse,
  PaginatedConsultationResponse,
  ConsultationSort,
} from './dto';
import { SelectableConsultationWorkflowListResponse } from '../workflow-dispatch/dto';

/** What `startRecording` is told about the capture it is starting; passed to `IConsultationLifecycleService.start`. */
export interface StartRecordingOptions {
  /** The STT streaming session the recording binds to (`StartRecordingRequest.sessionId`). */
  sttSessionId?: string;
  /**
   * Supersede, by the DURABLE binding, any older STT session of this consultation that is still
   * live. Set by a caller that holds no in-process binding to replace.
   */
  supersedeByDurableBinding?: boolean;
}

/**
 * Consultation Service Interface
 *
 * A consultation is an episode of one patient with one clinician (and department), made of
 * encounters (visits).
 */
export abstract class IConsultationService {
  /**
   * Get or create the consultation for one ENCOUNTER — the only entry. An `externalRef` selects
   * the encounter carrying it (closed or not; another patient's ref is 409
   * `EXTERNAL_REF_CONFLICT`); otherwise the non-closed consultation of (doctor, patient,
   * department) is returned, with an encounter appended for a new ref or an ended-encounter
   * revisit (409 `ENCOUNTER_CAPTURE_ACTIVE` / `CONSULTATION_APPROVED` when it cannot take one);
   * otherwise a new consultation is created, chained to the latest closed one of the key. The
   * response says whether an encounter was appended (`encounterAppended`).
   */
  abstract getOrCreate(request: OpenConsultationRequest, doctorId: string): Promise<ConsultationResponse>;

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
    /** Optional processing-axis filter (e.g. AWAITING_REVIEW = needs a human because of gaps or an escalation, FAILED). A written note is IDLE + processingReason NOTE_READY. */
    processing?: ConsultationProcessing;
    /** Pre-validated by the controller (`parseConsultationSort`); absent → `DEFAULT_CONSULTATION_SORT`. */
    sort?: ConsultationSort;
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
   * Deprecated: there is no PRIMED state any more. A no-op that answers the consultation as it is.
   */
  abstract primeConsultation(id: string, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Close a consultation — delegates to `IConsultationLifecycleService.close` (CLOSED_COMPLETE
   * when APPROVED, else CLOSED_INCOMPLETE; idempotent on a closed row). `clinicianUserId` / `caller`
   * attribute the close the same way the sign-off is attributed.
   */
  abstract closeConsultation(
    id: string,
    expectedVersion?: number,
    options?: { clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<ConsultationResponse>;

  /**
   * Reopen a consultation — delegates to `IConsultationLifecycleService.reopen`. Without
   * `expectedVersion` the CAS runs on the version just read.
   */
  abstract reopenConsultation(id: string, expectedVersion?: number, options?: { reason?: string }): Promise<ConsultationResponse>;

  /**
   * Update safely-mutable fields of an existing consultation
   * (appointmentDate / departmentId / metadata-merge). The typed `status`
   * COLUMN is NOT settable here — the lifecycle commands own it.
   */
  abstract updateConsultation(id: string, request: UpdateConsultationRequest, expectedVersion?: number): Promise<ConsultationResponse>;

  /**
   * Deprecated alias of `POST :id/start` — delegates to `IConsultationLifecycleService.start`
   * and answers with the consultation.
   */
  abstract startRecording(id: string, options?: StartRecordingOptions): Promise<ConsultationResponse>;

  /**
   * Deprecated alias of `POST :id/stop` — delegates to `IConsultationLifecycleService.stop`
   * without waiting for the final transcript, and answers with the consultation.
   */
  abstract stopRecording(id: string): Promise<ConsultationResponse>;
}

export const IConsultationServiceToken = Symbol('IConsultationService');
