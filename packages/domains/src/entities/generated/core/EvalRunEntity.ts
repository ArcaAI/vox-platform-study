/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IEvalRunEntity extends IBaseTenantEntity {
  goldenSetId: string;
  modelName: string;
  modelVersion?: string | null;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  judgeModel?: string | null;
  status?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  aggregateScores?: JsonValue | null;
  notes?: string | null;
}

export class EvalRunEntity extends BaseTenantEntity {
  private _goldenSetId: IEvalRunEntity['goldenSetId'];
  private _modelName: IEvalRunEntity['modelName'];
  private _modelVersion?: IEvalRunEntity['modelVersion'];
  private _promptTemplateId?: IEvalRunEntity['promptTemplateId'];
  private _promptVersion?: IEvalRunEntity['promptVersion'];
  private _judgeModel?: IEvalRunEntity['judgeModel'];
  private _status?: IEvalRunEntity['status'];
  private _startedAt?: IEvalRunEntity['startedAt'];
  private _completedAt?: IEvalRunEntity['completedAt'];
  private _aggregateScores?: IEvalRunEntity['aggregateScores'];
  private _notes?: IEvalRunEntity['notes'];

  constructor(init: IEvalRunEntity) {
    super(init);
    this._goldenSetId = init.goldenSetId;
    this._modelName = init.modelName;
    this._modelVersion = init.modelVersion;
    this._promptTemplateId = init.promptTemplateId;
    this._promptVersion = init.promptVersion;
    this._judgeModel = init.judgeModel;
    this._status = init.status;
    this._startedAt = init.startedAt;
    this._completedAt = init.completedAt;
    this._aggregateScores = init.aggregateScores;
    this._notes = init.notes;
  }

  get goldenSetId(): IEvalRunEntity['goldenSetId'] {
    return this._goldenSetId;
  }

  set goldenSetId(value: IEvalRunEntity['goldenSetId']) {
    this.setProperty('goldenSetId', value);
  }

  get modelName(): IEvalRunEntity['modelName'] {
    return this._modelName;
  }

  set modelName(value: IEvalRunEntity['modelName']) {
    this.setProperty('modelName', value);
  }

  get modelVersion(): IEvalRunEntity['modelVersion'] {
    return this._modelVersion;
  }

  set modelVersion(value: IEvalRunEntity['modelVersion']) {
    this.setProperty('modelVersion', value);
  }

  get promptTemplateId(): IEvalRunEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  set promptTemplateId(value: IEvalRunEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  get promptVersion(): IEvalRunEntity['promptVersion'] {
    return this._promptVersion;
  }

  set promptVersion(value: IEvalRunEntity['promptVersion']) {
    this.setProperty('promptVersion', value);
  }

  get judgeModel(): IEvalRunEntity['judgeModel'] {
    return this._judgeModel;
  }

  set judgeModel(value: IEvalRunEntity['judgeModel']) {
    this.setProperty('judgeModel', value);
  }

  get status(): IEvalRunEntity['status'] {
    return this._status;
  }

  set status(value: IEvalRunEntity['status']) {
    this.setProperty('status', value);
  }

  get startedAt(): IEvalRunEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IEvalRunEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get completedAt(): IEvalRunEntity['completedAt'] {
    return this._completedAt;
  }

  set completedAt(value: IEvalRunEntity['completedAt']) {
    this.setProperty('completedAt', value);
  }

  get aggregateScores(): IEvalRunEntity['aggregateScores'] {
    return this._aggregateScores;
  }

  set aggregateScores(value: IEvalRunEntity['aggregateScores']) {
    this.setProperty('aggregateScores', value);
  }

  get notes(): IEvalRunEntity['notes'] {
    return this._notes;
  }

  set notes(value: IEvalRunEntity['notes']) {
    this.setProperty('notes', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._goldenSetId) {
      throw new BusinessException('EvalRun goldenSetId is required.');
    }
    if (!this._modelName || this._modelName.trim().length === 0) {
      throw new BusinessException('EvalRun modelName is required.');
    }
  }
}
