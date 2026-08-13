/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

// An IMMUTABLE published snapshot of one `definition`. Written once
// by `ConsultationContextSchemaService.publish` and never updated: a
// correction is a new version, exactly like `PromptVersion`. That immutability
// is what lets a consultation pin a version at open and keep validating
// against it no matter what the tenant publishes afterwards.
//
// The row therefore carries no `resourceStatus` (see MODELS_WITHOUT_SOFT_DELETE)
// and no `updatedAt`/`updatedBy` — the mapper strips those, mirroring
// `PromptVersionEntityMapper`.
export interface IConsultationContextSchemaVersionEntity extends IBaseTenantEntity {
  schemaId: string;
  versionNumber: number;
  definition: JsonValue;
  checksum: string;
  changeReason?: string | null;
  Schema?: Entities.ConsultationContextSchemaEntity | null;
}

export class ConsultationContextSchemaVersionEntity extends BaseTenantEntity {
  private _schemaId: IConsultationContextSchemaVersionEntity['schemaId'];
  private _versionNumber: IConsultationContextSchemaVersionEntity['versionNumber'];
  private _definition: IConsultationContextSchemaVersionEntity['definition'];
  private _checksum: IConsultationContextSchemaVersionEntity['checksum'];
  private _changeReason?: IConsultationContextSchemaVersionEntity['changeReason'];
  private _Schema?: IConsultationContextSchemaVersionEntity['Schema'];

  constructor(init: IConsultationContextSchemaVersionEntity) {
    super(init);
    this._schemaId = init.schemaId;
    this._versionNumber = init.versionNumber;
    this._definition = init.definition;
    this._checksum = init.checksum;
    this._changeReason = init.changeReason;
    this._Schema = init.Schema;
  }

  get schemaId(): IConsultationContextSchemaVersionEntity['schemaId'] {
    return this._schemaId;
  }

  set schemaId(value: IConsultationContextSchemaVersionEntity['schemaId']) {
    this.setProperty('schemaId', value);
  }

  get versionNumber(): IConsultationContextSchemaVersionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IConsultationContextSchemaVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get definition(): IConsultationContextSchemaVersionEntity['definition'] {
    return this._definition;
  }

  set definition(value: IConsultationContextSchemaVersionEntity['definition']) {
    this.setProperty('definition', value);
  }

  get checksum(): IConsultationContextSchemaVersionEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IConsultationContextSchemaVersionEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  get changeReason(): IConsultationContextSchemaVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IConsultationContextSchemaVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get Schema(): IConsultationContextSchemaVersionEntity['Schema'] {
    return this._Schema;
  }

  set Schema(value: IConsultationContextSchemaVersionEntity['Schema']) {
    this.setProperty('Schema', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._schemaId) {
      throw new BusinessException('Schema ID is required');
    }
    if (!Number.isInteger(this._versionNumber) || this._versionNumber < 1) {
      throw new BusinessException('versionNumber must be a positive integer');
    }
    if (this._definition == null || typeof this._definition !== 'object' || Array.isArray(this._definition)) {
      throw new BusinessException('definition must be a JSON object');
    }
    if (!this._checksum || this._checksum.trim().length === 0) {
      throw new BusinessException('checksum is required');
    }
  }
}
