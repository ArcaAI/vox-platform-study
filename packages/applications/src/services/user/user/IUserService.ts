import { EntityId, UserEntity } from '@arcaai/domains';
import { FetchResponse, PaginatedQuery } from '../../../common';
import { IBaseService } from '../../../interfaces';
import { CreateUserRequest, CreateOAuthUserRequest, UpdateUserRequest } from './dto';

/**
 * TASK-398 (P1-7) — per-user export enrichment read-model: the profile email +
 * active department NAMES that `UserResponse` deliberately does not carry.
 * Export-path only; the regular list DTO is unchanged.
 */
export interface UserExportEnrichment {
  /** Profile email, or '' when the user has no profile / no email. */
  email: string;
  /** Active department names (primary first, then assignment age). */
  departmentNames: string[];
}

export interface IUserService extends IBaseService {
  create(request: CreateUserRequest): Promise<UserEntity>;
  createExternalUser(request: CreateOAuthUserRequest): Promise<UserEntity>;
  fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserEntity>>;
  fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserEntity>>;
  fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserEntity>>;
  fetchById(id: EntityId): Promise<UserEntity>;
  fetchByExternalId(externalId: string): Promise<UserEntity>;
  update(id: EntityId, request: UpdateUserRequest): Promise<UserEntity>;
  deleteById(id: EntityId): Promise<UserEntity>;
  /**
   * TASK-398 (P1-7) — batch-resolve email + department names for an export set
   * with exactly TWO grouped queries (no N+1). `tenantId` (when supplied)
   * confines department names to that tenant, mirroring the export's row
   * scoping. Every requested id resolves (missing data degrades to ''/[]).
   */
  getExportEnrichment(userIds: string[], tenantId?: string): Promise<Record<string, UserExportEnrichment>>;
}
export const IUserService = Symbol('IUserService');
