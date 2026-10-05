/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationFeedbackDailyRollupEntity, IConsultationFeedbackDailyRollupEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateConsultationFeedbackDailyRollupProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationFeedbackDailyRollupEntity['tenantId'];
  day: IConsultationFeedbackDailyRollupEntity['day'];
  targetKind: IConsultationFeedbackDailyRollupEntity['targetKind'];
  agentSlug?: IConsultationFeedbackDailyRollupEntity['agentSlug'];
  agentVersion?: IConsultationFeedbackDailyRollupEntity['agentVersion'];
  modelName?: IConsultationFeedbackDailyRollupEntity['modelName'];
  promptVersion?: IConsultationFeedbackDailyRollupEntity['promptVersion'];
  sectionKey?: IConsultationFeedbackDailyRollupEntity['sectionKey'];
  entityLabel?: IConsultationFeedbackDailyRollupEntity['entityLabel'];
  reasonCode?: IConsultationFeedbackDailyRollupEntity['reasonCode'];
  upCount?: IConsultationFeedbackDailyRollupEntity['upCount'];
  downCount?: IConsultationFeedbackDailyRollupEntity['downCount'];
  clearedCount?: IConsultationFeedbackDailyRollupEntity['clearedCount'];
  commentCount?: IConsultationFeedbackDailyRollupEntity['commentCount'];
  correctionCount?: IConsultationFeedbackDailyRollupEntity['correctionCount'];
  reasonedCount?: IConsultationFeedbackDailyRollupEntity['reasonedCount'];
  computedAt?: IConsultationFeedbackDailyRollupEntity['computedAt'];
  createdAt?: IConsultationFeedbackDailyRollupEntity['createdAt'];
  createdBy?: IConsultationFeedbackDailyRollupEntity['createdBy'];
}

export class ConsultationFeedbackDailyRollupFactory {
  /**
   * Create one rollup row (counts default to 0, dimensions to the empty value).
   */
  static CreateConsultationFeedbackDailyRollup(props: CreateConsultationFeedbackDailyRollupProps): ConsultationFeedbackDailyRollupEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationFeedbackDailyRollupEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      tenantId: props.tenantId,
      day: props.day,
      targetKind: props.targetKind,
      agentSlug: props.agentSlug ?? '',
      agentVersion: props.agentVersion ?? 0,
      modelName: props.modelName ?? '',
      promptVersion: props.promptVersion ?? '',
      sectionKey: props.sectionKey ?? '',
      entityLabel: props.entityLabel ?? '',
      reasonCode: props.reasonCode ?? '',
      upCount: props.upCount ?? 0,
      downCount: props.downCount ?? 0,
      clearedCount: props.clearedCount ?? 0,
      commentCount: props.commentCount ?? 0,
      correctionCount: props.correctionCount ?? 0,
      reasonedCount: props.reasonedCount ?? 0,
      computedAt: props.computedAt ?? now,
    });
  }
}
