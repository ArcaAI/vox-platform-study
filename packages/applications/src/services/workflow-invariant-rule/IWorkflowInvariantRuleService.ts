import { PaginatedQuery } from '../../common';
import {
  CreateWorkflowInvariantRuleRequest,
  PaginatedWorkflowInvariantRuleResponse,
  UpdateWorkflowInvariantRuleRequest,
  WorkflowInvariantRuleResponse,
} from './dto';

export const IWorkflowInvariantRuleService = Symbol('IWorkflowInvariantRuleService');

/**
 * `WorkflowInvariantRule` CRUD (b). See `WorkflowInvariantRuleService` for the
 * ownership rule and why it is enforced imperatively.
 */
export interface IWorkflowInvariantRuleService {
  /** The caller tenant's own rows UNION the SYSTEM platform register (a SYSTEM-shared read model). */
  list(query: PaginatedQuery): Promise<PaginatedWorkflowInvariantRuleResponse>;

  /** Own or SYSTEM row; another tenant's id throws `NotFoundException` (404-over-403). */
  getById(id: string): Promise<WorkflowInvariantRuleResponse>;

  /** Always owned by the CALLER's tenant — `tenantId` is never accepted from the body. */
  create(dto: CreateWorkflowInvariantRuleRequest): Promise<WorkflowInvariantRuleResponse>;

  /** Versioned PATCH. A SYSTEM-owned row is SUPER_ADMIN-only (403); another tenant's is 404. */
  update(id: string, dto: UpdateWorkflowInvariantRuleRequest): Promise<WorkflowInvariantRuleResponse>;

  /** Soft delete, same ownership gate as `update`. */
  deleteById(id: string): Promise<WorkflowInvariantRuleResponse>;
}
