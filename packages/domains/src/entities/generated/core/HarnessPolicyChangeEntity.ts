/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Append-only WORM record of a single harness-policy edit (TASK-330 Phase 6).
 *
 * Immutable by design: the backing table has NO `_version` / `_metadata` /
 * `updatedAt` / `resourceStatus` columns and the migration REVOKEs UPDATE/DELETE
 * from the application role. The inherited base audit fields are stripped in
 * `HarnessPolicyChangeEntityMapper.toPersistence` so they are never written.
 * `beforeJson` is null when the change CREATED the policy row.
 */
export interface IHarnessPolicyChangeEntity extends IBaseTenantEntity {
  changedBy?: string | null;
  policyVersion?: number | null;
  beforeJson?: JsonValue | null;
  afterJson: JsonValue;
  reason?: string | null;
}

export class HarnessPolicyChangeEntity extends BaseTenantEntity {
  private _changedBy?: IHarnessPolicyChangeEntity['changedBy'];
  private _policyVersion?: IHarnessPolicyChangeEntity['policyVersion'];
  private _beforeJson?: IHarnessPolicyChangeEntity['beforeJson'];
  private _afterJson: IHarnessPolicyChangeEntity['afterJson'];
  private _reason?: IHarnessPolicyChangeEntity['reason'];

  constructor(init: IHarnessPolicyChangeEntity) {
    super(init);
    this._changedBy = init.changedBy;
    this._policyVersion = init.policyVersion;
    this._beforeJson = init.beforeJson;
    this._afterJson = init.afterJson;
    this._reason = init.reason;
  }

  // Read-only accessors — the record is immutable once created (WORM). No
  // setters are exposed: an "update" to a change record is a new appended row.

  get changedBy(): IHarnessPolicyChangeEntity['changedBy'] {
    return this._changedBy;
  }

  get policyVersion(): IHarnessPolicyChangeEntity['policyVersion'] {
    return this._policyVersion;
  }

  get beforeJson(): IHarnessPolicyChangeEntity['beforeJson'] {
    return this._beforeJson;
  }

  get afterJson(): IHarnessPolicyChangeEntity['afterJson'] {
    return this._afterJson;
  }

  get reason(): IHarnessPolicyChangeEntity['reason'] {
    return this._reason;
  }

  public override validate(): void {
    super.validate();
    if (this._afterJson === undefined || this._afterJson === null) {
      throw new BusinessException('HarnessPolicyChange afterJson is required.');
    }
  }
}
