/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IContextItemEntity extends IBaseTenantEntity {
  consultationId: string;
  type: Enums.ContextItemType;
  source: Enums.ContextItemSource;
  currentVersionNumber: number;
  content?: string | null;
  // Vault-Transit (hope-phi)
  // ciphertext of `content` plus the Transit key version. Both nullable.
  // The plaintext `content` column was dropped; `content` survives
  // only as a transient field repopulated by repository decrypt-on-read.
  encryptedContent?: Buffer | null;
  contentKeyVersion?: number | null;
  /** TASK-999 — plaintext word count of `content`, measured once at write time. NULL = never measured; 0 is a real empty body. */
  contentWordCount?: number | null;
  /** TASK-999 — plaintext character count of `content`, measured once at write time. NULL = never measured; 0 is a real empty body. */
  contentCharCount?: number | null;
  mediaId?: string | null;
  dnaWritingStyleId?: string | null;
  // Tenant-facing context-kind discriminator layered above `type`.
  // `kindKey` names the kind declared by the tenant's pinned
  // ConsultationContextSchemaVersion; `contextSchemaVersionId` records WHICH
  // immutable version this row was validated against, captured at write time
  // so a later publish can never retroactively invalidate an accepted item.
  // Both null for every write that names no kind — i.e. every historical
  // caller.
  kindKey?: string | null;
  contextSchemaVersionId?: string | null;
  //  — WHICH clinical document this item belongs to, layered
  // above `type` exactly as `kindKey` is. Null for every write that names no
  // document, i.e. every historical caller.
  documentKey?: string | null;
  // Consultation record model: the encounter the item belongs to; for TRANSCRIPT_SEGMENT
  // items the consultation-wide segmentSeq, the idempotency key segmentKey
  // ("<sttSessionId>:<utteranceIndex>"), the recording-timeline span t0Ms/t1Ms, speaker
  // and capture time. occurredAt is the clinical time (timeline sort key).
  encounterSeq?: number | null;
  segmentSeq?: number | null;
  segmentKey?: string | null;
  t0Ms?: number | null;
  t1Ms?: number | null;
  speaker?: string | null;
  capturedAt?: Date | null;
  occurredAt?: Date;
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
  private _encryptedContent?: IContextItemEntity['encryptedContent'];
  private _contentKeyVersion?: IContextItemEntity['contentKeyVersion'];
  private _contentWordCount?: IContextItemEntity['contentWordCount'];
  private _contentCharCount?: IContextItemEntity['contentCharCount'];
  private _mediaId?: IContextItemEntity['mediaId'];
  private _dnaWritingStyleId?: IContextItemEntity['dnaWritingStyleId'];
  private _kindKey?: IContextItemEntity['kindKey'];
  private _documentKey?: IContextItemEntity['documentKey'];
  private _encounterSeq?: IContextItemEntity['encounterSeq'];
  private _segmentSeq?: IContextItemEntity['segmentSeq'];
  private _segmentKey?: IContextItemEntity['segmentKey'];
  private _t0Ms?: IContextItemEntity['t0Ms'];
  private _t1Ms?: IContextItemEntity['t1Ms'];
  private _speaker?: IContextItemEntity['speaker'];
  private _capturedAt?: IContextItemEntity['capturedAt'];
  private _occurredAt?: IContextItemEntity['occurredAt'];
  private _contextSchemaVersionId?: IContextItemEntity['contextSchemaVersionId'];
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
    this._encryptedContent = init.encryptedContent;
    this._contentKeyVersion = init.contentKeyVersion;
    this._contentWordCount = init.contentWordCount;
    this._contentCharCount = init.contentCharCount;
    this._mediaId = init.mediaId;
    this._dnaWritingStyleId = init.dnaWritingStyleId;
    this._kindKey = init.kindKey;
    this._documentKey = init.documentKey;
    this._encounterSeq = init.encounterSeq;
    this._segmentSeq = init.segmentSeq;
    this._segmentKey = init.segmentKey;
    this._t0Ms = init.t0Ms;
    this._t1Ms = init.t1Ms;
    this._speaker = init.speaker;
    this._capturedAt = init.capturedAt;
    this._occurredAt = init.occurredAt;
    this._contextSchemaVersionId = init.contextSchemaVersionId;
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

  // `content` is free-text clinical PHI. @Secret() marks
  // it for audit-log redaction (defense-in-depth) and documents it as the
  // plaintext counterpart of the encrypted column.
  @Secret()
  get content(): IContextItemEntity['content'] {
    return this._content;
  }

  set content(value: IContextItemEntity['content']) {
    this.setProperty('content', value);
  }

  // Vault-Transit ciphertext of `content`. @Secret()
  // guards it from audit-log surfaces (leaking ciphertext + keyVersion helps
  // an attacker correlate confidential rows).
  @Secret()
  get encryptedContent(): IContextItemEntity['encryptedContent'] {
    return this._encryptedContent;
  }

  set encryptedContent(value: IContextItemEntity['encryptedContent']) {
    this.setProperty('encryptedContent', value);
  }

  get contentKeyVersion(): IContextItemEntity['contentKeyVersion'] {
    return this._contentKeyVersion;
  }

  set contentKeyVersion(value: IContextItemEntity['contentKeyVersion']) {
    this.setProperty('contentKeyVersion', value);
  }

  get contentWordCount(): IContextItemEntity['contentWordCount'] {
    return this._contentWordCount;
  }

  set contentWordCount(value: IContextItemEntity['contentWordCount']) {
    this.setProperty('contentWordCount', value);
  }

  get contentCharCount(): IContextItemEntity['contentCharCount'] {
    return this._contentCharCount;
  }

  set contentCharCount(value: IContextItemEntity['contentCharCount']) {
    this.setProperty('contentCharCount', value);
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

  get kindKey(): IContextItemEntity['kindKey'] {
    return this._kindKey;
  }

  set kindKey(value: IContextItemEntity['kindKey']) {
    this.setProperty('kindKey', value);
  }

  get documentKey(): IContextItemEntity['documentKey'] {
    return this._documentKey;
  }

  set documentKey(value: IContextItemEntity['documentKey']) {
    this.setProperty('documentKey', value);
  }

  get encounterSeq(): IContextItemEntity['encounterSeq'] {
    return this._encounterSeq;
  }

  set encounterSeq(value: IContextItemEntity['encounterSeq']) {
    this.setProperty('encounterSeq', value);
  }

  get segmentSeq(): IContextItemEntity['segmentSeq'] {
    return this._segmentSeq;
  }

  set segmentSeq(value: IContextItemEntity['segmentSeq']) {
    this.setProperty('segmentSeq', value);
  }

  get segmentKey(): IContextItemEntity['segmentKey'] {
    return this._segmentKey;
  }

  set segmentKey(value: IContextItemEntity['segmentKey']) {
    this.setProperty('segmentKey', value);
  }

  get t0Ms(): IContextItemEntity['t0Ms'] {
    return this._t0Ms;
  }

  set t0Ms(value: IContextItemEntity['t0Ms']) {
    this.setProperty('t0Ms', value);
  }

  get t1Ms(): IContextItemEntity['t1Ms'] {
    return this._t1Ms;
  }

  set t1Ms(value: IContextItemEntity['t1Ms']) {
    this.setProperty('t1Ms', value);
  }

  get speaker(): IContextItemEntity['speaker'] {
    return this._speaker;
  }

  set speaker(value: IContextItemEntity['speaker']) {
    this.setProperty('speaker', value);
  }

  get capturedAt(): IContextItemEntity['capturedAt'] {
    return this._capturedAt;
  }

  set capturedAt(value: IContextItemEntity['capturedAt']) {
    this.setProperty('capturedAt', value);
  }

  get occurredAt(): IContextItemEntity['occurredAt'] {
    return this._occurredAt;
  }

  set occurredAt(value: IContextItemEntity['occurredAt']) {
    this.setProperty('occurredAt', value);
  }

  get contextSchemaVersionId(): IContextItemEntity['contextSchemaVersionId'] {
    return this._contextSchemaVersionId;
  }

  set contextSchemaVersionId(value: IContextItemEntity['contextSchemaVersionId']) {
    this.setProperty('contextSchemaVersionId', value);
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
    this.setProperty('qdrantSynced', true);
    this.setProperty('qdrantSyncedAt', new Date());
  }

  /**
   * Mark as needing re-sync to Qdrant (after content update)
   */
  markQdrantNeedsSync(): void {
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
