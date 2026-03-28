import { OpenConsultationRequest, ConsultationResponse, PaginatedConsultationResponse } from './dto';

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
   * Check whether a doctor has any consultation with a given patient
   * within the same tenant. Used for patient-scoped access control:
   * doctors who share a patient can see each other's consultations.
   */
  abstract doctorHasPatientRelationship(doctorId: string, patientId: string, tenantId: string): Promise<boolean>;
}

export const IConsultationServiceToken = Symbol('IConsultationService');
