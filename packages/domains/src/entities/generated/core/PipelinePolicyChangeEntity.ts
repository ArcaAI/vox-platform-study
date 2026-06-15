/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Append-only WORM record of a single realtime-pipeline-policy edit (TASK-356
 * Phase 5). Mirrors `HarnessPolicyChange`.
 *
 * Immutable by design: the backing table has NO `_version` / `_metadata` /
 * `updatedAt` / `resourceStatus` columns and the migration REVOKEs UPDATE/DELETE
 * from the application role. The inherited base audit fields are stripped in
 * `PipelinePolicyChangeEntityMapper.toPersistence` so they are never written.
 * `scope`/`scopeId` record which cascade tier was edited; `beforeJson` is null
 * when the change CREATED the policy row.
 */
export interface IPipelinePolicyChangeEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  changedBy?: string | null;
  policyVersion?: number | null;
  beforeJson?: JsonValue | null;
  afterJson: JsonValue;
  reason?: string | null;
}

export class PipelinePolicyChangeEntity extends BaseTenantEntity {
  private _scope: IPipelinePolicyChangeEntity['scope'];
  private _scopeId?: IPipelinePolicyChangeEntity['scopeId'];
  private _changedBy?: IPipelinePolicyChangeEntity['changedBy'];
  private _policyVersion?: IPipelinePolicyChangeEntity['policyVersion'];
  private _beforeJson?: IPipelinePolicyChangeEntity['beforeJson'];
  private _afterJson: IPipelinePolicyChangeEntity['afterJson'];
  private _reason?: IPipelinePolicyChangeEntity['reason'];

  constructor(init: IPipelinePolicyChangeEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._changedBy = init.changedBy;
    this._policyVersion = init.policyVersion;
    this._beforeJson = init.beforeJson;
    this._afterJson = init.afterJson;
    this._reason = init.reason;
  }

  // Read-only accessors — the record is immutable once created (WORM). No
  // setters are exposed: an "update" to a change record is a new appended row.

  get scope(): IPipelinePolicyChangeEntity['scope'] {
    return this._scope;
  }

  get scopeId(): IPipelinePolicyChangeEntity['scopeId'] {
    return this._scopeId;
  }

  get changedBy(): IPipelinePolicyChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get policyVersion(): IPipelinePolicyChangeEntity['policyVersion'] {
    return this._policyVersion;
  }

  get beforeJson(): IPipelinePolicyChangeEntity['beforeJson'] {
    return this._beforeJson;
  }

  get afterJson(): IPipelinePolicyChangeEntity['afterJson'] {
    return this._afterJson;
  }

  get reason(): IPipelinePolicyChangeEntity['reason'] {
    return this._reason;
  }

  public override validate(): void {
    super.validate();
    if (this._afterJson === undefined || this._afterJson === null) {
      throw new BusinessException('PipelinePolicyChange afterJson is required.');
    }
  }
}
