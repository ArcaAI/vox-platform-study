import { PipelinePolicyScope } from '@arcaai/domains';
import { UpsertWorkflowAssignmentRequest, WorkflowAssignmentResponse } from './dto';

export const IWorkflowAssignmentService = Symbol('IWorkflowAssignmentService');

/** Which tier supplied the resolved slug. `platform-default` means NO tier had an
 *  opinion — the dispatcher keeps its own platform-default resolution. */
export type WorkflowAssignmentSource = 'department' | 'tenant' | 'platform-default';

export interface ResolvedWorkflowAssignment {
  /** `null` ⇒ no tier assigned anything resolvable; the caller uses the platform default. */
  workflowDefinitionSlug: string | null;
  source: WorkflowAssignmentSource;
}

export interface IWorkflowAssignmentService {
  /**
   * `department override → tenant default → platform default`, walked with the
   * shared `walkCascade` primitive. Returns the slug AND its source so the
   * dispatcher (and the runs tab) can say WHY a workflow was chosen.
   */
  resolve(tenantId: string, paletteKey: string, departmentId?: string | null): Promise<ResolvedWorkflowAssignment>;

  listForPalette(paletteKey: string): Promise<WorkflowAssignmentResponse[]>;
  getById(id: string): Promise<WorkflowAssignmentResponse>;
  upsert(dto: UpsertWorkflowAssignmentRequest, expectedVersion?: number): Promise<WorkflowAssignmentResponse>;
  remove(id: string, expectedVersion?: number, reason?: string | null): Promise<WorkflowAssignmentResponse>;
}

export { PipelinePolicyScope };
