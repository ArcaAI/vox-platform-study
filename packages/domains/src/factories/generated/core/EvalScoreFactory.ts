/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { EvalScoreEntity, IEvalScoreEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateEvalScoreProps extends BaseEntityFactoryCreateProps {
  evalRunId: IEvalScoreEntity['evalRunId'];
  goldenCaseId: IEvalScoreEntity['goldenCaseId'];
  metric: IEvalScoreEntity['metric'];
  score: IEvalScoreEntity['score'];
  maxScore?: IEvalScoreEntity['maxScore'];
  rationale?: IEvalScoreEntity['rationale'];
  judgeModel?: IEvalScoreEntity['judgeModel'];
  details?: IEvalScoreEntity['details'];
  tenantId: IEvalScoreEntity['tenantId'];
  Tenant?: IEvalScoreEntity['Tenant'];

  createdAt?: IEvalScoreEntity['createdAt'];
  updatedAt?: IEvalScoreEntity['updatedAt'];
  createdBy?: IEvalScoreEntity['createdBy'];
  updatedBy?: IEvalScoreEntity['updatedBy'];
}

export class EvalScoreFactory {
  static CreateEvalScore(props: CreateEvalScoreProps): EvalScoreEntity {
    const id = generateId();
    const now = new Date();

    return new EvalScoreEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      evalRunId: props.evalRunId,
      goldenCaseId: props.goldenCaseId,
      metric: props.metric,
      score: props.score,
      maxScore: props.maxScore ?? null,
      rationale: props.rationale ?? null,
      judgeModel: props.judgeModel ?? null,
      details: props.details ?? null,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
