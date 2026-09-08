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
  /**
   * TASK-891 — the selector of the row that actually matched, canonical and sorted; `[]`
   * when the unqualified row won (or when the platform default applied). A caller that
   * must know whether TAG SELECTION happened — e.g. that the consultation's visit type
   * picked a more specific workflow than the tier's plain default — reads this rather
   * than re-deriving it.
   */
  selector: string[];
}

export interface IWorkflowAssignmentService {
  /**
   * `department override → tenant default → platform default`. WITHIN each of the two
   * real tiers, a row whose selector is a SUBSET of `selectorTags` is a candidate, most
   * specific first, and the unqualified row last (TASK-891, mirrors
   * `IAgentAssignmentService.resolve`'s TASK-884 selector walk) — so a caller that
   * supplies none resolves exactly what it always did. The TIER order is untouched: a
   * tenant-tier tag match still loses to a department-tier one. Falls through to the
   * platform default only when NEITHER tier has a resolvable candidate (matched or not).
   *
   * Returns the slug AND its source so the dispatcher (and the runs tab) can say WHY a
   * workflow was chosen.
   */
  resolve(tenantId: string, paletteKey: string, departmentId?: string | null, selectorTags?: readonly string[]): Promise<ResolvedWorkflowAssignment>;

  listForPalette(paletteKey: string): Promise<WorkflowAssignmentResponse[]>;
  getById(id: string): Promise<WorkflowAssignmentResponse>;
  upsert(dto: UpsertWorkflowAssignmentRequest, expectedVersion?: number): Promise<WorkflowAssignmentResponse>;
  remove(id: string, expectedVersion?: number, reason?: string | null): Promise<WorkflowAssignmentResponse>;
}

export { PipelinePolicyScope };
