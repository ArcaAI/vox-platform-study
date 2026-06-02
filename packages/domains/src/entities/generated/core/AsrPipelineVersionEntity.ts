/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

export interface IAsrPipelineVersionEntity extends IBaseTenantEntity {
  asrPipelineId: string;
  versionNumber: number;
  configYaml: string;
  name?: string | null;
  description?: string | null;
  changeReason?: string | null;
  changedBy?: string | null;
}

export class AsrPipelineVersionEntity extends BaseTenantEntity {
  private _asrPipelineId: IAsrPipelineVersionEntity['asrPipelineId'];
  private _versionNumber: IAsrPipelineVersionEntity['versionNumber'];
  private _configYaml: IAsrPipelineVersionEntity['configYaml'];
  private _name?: IAsrPipelineVersionEntity['name'];
  private _description?: IAsrPipelineVersionEntity['description'];
  private _changeReason?: IAsrPipelineVersionEntity['changeReason'];
  private _changedBy?: IAsrPipelineVersionEntity['changedBy'];

  constructor(init: IAsrPipelineVersionEntity) {
    super(init);
    this._asrPipelineId = init.asrPipelineId;
    this._versionNumber = init.versionNumber;
    this._configYaml = init.configYaml;
    this._name = init.name;
    this._description = init.description;
    this._changeReason = init.changeReason;
    this._changedBy = init.changedBy;
  }

  get asrPipelineId(): IAsrPipelineVersionEntity['asrPipelineId'] {
    return this._asrPipelineId;
  }

  set asrPipelineId(value: IAsrPipelineVersionEntity['asrPipelineId']) {
    this.setProperty('asrPipelineId', value);
  }

  get versionNumber(): IAsrPipelineVersionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IAsrPipelineVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get configYaml(): IAsrPipelineVersionEntity['configYaml'] {
    return this._configYaml;
  }

  set configYaml(value: IAsrPipelineVersionEntity['configYaml']) {
    this.setProperty('configYaml', value);
  }

  get name(): IAsrPipelineVersionEntity['name'] {
    return this._name;
  }

  set name(value: IAsrPipelineVersionEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IAsrPipelineVersionEntity['description'] {
    return this._description;
  }

  set description(value: IAsrPipelineVersionEntity['description']) {
    this.setProperty('description', value);
  }

  get changeReason(): IAsrPipelineVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IAsrPipelineVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get changedBy(): IAsrPipelineVersionEntity['changedBy'] {
    return this._changedBy;
  }

  set changedBy(value: IAsrPipelineVersionEntity['changedBy']) {
    this.setProperty('changedBy', value);
  }

}
