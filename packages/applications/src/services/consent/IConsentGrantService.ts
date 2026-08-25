import {
  CreateConsentGrantRequest,
  ListConsentGrantsQuery,
  PaginatedConsentGrantResponse,
  RevokeConsentGrantRequest,
  ConsentGrantResponse,
} from './dto';
import { IBaseService } from '../../interfaces';

export interface IConsentGrantService extends IBaseService {
  create(request: CreateConsentGrantRequest): Promise<ConsentGrantResponse>;
  revoke(id: string, request: RevokeConsentGrantRequest): Promise<ConsentGrantResponse>;
  /** Tenant-scoped consent register — paginated, optional patient/purpose/lifecycle filters (TASK-805). */
  list(query: ListConsentGrantsQuery): Promise<PaginatedConsentGrantResponse>;
  /**
   * Grant every purpose for a patient, attributed to the CLS request user —
   * the consent a doctor gives by opening a consultation (owner directive,
   * 2026-08-25). Idempotent; returns only the rows it actually created.
   */
  ensureConsultationConsent(externalPatientId: string): Promise<ConsentGrantResponse[]>;
}
export const IConsentGrantService = Symbol('IConsentGrantService');
