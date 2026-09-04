/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * TASK-863 — append-only WORM record of ONE agent-assignment edit (the
 * `WorkflowAssignmentChange` shape). The table has no `_version` / `_metadata`
 * / `updatedAt` / `resourceStatus` columns and a BEFORE UPDATE OR DELETE trigger
 * refuses every mutation, so the entity exposes read-only accessors and its
 * mapper strips the inherited base columns.
 */
export interface IAgentAssignmentChangeEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  task: Enums.AgentTask;
  changedBy?: string | null;
  assignmentVersion?: number | null;
  /** Null when this change CREATED the assignment. */
  beforeSlug?: string | null;
  /** Null when this change REMOVED the assignment. */
  afterSlug?: string | null;
  reason?: string | null;
}

export class AgentAssignmentChangeEntity extends BaseTenantEntity {
  private _scope: IAgentAssignmentChangeEntity['scope'];
  private _scopeId?: IAgentAssignmentChangeEntity['scopeId'];
  private _task: IAgentAssignmentChangeEntity['task'];
  private _changedBy?: IAgentAssignmentChangeEntity['changedBy'];
  private _assignmentVersion?: IAgentAssignmentChangeEntity['assignmentVersion'];
  private _beforeSlug?: IAgentAssignmentChangeEntity['beforeSlug'];
  private _afterSlug?: IAgentAssignmentChangeEntity['afterSlug'];
  private _reason?: IAgentAssignmentChangeEntity['reason'];

  constructor(init: IAgentAssignmentChangeEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._task = init.task;
    this._changedBy = init.changedBy;
    this._assignmentVersion = init.assignmentVersion;
    this._beforeSlug = init.beforeSlug;
    this._afterSlug = init.afterSlug;
    this._reason = init.reason;
  }

  get scope(): IAgentAssignmentChangeEntity['scope'] {
    return this._scope;
  }

  get scopeId(): IAgentAssignmentChangeEntity['scopeId'] {
    return this._scopeId;
  }

  get task(): IAgentAssignmentChangeEntity['task'] {
    return this._task;
  }

  get changedBy(): IAgentAssignmentChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get assignmentVersion(): IAgentAssignmentChangeEntity['assignmentVersion'] {
    return this._assignmentVersion;
  }

  get beforeSlug(): IAgentAssignmentChangeEntity['beforeSlug'] {
    return this._beforeSlug;
  }

  get afterSlug(): IAgentAssignmentChangeEntity['afterSlug'] {
    return this._afterSlug;
  }

  get reason(): IAgentAssignmentChangeEntity['reason'] {
    return this._reason;
  }
}
