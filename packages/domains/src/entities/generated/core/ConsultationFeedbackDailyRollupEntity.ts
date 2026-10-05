/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Per-day feedback aggregate, recomputed (replaced) per (tenant, day). The
 * '' reasonCode row carries the rating counts; one row per reason code carries
 * `reasonedCount` only. Empty-string / 0 dimension defaults keep the unique
 * key total. Derived data: no `_metadata`, `_version`, audit or
 * `resourceStatus*` columns; `computedAt` stamps the recompute.
 */
export interface IConsultationFeedbackDailyRollupEntity extends IBaseTenantEntity {
  // UTC calendar day
  day: Date;
  targetKind: Enums.FeedbackTargetKind;
  agentSlug?: string;
  agentVersion?: number;
  modelName?: string;
  promptVersion?: string;
  sectionKey?: string;
  entityLabel?: string;
  reasonCode?: string;
  upCount?: number;
  downCount?: number;
  clearedCount?: number;
  commentCount?: number;
  correctionCount?: number;
  reasonedCount?: number;
  computedAt?: Date;
}

export class ConsultationFeedbackDailyRollupEntity extends BaseTenantEntity {
  private _day: IConsultationFeedbackDailyRollupEntity['day'];
  private _targetKind: IConsultationFeedbackDailyRollupEntity['targetKind'];
  private _agentSlug: IConsultationFeedbackDailyRollupEntity['agentSlug'];
  private _agentVersion: IConsultationFeedbackDailyRollupEntity['agentVersion'];
  private _modelName: IConsultationFeedbackDailyRollupEntity['modelName'];
  private _promptVersion: IConsultationFeedbackDailyRollupEntity['promptVersion'];
  private _sectionKey: IConsultationFeedbackDailyRollupEntity['sectionKey'];
  private _entityLabel: IConsultationFeedbackDailyRollupEntity['entityLabel'];
  private _reasonCode: IConsultationFeedbackDailyRollupEntity['reasonCode'];
  private _upCount: IConsultationFeedbackDailyRollupEntity['upCount'];
  private _downCount: IConsultationFeedbackDailyRollupEntity['downCount'];
  private _clearedCount: IConsultationFeedbackDailyRollupEntity['clearedCount'];
  private _commentCount: IConsultationFeedbackDailyRollupEntity['commentCount'];
  private _correctionCount: IConsultationFeedbackDailyRollupEntity['correctionCount'];
  private _reasonedCount: IConsultationFeedbackDailyRollupEntity['reasonedCount'];
  private _computedAt?: IConsultationFeedbackDailyRollupEntity['computedAt'];

  constructor(init: IConsultationFeedbackDailyRollupEntity) {
    super(init);
    this._day = init.day;
    this._targetKind = init.targetKind;
    this._agentSlug = init.agentSlug ?? '';
    this._agentVersion = init.agentVersion ?? 0;
    this._modelName = init.modelName ?? '';
    this._promptVersion = init.promptVersion ?? '';
    this._sectionKey = init.sectionKey ?? '';
    this._entityLabel = init.entityLabel ?? '';
    this._reasonCode = init.reasonCode ?? '';
    this._upCount = init.upCount ?? 0;
    this._downCount = init.downCount ?? 0;
    this._clearedCount = init.clearedCount ?? 0;
    this._commentCount = init.commentCount ?? 0;
    this._correctionCount = init.correctionCount ?? 0;
    this._reasonedCount = init.reasonedCount ?? 0;
    this._computedAt = init.computedAt;
  }

  get day(): IConsultationFeedbackDailyRollupEntity['day'] {
    return this._day;
  }

  set day(value: IConsultationFeedbackDailyRollupEntity['day']) {
    this.setProperty('day', value);
  }

  get targetKind(): IConsultationFeedbackDailyRollupEntity['targetKind'] {
    return this._targetKind;
  }

  set targetKind(value: IConsultationFeedbackDailyRollupEntity['targetKind']) {
    this.setProperty('targetKind', value);
  }

  get agentSlug(): IConsultationFeedbackDailyRollupEntity['agentSlug'] {
    return this._agentSlug;
  }

  set agentSlug(value: IConsultationFeedbackDailyRollupEntity['agentSlug']) {
    this.setProperty('agentSlug', value);
  }

  get agentVersion(): IConsultationFeedbackDailyRollupEntity['agentVersion'] {
    return this._agentVersion;
  }

  set agentVersion(value: IConsultationFeedbackDailyRollupEntity['agentVersion']) {
    this.setProperty('agentVersion', value);
  }

  get modelName(): IConsultationFeedbackDailyRollupEntity['modelName'] {
    return this._modelName;
  }

  set modelName(value: IConsultationFeedbackDailyRollupEntity['modelName']) {
    this.setProperty('modelName', value);
  }

  get promptVersion(): IConsultationFeedbackDailyRollupEntity['promptVersion'] {
    return this._promptVersion;
  }

  set promptVersion(value: IConsultationFeedbackDailyRollupEntity['promptVersion']) {
    this.setProperty('promptVersion', value);
  }

  get sectionKey(): IConsultationFeedbackDailyRollupEntity['sectionKey'] {
    return this._sectionKey;
  }

  set sectionKey(value: IConsultationFeedbackDailyRollupEntity['sectionKey']) {
    this.setProperty('sectionKey', value);
  }

  get entityLabel(): IConsultationFeedbackDailyRollupEntity['entityLabel'] {
    return this._entityLabel;
  }

  set entityLabel(value: IConsultationFeedbackDailyRollupEntity['entityLabel']) {
    this.setProperty('entityLabel', value);
  }

  get reasonCode(): IConsultationFeedbackDailyRollupEntity['reasonCode'] {
    return this._reasonCode;
  }

  set reasonCode(value: IConsultationFeedbackDailyRollupEntity['reasonCode']) {
    this.setProperty('reasonCode', value);
  }

  get upCount(): IConsultationFeedbackDailyRollupEntity['upCount'] {
    return this._upCount;
  }

  set upCount(value: IConsultationFeedbackDailyRollupEntity['upCount']) {
    this.setProperty('upCount', value);
  }

  get downCount(): IConsultationFeedbackDailyRollupEntity['downCount'] {
    return this._downCount;
  }

  set downCount(value: IConsultationFeedbackDailyRollupEntity['downCount']) {
    this.setProperty('downCount', value);
  }

  get clearedCount(): IConsultationFeedbackDailyRollupEntity['clearedCount'] {
    return this._clearedCount;
  }

  set clearedCount(value: IConsultationFeedbackDailyRollupEntity['clearedCount']) {
    this.setProperty('clearedCount', value);
  }

  get commentCount(): IConsultationFeedbackDailyRollupEntity['commentCount'] {
    return this._commentCount;
  }

  set commentCount(value: IConsultationFeedbackDailyRollupEntity['commentCount']) {
    this.setProperty('commentCount', value);
  }

  get correctionCount(): IConsultationFeedbackDailyRollupEntity['correctionCount'] {
    return this._correctionCount;
  }

  set correctionCount(value: IConsultationFeedbackDailyRollupEntity['correctionCount']) {
    this.setProperty('correctionCount', value);
  }

  get reasonedCount(): IConsultationFeedbackDailyRollupEntity['reasonedCount'] {
    return this._reasonedCount;
  }

  set reasonedCount(value: IConsultationFeedbackDailyRollupEntity['reasonedCount']) {
    this.setProperty('reasonedCount', value);
  }

  get computedAt(): IConsultationFeedbackDailyRollupEntity['computedAt'] {
    return this._computedAt;
  }

  set computedAt(value: IConsultationFeedbackDailyRollupEntity['computedAt']) {
    this.setProperty('computedAt', value);
  }

  public override validate(): void {
    super.validate();
  }
}
