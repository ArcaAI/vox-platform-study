/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * WHICH workflow definition governs a scope for a palette (TASK-733 half (a)).
 * `(scope, scopeId)` mirrors `PipelinePolicy` so the resolution is the SAME
 * first-set-wins `walkCascade` walk; `workflowDefinitionSlug` is a LINEAGE key
 * — the ACTIVE PUBLISHED version of that slug is resolved at dispatch time.
 * See packages/database/src/prisma/db_main/workflow-assignment.prisma.
 */
export interface IWorkflowAssignmentEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  paletteKey: string;
  workflowDefinitionSlug: string;
}

export class WorkflowAssignmentEntity extends BaseTenantEntity {
  private _scope: IWorkflowAssignmentEntity['scope'];
  private _scopeId?: IWorkflowAssignmentEntity['scopeId'];
  private _paletteKey: IWorkflowAssignmentEntity['paletteKey'];
  private _workflowDefinitionSlug: IWorkflowAssignmentEntity['workflowDefinitionSlug'];

  constructor(init: IWorkflowAssignmentEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._paletteKey = init.paletteKey;
    this._workflowDefinitionSlug = init.workflowDefinitionSlug;
  }

  get scope(): IWorkflowAssignmentEntity['scope'] {
    return this._scope;
  }

  set scope(value: IWorkflowAssignmentEntity['scope']) {
    this.setProperty('scope', value);
  }

  get scopeId(): IWorkflowAssignmentEntity['scopeId'] {
    return this._scopeId;
  }

  set scopeId(value: IWorkflowAssignmentEntity['scopeId']) {
    this.setProperty('scopeId', value);
  }

  get paletteKey(): IWorkflowAssignmentEntity['paletteKey'] {
    return this._paletteKey;
  }

  set paletteKey(value: IWorkflowAssignmentEntity['paletteKey']) {
    this.setProperty('paletteKey', value);
  }

  get workflowDefinitionSlug(): IWorkflowAssignmentEntity['workflowDefinitionSlug'] {
    return this._workflowDefinitionSlug;
  }

  set workflowDefinitionSlug(value: IWorkflowAssignmentEntity['workflowDefinitionSlug']) {
    this.setProperty('workflowDefinitionSlug', value);
  }

  /**
   * Structural invariants only — palette membership and slug resolvability are
   * cross-aggregate rules and live in the application service (rule 03).
   */
  public override validate(): void {
    super.validate();
    if (!this._paletteKey || this._paletteKey.trim().length === 0) {
      throw new BusinessException('WorkflowAssignment paletteKey is required.');
    }
    if (!this._workflowDefinitionSlug || this._workflowDefinitionSlug.trim().length === 0) {
      throw new BusinessException('WorkflowAssignment workflowDefinitionSlug is required.');
    }
    if (this._scope === Enums.PipelinePolicyScope.TENANT) {
      if (this._scopeId) {
        throw new BusinessException('A TENANT-scope WorkflowAssignment must not carry a scopeId.');
      }
    } else if (!this._scopeId) {
      throw new BusinessException(`A ${this._scope}-scope WorkflowAssignment requires a scopeId.`);
    }
  }
}
