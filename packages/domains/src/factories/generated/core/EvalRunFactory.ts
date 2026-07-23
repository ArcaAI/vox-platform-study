/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { EvalRunEntity, IEvalRunEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateEvalRunProps extends BaseEntityFactoryCreateProps {
  goldenSetId: IEvalRunEntity['goldenSetId'];
  modelName: IEvalRunEntity['modelName'];
  modelVersion?: IEvalRunEntity['modelVersion'];
  promptTemplateId?: IEvalRunEntity['promptTemplateId'];
  promptVersion?: IEvalRunEntity['promptVersion'];
  promptVersionNumber?: IEvalRunEntity['promptVersionNumber'];
  judgeModel?: IEvalRunEntity['judgeModel'];
  triggerType?: IEvalRunEntity['triggerType'];
  status?: IEvalRunEntity['status'];
  startedAt?: IEvalRunEntity['startedAt'];
  completedAt?: IEvalRunEntity['completedAt'];
  aggregateScores?: IEvalRunEntity['aggregateScores'];
  notes?: IEvalRunEntity['notes'];
  tenantId: IEvalRunEntity['tenantId'];
  Tenant?: IEvalRunEntity['Tenant'];

  createdAt?: IEvalRunEntity['createdAt'];
  updatedAt?: IEvalRunEntity['updatedAt'];
  createdBy?: IEvalRunEntity['createdBy'];
  updatedBy?: IEvalRunEntity['updatedBy'];
}

export class EvalRunFactory {
  static CreateEvalRun(props: CreateEvalRunProps): EvalRunEntity {
    const id = generateId();
    const now = new Date();

    return new EvalRunEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      goldenSetId: props.goldenSetId,
      modelName: props.modelName,
      modelVersion: props.modelVersion ?? null,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      promptVersionNumber: props.promptVersionNumber ?? null,
      judgeModel: props.judgeModel ?? null,
      triggerType: props.triggerType ?? null,
      status: props.status ?? null,
      startedAt: props.startedAt ?? null,
      completedAt: props.completedAt ?? null,
      aggregateScores: props.aggregateScores ?? null,
      notes: props.notes ?? null,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
