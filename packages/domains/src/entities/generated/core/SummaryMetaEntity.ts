/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Entities from '../../../entities';

export interface ISummaryMetaEntity extends IBaseTenantEntity {
  contextItemId: string;
  aiModelId?: string | null;
  aiModelVersion?: string | null;
  promptVersion?: string | null;
  processingTimeMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  caseNoteIds: string[];
  preSummaryIds: string[];
  previousSummaryIds: string[];
  generatedAt?: Date | null;
  cacheHit?: boolean | null;
  qualityScore?: number | null;
  ContextItem?: Entities.ContextItemEntity | null;
}

export class SummaryMetaEntity extends BaseTenantEntity {
  private _contextItemId: ISummaryMetaEntity['contextItemId'];
  private _aiModelId?: ISummaryMetaEntity['aiModelId'];
  private _aiModelVersion?: ISummaryMetaEntity['aiModelVersion'];
  private _promptVersion?: ISummaryMetaEntity['promptVersion'];
  private _processingTimeMs?: ISummaryMetaEntity['processingTimeMs'];
  private _inputTokens?: ISummaryMetaEntity['inputTokens'];
  private _outputTokens?: ISummaryMetaEntity['outputTokens'];
  private _caseNoteIds: ISummaryMetaEntity['caseNoteIds'];
  private _preSummaryIds: ISummaryMetaEntity['preSummaryIds'];
  private _previousSummaryIds: ISummaryMetaEntity['previousSummaryIds'];
  private _generatedAt?: ISummaryMetaEntity['generatedAt'];
  private _cacheHit?: ISummaryMetaEntity['cacheHit'];
  private _qualityScore?: ISummaryMetaEntity['qualityScore'];
  private _ContextItem?: ISummaryMetaEntity['ContextItem'];

  constructor(init: ISummaryMetaEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._aiModelId = init.aiModelId;
    this._aiModelVersion = init.aiModelVersion;
    this._promptVersion = init.promptVersion;
    this._processingTimeMs = init.processingTimeMs;
    this._inputTokens = init.inputTokens;
    this._outputTokens = init.outputTokens;
    this._caseNoteIds = init.caseNoteIds ?? [];
    this._preSummaryIds = init.preSummaryIds ?? [];
    this._previousSummaryIds = init.previousSummaryIds ?? [];
    this._generatedAt = init.generatedAt;
    this._cacheHit = init.cacheHit;
    this._qualityScore = init.qualityScore;
    this._ContextItem = init.ContextItem;
  }

  get contextItemId(): ISummaryMetaEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: ISummaryMetaEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get aiModelId(): ISummaryMetaEntity['aiModelId'] {
    return this._aiModelId;
  }

  set aiModelId(value: ISummaryMetaEntity['aiModelId']) {
    this.setProperty('aiModelId', value);
  }

  get aiModelVersion(): ISummaryMetaEntity['aiModelVersion'] {
    return this._aiModelVersion;
  }

  set aiModelVersion(value: ISummaryMetaEntity['aiModelVersion']) {
    this.setProperty('aiModelVersion', value);
  }

  get promptVersion(): ISummaryMetaEntity['promptVersion'] {
    return this._promptVersion;
  }

  set promptVersion(value: ISummaryMetaEntity['promptVersion']) {
    this.setProperty('promptVersion', value);
  }

  get processingTimeMs(): ISummaryMetaEntity['processingTimeMs'] {
    return this._processingTimeMs;
  }

  set processingTimeMs(value: ISummaryMetaEntity['processingTimeMs']) {
    this.setProperty('processingTimeMs', value);
  }

  get inputTokens(): ISummaryMetaEntity['inputTokens'] {
    return this._inputTokens;
  }

  set inputTokens(value: ISummaryMetaEntity['inputTokens']) {
    this.setProperty('inputTokens', value);
  }

  get outputTokens(): ISummaryMetaEntity['outputTokens'] {
    return this._outputTokens;
  }

  set outputTokens(value: ISummaryMetaEntity['outputTokens']) {
    this.setProperty('outputTokens', value);
  }

  get caseNoteIds(): ISummaryMetaEntity['caseNoteIds'] {
    return this._caseNoteIds;
  }

  set caseNoteIds(value: ISummaryMetaEntity['caseNoteIds']) {
    this.setProperty('caseNoteIds', value);
  }

  get preSummaryIds(): ISummaryMetaEntity['preSummaryIds'] {
    return this._preSummaryIds;
  }

  set preSummaryIds(value: ISummaryMetaEntity['preSummaryIds']) {
    this.setProperty('preSummaryIds', value);
  }

  get previousSummaryIds(): ISummaryMetaEntity['previousSummaryIds'] {
    return this._previousSummaryIds;
  }

  set previousSummaryIds(value: ISummaryMetaEntity['previousSummaryIds']) {
    this.setProperty('previousSummaryIds', value);
  }

  get generatedAt(): ISummaryMetaEntity['generatedAt'] {
    return this._generatedAt;
  }

  set generatedAt(value: ISummaryMetaEntity['generatedAt']) {
    this.setProperty('generatedAt', value);
  }

  get cacheHit(): ISummaryMetaEntity['cacheHit'] {
    return this._cacheHit;
  }

  set cacheHit(value: ISummaryMetaEntity['cacheHit']) {
    this.setProperty('cacheHit', value);
  }

  get qualityScore(): ISummaryMetaEntity['qualityScore'] {
    return this._qualityScore;
  }

  set qualityScore(value: ISummaryMetaEntity['qualityScore']) {
    this.setProperty('qualityScore', value);
  }

  get ContextItem(): ISummaryMetaEntity['ContextItem'] {
    return this._ContextItem;
  }

  set ContextItem(value: ISummaryMetaEntity['ContextItem']) {
    this.setProperty('ContextItem', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Get total tokens used
   */
  get totalTokens(): number {
    return (this._inputTokens ?? 0) + (this._outputTokens ?? 0);
  }

  /**
   * Get processing time in seconds
   */
  get processingTimeSeconds(): number | null {
    return this._processingTimeMs ? this._processingTimeMs / 1000 : null;
  }

  /**
   * Check if this summary used case notes as context
   */
  get hasCaseNoteContext(): boolean {
    return this._caseNoteIds.length > 0;
  }

  /**
   * Check if this summary used pre-summaries as context
   */
  get hasPreSummaryContext(): boolean {
    return this._preSummaryIds.length > 0;
  }

  /**
   * Check if this summary used previous consultation summaries as context
   */
  get hasPreviousSummaryContext(): boolean {
    return this._previousSummaryIds.length > 0;
  }

  /**
   * Check if any context was used for generation
   */
  get hasAnyContext(): boolean {
    return this.hasCaseNoteContext || this.hasPreSummaryContext || this.hasPreviousSummaryContext;
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId) {
      throw new BusinessException('Context item ID is required');
    }
  }
}
