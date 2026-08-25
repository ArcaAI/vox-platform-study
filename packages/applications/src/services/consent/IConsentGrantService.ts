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
}
export const IConsentGrantService = Symbol('IConsentGrantService');
