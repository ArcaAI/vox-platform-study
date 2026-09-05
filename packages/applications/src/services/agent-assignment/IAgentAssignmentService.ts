import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';
import { AgentAssignmentResponse, UpsertAgentAssignmentRequest } from './dto';

export const IAgentAssignmentService = Symbol('IAgentAssignmentService');

/** Which tier supplied the resolved slug. `platform-default` = the SYSTEM tenant's row (or nothing). */
export type AgentAssignmentSource = 'department' | 'tenant' | 'platform-default';

export interface ResolvedAgentAssignment {
  /** `null` ⇒ no tier assigned a resolvable agent for this task. */
  agentSlug: string | null;
  source: AgentAssignmentSource;
  /**
   * TASK-884 — the selector of the row that actually matched, canonical and sorted; `[]` when
   * the unqualified row won. A caller that must know whether TAG SELECTION happened (rather
   * than the tier's ordinary default) reads this rather than re-deriving it.
   */
  selector: string[];
}

export interface IAgentAssignmentService {
  /**
   * `department override → tenant default → SYSTEM platform default` — the first tier whose
   * slug resolves to an ACTIVE PUBLISHED agent of `task` wins (a stale reference is skipped
   * with a warning, never served silently).
   *
   * TASK-884: `selectorTags` are the request's `key:value` tags. WITHIN a tier, a row whose
   * selector is a SUBSET of them is a candidate, most specific first, and the unqualified row
   * last — so a caller that supplies none resolves exactly what it always did. The TIER order
   * is untouched: a tenant-tier tag match still loses to a department-tier one, because the
   * cascade is about WHOSE opinion applies, and the selector is about WHICH of that tier's
   * opinions applies.
   */
  resolve(tenantId: string, task: AgentTask, departmentId?: string | null, selectorTags?: readonly string[]): Promise<ResolvedAgentAssignment>;

  list(task?: AgentTask): Promise<AgentAssignmentResponse[]>;
  getById(id: string): Promise<AgentAssignmentResponse>;
  upsert(dto: UpsertAgentAssignmentRequest, expectedVersion?: number): Promise<AgentAssignmentResponse>;
  remove(id: string, expectedVersion?: number, reason?: string | null): Promise<AgentAssignmentResponse>;
}

export { AgentTask, PipelinePolicyScope };
