/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

// An IMMUTABLE snapshot of a DepartmentAgent's loop-configuration
// surface. Written once by `DepartmentAgentService.create`/`update` and never
// updated: a correction is a new version, exactly like `PromptVersion` /
// `ConsultationContextSchemaVersion`. That immutability is what lets a
// running consultation loop pin `agentConfigVersionId` at start
// and what promotion copies verbatim into a target tenant.
//
// The row therefore carries no `resourceStatus` (see MODELS_WITHOUT_SOFT_DELETE)
// and no `updatedAt`/`updatedBy` — the mapper strips those, mirroring
// `ConsultationContextSchemaVersionEntityMapper` / `PromptVersionEntityMapper`.
export interface IDepartmentAgentVersionEntity extends IBaseTenantEntity {
  agentId: string;
  versionNumber: number;
  configSnapshot: JsonValue;
  checksum: string;
  changeReason?: string | null;
  Agent?: Entities.DepartmentAgentEntity | null;
}

export class DepartmentAgentVersionEntity extends BaseTenantEntity {
  private _agentId: IDepartmentAgentVersionEntity['agentId'];
  private _versionNumber: IDepartmentAgentVersionEntity['versionNumber'];
  private _configSnapshot: IDepartmentAgentVersionEntity['configSnapshot'];
  private _checksum: IDepartmentAgentVersionEntity['checksum'];
  private _changeReason?: IDepartmentAgentVersionEntity['changeReason'];
  private _Agent?: IDepartmentAgentVersionEntity['Agent'];

  constructor(init: IDepartmentAgentVersionEntity) {
    super(init);
    this._agentId = init.agentId;
    this._versionNumber = init.versionNumber;
    this._configSnapshot = init.configSnapshot;
    this._checksum = init.checksum;
    this._changeReason = init.changeReason;
    this._Agent = init.Agent;
  }

  get agentId(): IDepartmentAgentVersionEntity['agentId'] {
    return this._agentId;
  }

  set agentId(value: IDepartmentAgentVersionEntity['agentId']) {
    this.setProperty('agentId', value);
  }

  get versionNumber(): IDepartmentAgentVersionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IDepartmentAgentVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get configSnapshot(): IDepartmentAgentVersionEntity['configSnapshot'] {
    return this._configSnapshot;
  }

  set configSnapshot(value: IDepartmentAgentVersionEntity['configSnapshot']) {
    this.setProperty('configSnapshot', value);
  }

  get checksum(): IDepartmentAgentVersionEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IDepartmentAgentVersionEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  get changeReason(): IDepartmentAgentVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IDepartmentAgentVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get Agent(): IDepartmentAgentVersionEntity['Agent'] {
    return this._Agent;
  }

  set Agent(value: IDepartmentAgentVersionEntity['Agent']) {
    this.setProperty('Agent', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._agentId) {
      throw new BusinessException('Agent ID is required');
    }
    if (!Number.isInteger(this._versionNumber) || this._versionNumber < 1) {
      throw new BusinessException('versionNumber must be a positive integer');
    }
    if (this._configSnapshot == null || typeof this._configSnapshot !== 'object' || Array.isArray(this._configSnapshot)) {
      throw new BusinessException('configSnapshot must be a JSON object');
    }
    if (!this._checksum || this._checksum.trim().length === 0) {
      throw new BusinessException('checksum is required');
    }
  }
}
