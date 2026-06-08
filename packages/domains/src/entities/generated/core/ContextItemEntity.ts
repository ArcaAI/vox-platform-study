/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IContextItemEntity extends IBaseTenantEntity {
  consultationId: string;
  type: Enums.ContextItemType;
  source: Enums.ContextItemSource;
  currentVersionNumber: number;
  content?: string | null;
  mediaId?: string | null;
  dnaWritingStyleId?: string | null;
  qdrantSynced: boolean;
  qdrantSyncedAt?: Date | null;
  Consultation?: Entities.ConsultationEntity | null;
  AudioRecordings?: Entities.AudioRecordingEntity[] | null;
  SummaryMeta?: Entities.SummaryMetaEntity | null;
  NamedEntities?: Entities.NamedEntityEntity[] | null;
  Versions?: Entities.ContextItemVersionEntity[] | null;
}

export class ContextItemEntity extends BaseTenantEntity {
  private _consultationId: IContextItemEntity['consultationId'];
  private _type: IContextItemEntity['type'];
  private _source: IContextItemEntity['source'];
  private _currentVersionNumber: IContextItemEntity['currentVersionNumber'];
  private _content?: IContextItemEntity['content'];
  private _mediaId?: IContextItemEntity['mediaId'];
  private _dnaWritingStyleId?: IContextItemEntity['dnaWritingStyleId'];
  // Clinical Workflow Playground — round-trips the `_metadata` JSONB column so
  // ATTACHMENT lab/exam results can carry a `metadata.subType = 'LAB_RESULT'`
  // convention (no new enum). Mirrors the column already on BaseDataModel.
  private _metaData?: IContextItemEntity['metaData'];
  private _qdrantSynced: IContextItemEntity['qdrantSynced'];
  private _qdrantSyncedAt?: IContextItemEntity['qdrantSyncedAt'];
  private _Consultation?: IContextItemEntity['Consultation'];
  private _AudioRecordings?: IContextItemEntity['AudioRecordings'];
  private _SummaryMeta?: IContextItemEntity['SummaryMeta'];
  private _NamedEntities?: IContextItemEntity['NamedEntities'];
  private _Versions?: IContextItemEntity['Versions'];

  constructor(init: IContextItemEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._type = init.type;
    this._source = init.source ?? Enums.ContextItemSource.USER;
    this._currentVersionNumber = init.currentVersionNumber ?? 1;
    this._content = init.content;
    this._mediaId = init.mediaId;
    this._dnaWritingStyleId = init.dnaWritingStyleId;
    this._metaData = init.metaData;
    this._qdrantSynced = init.qdrantSynced ?? false;
    this._qdrantSyncedAt = init.qdrantSyncedAt;
    this._Consultation = init.Consultation;
    this._AudioRecordings = init.AudioRecordings;
    this._SummaryMeta = init.SummaryMeta;
    this._NamedEntities = init.NamedEntities;
    this._Versions = init.Versions;
  }

  get consultationId(): IContextItemEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IContextItemEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get type(): IContextItemEntity['type'] {
    return this._type;
  }

  set type(value: IContextItemEntity['type']) {
    this.setProperty('type', value);
  }

  get source(): IContextItemEntity['source'] {
    return this._source;
  }

  set source(value: IContextItemEntity['source']) {
    this.setProperty('source', value);
  }

  get currentVersionNumber(): IContextItemEntity['currentVersionNumber'] {
    return this._currentVersionNumber;
  }

  set currentVersionNumber(value: IContextItemEntity['currentVersionNumber']) {
    this.setProperty('currentVersionNumber', value);
  }

  get content(): IContextItemEntity['content'] {
    return this._content;
  }

  set content(value: IContextItemEntity['content']) {
    this.setProperty('content', value);
  }

  get mediaId(): IContextItemEntity['mediaId'] {
    return this._mediaId;
  }

  set mediaId(value: IContextItemEntity['mediaId']) {
    this.setProperty('mediaId', value);
  }

  get dnaWritingStyleId(): IContextItemEntity['dnaWritingStyleId'] {
    return this._dnaWritingStyleId;
  }

  set dnaWritingStyleId(value: IContextItemEntity['dnaWritingStyleId']) {
    this.setProperty('dnaWritingStyleId', value);
  }

  get metaData(): IContextItemEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IContextItemEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get qdrantSynced(): IContextItemEntity['qdrantSynced'] {
    return this._qdrantSynced;
  }

  set qdrantSynced(value: IContextItemEntity['qdrantSynced']) {
    this.setProperty('qdrantSynced', value);
  }

  get qdrantSyncedAt(): IContextItemEntity['qdrantSyncedAt'] {
    return this._qdrantSyncedAt;
  }

  set qdrantSyncedAt(value: IContextItemEntity['qdrantSyncedAt']) {
    this.setProperty('qdrantSyncedAt', value);
  }

  get Consultation(): IContextItemEntity['Consultation'] {
    return this._Consultation;
  }

  set Consultation(value: IContextItemEntity['Consultation']) {
    this.setProperty('Consultation', value);
  }

  get AudioRecordings(): IContextItemEntity['AudioRecordings'] {
    return this._AudioRecordings;
  }

  set AudioRecordings(value: IContextItemEntity['AudioRecordings']) {
    this.setProperty('AudioRecordings', value);
  }

  get SummaryMeta(): IContextItemEntity['SummaryMeta'] {
    return this._SummaryMeta;
  }

  set SummaryMeta(value: IContextItemEntity['SummaryMeta']) {
    this.setProperty('SummaryMeta', value);
  }

  get NamedEntities(): IContextItemEntity['NamedEntities'] {
    return this._NamedEntities;
  }

  set NamedEntities(value: IContextItemEntity['NamedEntities']) {
    this.setProperty('NamedEntities', value);
  }

  get Versions(): IContextItemEntity['Versions'] {
    return this._Versions;
  }

  set Versions(value: IContextItemEntity['Versions']) {
    this.setProperty('Versions', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a summary type (raw, modified, or pre-summary)
   */
  get isSummary(): boolean {
    return (
      this._type === Enums.ContextItemType.RAW_SUMMARY ||
      this._type === Enums.ContextItemType.MODIFIED_SUMMARY ||
      this._type === Enums.ContextItemType.PRE_SUMMARY
    );
  }

  /**
   * Check if this is a final summary (raw or modified, excludes pre-summary)
   */
  get isFinalSummary(): boolean {
    return this._type === Enums.ContextItemType.RAW_SUMMARY || this._type === Enums.ContextItemType.MODIFIED_SUMMARY;
  }

  /**
   * Check if this is a raw AI-generated summary
   */
  get isRawSummary(): boolean {
    return this._type === Enums.ContextItemType.RAW_SUMMARY;
  }

  /**
   * Check if this is a user-modified summary
   */
  get isModifiedSummary(): boolean {
    return this._type === Enums.ContextItemType.MODIFIED_SUMMARY;
  }

  /**
   * Check if this is a pre-summary (AI-generated summary of case notes)
   */
  get isPreSummary(): boolean {
    return this._type === Enums.ContextItemType.PRE_SUMMARY;
  }

  /**
   * Check if this is a transcription
   */
  get isTranscript(): boolean {
    return this._type === Enums.ContextItemType.TRANSCRIPT;
  }

  /**
   * Check if this is a case note
   */
  get isCaseNote(): boolean {
    return this._type === Enums.ContextItemType.CASE_NOTE;
  }

  /**
   * Check if this is a worknote
   */
  get isWorknote(): boolean {
    return this._type === Enums.ContextItemType.WORKNOTE;
  }

  /**
   * Check if this is an audio recording container
   */
  get isAudioRecording(): boolean {
    return this._type === Enums.ContextItemType.AUDIO_RECORDING;
  }

  /**
   * Check if this is an attachment
   */
  get isAttachment(): boolean {
    return this._type === Enums.ContextItemType.ATTACHMENT;
  }

  /**
   * Check if this is a named entity container
   */
  get isNamedEntity(): boolean {
    return this._type === Enums.ContextItemType.NAMED_ENTITY;
  }

  /**
   * Check if source is AI-generated
   */
  get isAiGenerated(): boolean {
    return this._source === Enums.ContextItemSource.AI;
  }

  /**
   * Check if source is user-entered
   */
  get isUserEntered(): boolean {
    return this._source === Enums.ContextItemSource.USER;
  }

  /**
   * Check if source is from transcription service
   */
  get isFromTranscription(): boolean {
    return this._source === Enums.ContextItemSource.TRANSCRIPTION;
  }

  /**
   * Check if source is system-generated
   */
  get isSystemGenerated(): boolean {
    return this._source === Enums.ContextItemSource.SYSTEM;
  }

  /**
   * Check if this item has been synced to Qdrant
   */
  get isSyncedToQdrant(): boolean {
    return this._qdrantSynced;
  }

  /**
   * Mark as synced to Qdrant
   */
  markQdrantSynced(): void {
    this._qdrantSynced = true;
    this._qdrantSyncedAt = new Date();
    this.setProperty('qdrantSynced', true);
    this.setProperty('qdrantSyncedAt', this._qdrantSyncedAt);
  }

  /**
   * Mark as needing re-sync to Qdrant (after content update)
   */
  markQdrantNeedsSync(): void {
    this._qdrantSynced = false;
    this.setProperty('qdrantSynced', false);
  }

  /**
   * Increment the current version number (called after creating a version snapshot)
   */
  incrementVersion(): void {
    this._currentVersionNumber += 1;
    this.setProperty('currentVersionNumber', this._currentVersionNumber);
  }

  /**
   * Check if content requires text (non-media types)
   */
  get requiresContent(): boolean {
    return this._type !== Enums.ContextItemType.AUDIO_RECORDING && this._type !== Enums.ContextItemType.ATTACHMENT;
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!this._type) {
      throw new BusinessException('Type is required');
    }
    // Content is required for text-based types
    if (!this._content && this.requiresContent) {
      throw new BusinessException('Content is required for text-based context item types');
    }
    if (!this._source) {
      throw new BusinessException('Source is required');
    }
  }
}
