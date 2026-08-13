/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

// The immutable, WORM record of one agent promotion from a source
// tenant into a target tenant. Promotion is admin-chosen, ANY tenant to ANY
// tenant; "the actor holds manage rights on BOTH tenants" is the
// entire authorization control and is enforced in `AgentPromotionService`.
//
// Written once and never updated — a re-promotion writes a NEW row — so the
// table is an audit history whose value depends on entries being unretractable.
// It therefore carries no `resourceStatus` (see MODELS_WITHOUT_SOFT_DELETE) and
// no `updatedAt`/`updatedBy`; the mapper strips them, mirroring
// `DepartmentAgentVersionEntityMapper` / `PromptVersionEntityMapper`.
//
// `tenantId` IS `toTenantId` (enforced in `validate()`): the record is the
// TARGET tenant's lineage and is read under the target's tenant scope. If the
// two could diverge, a row would be readable by one tenant while describing
// another's agent.
export interface IAgentPromotionEntity extends IBaseTenantEntity {
  fromTenantId: string;
  toTenantId: string;
  /** The exact immutable `DepartmentAgentVersion` (in the SOURCE tenant) that was promoted. */
  agentVersionId: string;
  sourceAgentId: string;
  /** The agent row in the TARGET tenant this promotion created or advanced. */
  targetAgentId: string;
  targetAgentVersionId?: string | null;
  configSnapshot: JsonValue;
  checksum: string;
  /** The eval run executed AT THE TARGET, against the target's own corpus. */
  evalRunId?: string | null;
  /** The source-tenant run that travelled as an attestation only — never a result the target inherits. */
  sourceEvalRunId?: string | null;
  warnings?: JsonValue | null;
  promotedBy?: string | null;
}

export class AgentPromotionEntity extends BaseTenantEntity {
  private _fromTenantId: IAgentPromotionEntity['fromTenantId'];
  private _toTenantId: IAgentPromotionEntity['toTenantId'];
  private _agentVersionId: IAgentPromotionEntity['agentVersionId'];
  private _sourceAgentId: IAgentPromotionEntity['sourceAgentId'];
  private _targetAgentId: IAgentPromotionEntity['targetAgentId'];
  private _targetAgentVersionId?: IAgentPromotionEntity['targetAgentVersionId'];
  private _configSnapshot: IAgentPromotionEntity['configSnapshot'];
  private _checksum: IAgentPromotionEntity['checksum'];
  private _evalRunId?: IAgentPromotionEntity['evalRunId'];
  private _sourceEvalRunId?: IAgentPromotionEntity['sourceEvalRunId'];
  private _warnings?: IAgentPromotionEntity['warnings'];
  private _promotedBy?: IAgentPromotionEntity['promotedBy'];

  constructor(init: IAgentPromotionEntity) {
    super(init);
    this._fromTenantId = init.fromTenantId;
    this._toTenantId = init.toTenantId;
    this._agentVersionId = init.agentVersionId;
    this._sourceAgentId = init.sourceAgentId;
    this._targetAgentId = init.targetAgentId;
    this._targetAgentVersionId = init.targetAgentVersionId;
    this._configSnapshot = init.configSnapshot;
    this._checksum = init.checksum;
    this._evalRunId = init.evalRunId;
    this._sourceEvalRunId = init.sourceEvalRunId;
    this._warnings = init.warnings;
    this._promotedBy = init.promotedBy;
  }

  get fromTenantId(): IAgentPromotionEntity['fromTenantId'] {
    return this._fromTenantId;
  }

  set fromTenantId(value: IAgentPromotionEntity['fromTenantId']) {
    this.setProperty('fromTenantId', value);
  }

  get toTenantId(): IAgentPromotionEntity['toTenantId'] {
    return this._toTenantId;
  }

  set toTenantId(value: IAgentPromotionEntity['toTenantId']) {
    this.setProperty('toTenantId', value);
  }

  get agentVersionId(): IAgentPromotionEntity['agentVersionId'] {
    return this._agentVersionId;
  }

  set agentVersionId(value: IAgentPromotionEntity['agentVersionId']) {
    this.setProperty('agentVersionId', value);
  }

  get sourceAgentId(): IAgentPromotionEntity['sourceAgentId'] {
    return this._sourceAgentId;
  }

  set sourceAgentId(value: IAgentPromotionEntity['sourceAgentId']) {
    this.setProperty('sourceAgentId', value);
  }

  get targetAgentId(): IAgentPromotionEntity['targetAgentId'] {
    return this._targetAgentId;
  }

  set targetAgentId(value: IAgentPromotionEntity['targetAgentId']) {
    this.setProperty('targetAgentId', value);
  }

  get targetAgentVersionId(): IAgentPromotionEntity['targetAgentVersionId'] {
    return this._targetAgentVersionId;
  }

  set targetAgentVersionId(value: IAgentPromotionEntity['targetAgentVersionId']) {
    this.setProperty('targetAgentVersionId', value);
  }

  get configSnapshot(): IAgentPromotionEntity['configSnapshot'] {
    return this._configSnapshot;
  }

  set configSnapshot(value: IAgentPromotionEntity['configSnapshot']) {
    this.setProperty('configSnapshot', value);
  }

  get checksum(): IAgentPromotionEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IAgentPromotionEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  get evalRunId(): IAgentPromotionEntity['evalRunId'] {
    return this._evalRunId;
  }

  set evalRunId(value: IAgentPromotionEntity['evalRunId']) {
    this.setProperty('evalRunId', value);
  }

  get sourceEvalRunId(): IAgentPromotionEntity['sourceEvalRunId'] {
    return this._sourceEvalRunId;
  }

  set sourceEvalRunId(value: IAgentPromotionEntity['sourceEvalRunId']) {
    this.setProperty('sourceEvalRunId', value);
  }

  get warnings(): IAgentPromotionEntity['warnings'] {
    return this._warnings;
  }

  set warnings(value: IAgentPromotionEntity['warnings']) {
    this.setProperty('warnings', value);
  }

  get promotedBy(): IAgentPromotionEntity['promotedBy'] {
    return this._promotedBy;
  }

  set promotedBy(value: IAgentPromotionEntity['promotedBy']) {
    this.setProperty('promotedBy', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._fromTenantId) {
      throw new BusinessException('fromTenantId is required');
    }
    if (!this._toTenantId) {
      throw new BusinessException('toTenantId is required');
    }
    // The row is the TARGET's lineage and is read under the target's tenant
    // scope — the two columns can never be allowed to disagree.
    if (this.tenantId !== this._toTenantId) {
      throw new BusinessException('tenantId must equal toTenantId — the promotion record is owned by the target tenant');
    }
    // Promotion is a CROSS-tenant move. Copying inside one tenant is `clone()`,
    // which has entirely different template semantics (it deep-copies the bound
    // template into an editable DRAFT rather than snapshotting it APPROVED).
    if (this._fromTenantId === this._toTenantId) {
      throw new BusinessException('A promotion cannot start and end in the same tenant');
    }
    if (!this._agentVersionId) {
      throw new BusinessException('agentVersionId is required');
    }
    if (!this._sourceAgentId) {
      throw new BusinessException('sourceAgentId is required');
    }
    if (!this._targetAgentId) {
      throw new BusinessException('targetAgentId is required');
    }
    if (this._configSnapshot == null || typeof this._configSnapshot !== 'object' || Array.isArray(this._configSnapshot)) {
      throw new BusinessException('configSnapshot must be a JSON object');
    }
    if (!this._checksum || this._checksum.trim().length === 0) {
      throw new BusinessException('checksum is required');
    }
  }
}
