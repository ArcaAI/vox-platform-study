/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * Append-only WORM record of ONE workflow-assignment edit (TASK-733).
 * Mirrors `PipelinePolicyChange`: the backing table has no `_version` /
 * `_metadata` / `updatedAt` / `resourceStatus` columns and the migration
 * REVOKEs UPDATE/DELETE from the application role, so the entity exposes
 * read-only accessors and its mapper strips the inherited base columns.
 *
 * Unlike `PipelinePolicyChange` the payload is NOT encrypted: a workflow slug
 * is a configuration identifier, never PHI, so there is nothing here for
 * Vault-Transit to protect.
 */
export interface IWorkflowAssignmentChangeEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  paletteKey: string;
  changedBy?: string | null;
  assignmentVersion?: number | null;
  /** Null when this change CREATED the assignment. */
  beforeSlug?: string | null;
  /** Null when this change REMOVED the assignment. */
  afterSlug?: string | null;
  reason?: string | null;
}

export class WorkflowAssignmentChangeEntity extends BaseTenantEntity {
  private _scope: IWorkflowAssignmentChangeEntity['scope'];
  private _scopeId?: IWorkflowAssignmentChangeEntity['scopeId'];
  private _paletteKey: IWorkflowAssignmentChangeEntity['paletteKey'];
  private _changedBy?: IWorkflowAssignmentChangeEntity['changedBy'];
  private _assignmentVersion?: IWorkflowAssignmentChangeEntity['assignmentVersion'];
  private _beforeSlug?: IWorkflowAssignmentChangeEntity['beforeSlug'];
  private _afterSlug?: IWorkflowAssignmentChangeEntity['afterSlug'];
  private _reason?: IWorkflowAssignmentChangeEntity['reason'];

  constructor(init: IWorkflowAssignmentChangeEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._paletteKey = init.paletteKey;
    this._changedBy = init.changedBy;
    this._assignmentVersion = init.assignmentVersion;
    this._beforeSlug = init.beforeSlug;
    this._afterSlug = init.afterSlug;
    this._reason = init.reason;
  }

  // Read-only accessors — the record is immutable once created (WORM). An
  // "update" to a change record is a new appended row.

  get scope(): IWorkflowAssignmentChangeEntity['scope'] {
    return this._scope;
  }

  get scopeId(): IWorkflowAssignmentChangeEntity['scopeId'] {
    return this._scopeId;
  }

  get paletteKey(): IWorkflowAssignmentChangeEntity['paletteKey'] {
    return this._paletteKey;
  }

  get changedBy(): IWorkflowAssignmentChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get assignmentVersion(): IWorkflowAssignmentChangeEntity['assignmentVersion'] {
    return this._assignmentVersion;
  }

  get beforeSlug(): IWorkflowAssignmentChangeEntity['beforeSlug'] {
    return this._beforeSlug;
  }

  get afterSlug(): IWorkflowAssignmentChangeEntity['afterSlug'] {
    return this._afterSlug;
  }

  get reason(): IWorkflowAssignmentChangeEntity['reason'] {
    return this._reason;
  }
}
