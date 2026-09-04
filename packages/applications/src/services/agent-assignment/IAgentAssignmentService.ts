import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { AgentAssignmentResponse, UpsertAgentAssignmentRequest } from './dto';

export const IAgentAssignmentService = Symbol('IAgentAssignmentService');

/** Which tier supplied the resolved slug. `platform-default` = the SYSTEM tenant's row (or nothing). */
export type AgentAssignmentSource = 'department' | 'tenant' | 'platform-default';

export interface ResolvedAgentAssignment {
  /** `null` ⇒ no tier assigned a resolvable agent for this task. */
  agentSlug: string | null;
  source: AgentAssignmentSource;
}

export interface IAgentAssignmentService {
  /**
   * `department override → tenant default → SYSTEM platform default` — the first tier whose
   * slug resolves to an ACTIVE PUBLISHED agent of `task` wins (a stale reference is skipped
   * with a warning, never served silently).
   */
  resolve(tenantId: string, task: AgentTask, departmentId?: string | null): Promise<ResolvedAgentAssignment>;

  list(task?: AgentTask): Promise<AgentAssignmentResponse[]>;
  getById(id: string): Promise<AgentAssignmentResponse>;
  upsert(dto: UpsertAgentAssignmentRequest, expectedVersion?: number): Promise<AgentAssignmentResponse>;
  remove(id: string, expectedVersion?: number, reason?: string | null): Promise<AgentAssignmentResponse>;
}

export { AgentTask, PipelinePolicyScope };
