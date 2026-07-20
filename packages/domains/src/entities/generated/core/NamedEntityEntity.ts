/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

export interface INamedEntityEntity extends IBaseTenantEntity {
  contextItemId: string;
  text: string;
  className: string;
  normalizedText?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  // negation/assertion polarity (PRESENT|ABSENT|HISTORICAL|FAMILY|HYPOTHETICAL).
  assertion?: string | null;
  confidence?: number | null;
  aiModelId?: string | null;
  aiModelVersion?: string | null;
  processingTimeMs?: number | null;
  metadata?: JsonValue | null;
  // TASK-369 Phase 3C — Vault-Transit (hope-phi) ciphertext of the recognized
  // span (text / normalizedText) + metadata JSONB + shared key version.
  // Phase 6 dropped the plaintext columns; plaintext survives only as transient
  // fields repopulated by decrypt-on-read.
  encryptedText?: Buffer | null;
  encryptedNormalizedText?: Buffer | null;
  encryptedMetadata?: Buffer | null;
  keyVersion?: number | null;
  // TASK-330 Phase 1 — clinical ontology normalization codes
  umlsCui?: string | null;
  snomedCode?: string | null;
  rxnormCode?: string | null;
  icdCode?: string | null;
  loincCode?: string | null;
  // TASK-330 Phase 1 — transcript-span provenance
  transcriptContextItemId?: string | null;
  transcriptStartOffset?: number | null;
  transcriptEndOffset?: number | null;
  ContextItem?: Entities.ContextItemEntity | null;
}

export class NamedEntityEntity extends BaseTenantEntity {
  private _contextItemId: INamedEntityEntity['contextItemId'];
  private _text: INamedEntityEntity['text'];
  private _className: INamedEntityEntity['className'];
  private _normalizedText?: INamedEntityEntity['normalizedText'];
  private _startOffset?: INamedEntityEntity['startOffset'];
  private _endOffset?: INamedEntityEntity['endOffset'];
  private _assertion?: INamedEntityEntity['assertion'];
  private _confidence?: INamedEntityEntity['confidence'];
  private _aiModelId?: INamedEntityEntity['aiModelId'];
  private _aiModelVersion?: INamedEntityEntity['aiModelVersion'];
  private _processingTimeMs?: INamedEntityEntity['processingTimeMs'];
  private _metadata?: INamedEntityEntity['metadata'];
  private _encryptedText?: INamedEntityEntity['encryptedText'];
  private _encryptedNormalizedText?: INamedEntityEntity['encryptedNormalizedText'];
  private _encryptedMetadata?: INamedEntityEntity['encryptedMetadata'];
  private _keyVersion?: INamedEntityEntity['keyVersion'];
  private _umlsCui?: INamedEntityEntity['umlsCui'];
  private _snomedCode?: INamedEntityEntity['snomedCode'];
  private _rxnormCode?: INamedEntityEntity['rxnormCode'];
  private _icdCode?: INamedEntityEntity['icdCode'];
  private _loincCode?: INamedEntityEntity['loincCode'];
  private _transcriptContextItemId?: INamedEntityEntity['transcriptContextItemId'];
  private _transcriptStartOffset?: INamedEntityEntity['transcriptStartOffset'];
  private _transcriptEndOffset?: INamedEntityEntity['transcriptEndOffset'];
  private _ContextItem?: INamedEntityEntity['ContextItem'];

  constructor(init: INamedEntityEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._text = init.text;
    this._className = init.className;
    this._normalizedText = init.normalizedText;
    this._startOffset = init.startOffset;
    this._endOffset = init.endOffset;
    this._assertion = init.assertion;
    this._confidence = init.confidence;
    this._aiModelId = init.aiModelId;
    this._aiModelVersion = init.aiModelVersion;
    this._processingTimeMs = init.processingTimeMs;
    this._metadata = init.metadata;
    this._encryptedText = init.encryptedText;
    this._encryptedNormalizedText = init.encryptedNormalizedText;
    this._encryptedMetadata = init.encryptedMetadata;
    this._keyVersion = init.keyVersion;
    this._umlsCui = init.umlsCui;
    this._snomedCode = init.snomedCode;
    this._rxnormCode = init.rxnormCode;
    this._icdCode = init.icdCode;
    this._loincCode = init.loincCode;
    this._transcriptContextItemId = init.transcriptContextItemId;
    this._transcriptStartOffset = init.transcriptStartOffset;
    this._transcriptEndOffset = init.transcriptEndOffset;
    this._ContextItem = init.ContextItem;
  }

  get contextItemId(): INamedEntityEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: INamedEntityEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  // TASK-369 Phase 3C — recognized span is free-text clinical PHI. @Secret()
  // marks it for audit-log redaction.
  @Secret()
  get text(): INamedEntityEntity['text'] {
    return this._text;
  }

  set text(value: INamedEntityEntity['text']) {
    this.setProperty('text', value);
  }

  get className(): INamedEntityEntity['className'] {
    return this._className;
  }

  set className(value: INamedEntityEntity['className']) {
    this.setProperty('className', value);
  }

  @Secret()
  get normalizedText(): INamedEntityEntity['normalizedText'] {
    return this._normalizedText;
  }

  set normalizedText(value: INamedEntityEntity['normalizedText']) {
    this.setProperty('normalizedText', value);
  }

  get startOffset(): INamedEntityEntity['startOffset'] {
    return this._startOffset;
  }

  set startOffset(value: INamedEntityEntity['startOffset']) {
    this.setProperty('startOffset', value);
  }

  get endOffset(): INamedEntityEntity['endOffset'] {
    return this._endOffset;
  }

  set endOffset(value: INamedEntityEntity['endOffset']) {
    this.setProperty('endOffset', value);
  }

  // negation/assertion polarity. Read as PRESENT when null.
  get assertion(): INamedEntityEntity['assertion'] {
    return this._assertion;
  }

  set assertion(value: INamedEntityEntity['assertion']) {
    this.setProperty('assertion', value);
  }

  get confidence(): INamedEntityEntity['confidence'] {
    return this._confidence;
  }

  set confidence(value: INamedEntityEntity['confidence']) {
    this.setProperty('confidence', value);
  }

  get aiModelId(): INamedEntityEntity['aiModelId'] {
    return this._aiModelId;
  }

  set aiModelId(value: INamedEntityEntity['aiModelId']) {
    this.setProperty('aiModelId', value);
  }

  get aiModelVersion(): INamedEntityEntity['aiModelVersion'] {
    return this._aiModelVersion;
  }

  set aiModelVersion(value: INamedEntityEntity['aiModelVersion']) {
    this.setProperty('aiModelVersion', value);
  }

  get processingTimeMs(): INamedEntityEntity['processingTimeMs'] {
    return this._processingTimeMs;
  }

  set processingTimeMs(value: INamedEntityEntity['processingTimeMs']) {
    this.setProperty('processingTimeMs', value);
  }

  @Secret()
  get metadata(): INamedEntityEntity['metadata'] {
    return this._metadata;
  }

  set metadata(value: INamedEntityEntity['metadata']) {
    this.setProperty('metadata', value);
  }

  // TASK-369 Phase 3C — Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedText(): INamedEntityEntity['encryptedText'] {
    return this._encryptedText;
  }

  set encryptedText(value: INamedEntityEntity['encryptedText']) {
    this.setProperty('encryptedText', value);
  }

  @Secret()
  get encryptedNormalizedText(): INamedEntityEntity['encryptedNormalizedText'] {
    return this._encryptedNormalizedText;
  }

  set encryptedNormalizedText(value: INamedEntityEntity['encryptedNormalizedText']) {
    this.setProperty('encryptedNormalizedText', value);
  }

  @Secret()
  get encryptedMetadata(): INamedEntityEntity['encryptedMetadata'] {
    return this._encryptedMetadata;
  }

  set encryptedMetadata(value: INamedEntityEntity['encryptedMetadata']) {
    this.setProperty('encryptedMetadata', value);
  }

  get keyVersion(): INamedEntityEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: INamedEntityEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get umlsCui(): INamedEntityEntity['umlsCui'] {
    return this._umlsCui;
  }

  set umlsCui(value: INamedEntityEntity['umlsCui']) {
    this.setProperty('umlsCui', value);
  }

  get snomedCode(): INamedEntityEntity['snomedCode'] {
    return this._snomedCode;
  }

  set snomedCode(value: INamedEntityEntity['snomedCode']) {
    this.setProperty('snomedCode', value);
  }

  get rxnormCode(): INamedEntityEntity['rxnormCode'] {
    return this._rxnormCode;
  }

  set rxnormCode(value: INamedEntityEntity['rxnormCode']) {
    this.setProperty('rxnormCode', value);
  }

  get icdCode(): INamedEntityEntity['icdCode'] {
    return this._icdCode;
  }

  set icdCode(value: INamedEntityEntity['icdCode']) {
    this.setProperty('icdCode', value);
  }

  get loincCode(): INamedEntityEntity['loincCode'] {
    return this._loincCode;
  }

  set loincCode(value: INamedEntityEntity['loincCode']) {
    this.setProperty('loincCode', value);
  }

  get transcriptContextItemId(): INamedEntityEntity['transcriptContextItemId'] {
    return this._transcriptContextItemId;
  }

  set transcriptContextItemId(value: INamedEntityEntity['transcriptContextItemId']) {
    this.setProperty('transcriptContextItemId', value);
  }

  get transcriptStartOffset(): INamedEntityEntity['transcriptStartOffset'] {
    return this._transcriptStartOffset;
  }

  set transcriptStartOffset(value: INamedEntityEntity['transcriptStartOffset']) {
    this.setProperty('transcriptStartOffset', value);
  }

  get transcriptEndOffset(): INamedEntityEntity['transcriptEndOffset'] {
    return this._transcriptEndOffset;
  }

  set transcriptEndOffset(value: INamedEntityEntity['transcriptEndOffset']) {
    this.setProperty('transcriptEndOffset', value);
  }

  get ContextItem(): INamedEntityEntity['ContextItem'] {
    return this._ContextItem;
  }

  set ContextItem(value: INamedEntityEntity['ContextItem']) {
    this.setProperty('ContextItem', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Common entity class names for medical NER
   */
  static readonly CLASS_MEDICATION = 'MEDICATION';
  static readonly CLASS_CONDITION = 'CONDITION';
  static readonly CLASS_PROCEDURE = 'PROCEDURE';
  static readonly CLASS_ANATOMY = 'ANATOMY';
  static readonly CLASS_SYMPTOM = 'SYMPTOM';
  static readonly CLASS_DOSAGE = 'DOSAGE';
  static readonly CLASS_FREQUENCY = 'FREQUENCY';
  static readonly CLASS_DURATION = 'DURATION';

  /**
   * Check if this is a medication entity
   */
  get isMedication(): boolean {
    return this._className === NamedEntityEntity.CLASS_MEDICATION;
  }

  /**
   * Check if this is a condition/diagnosis entity
   */
  get isCondition(): boolean {
    return this._className === NamedEntityEntity.CLASS_CONDITION;
  }

  /**
   * Check if this is a procedure entity
   */
  get isProcedure(): boolean {
    return this._className === NamedEntityEntity.CLASS_PROCEDURE;
  }

  /**
   * Check if this is an anatomy entity
   */
  get isAnatomy(): boolean {
    return this._className === NamedEntityEntity.CLASS_ANATOMY;
  }

  /**
   * Check if confidence is high (>= 0.8)
   */
  get isHighConfidence(): boolean {
    return (this._confidence ?? 0) >= 0.8;
  }

  /**
   * Check if confidence is medium (>= 0.5 and < 0.8)
   */
  get isMediumConfidence(): boolean {
    const conf = this._confidence ?? 0;
    return conf >= 0.5 && conf < 0.8;
  }

  /**
   * Check if confidence is low (< 0.5)
   */
  get isLowConfidence(): boolean {
    return (this._confidence ?? 0) < 0.5;
  }

  /**
   * Check if this entity has location information
   */
  get hasLocation(): boolean {
    return this._startOffset !== null && this._endOffset !== null;
  }

  /**
   * Get the text span length
   */
  get spanLength(): number | null {
    if (this._startOffset === null || this._endOffset === null) return null;
    return (this._endOffset ?? 0) - (this._startOffset ?? 0);
  }

  /**
   * Get display text (normalized if available, otherwise original)
   */
  get displayText(): string {
    return this._normalizedText ?? this._text;
  }

  /**
   * TASK-330 Phase 1 — true when at least one clinical ontology code is set
   * (UMLS / SNOMED / RxNorm / ICD / LOINC). Used by entity-faithfulness scoring
   * and coded list generation.
   */
  get hasOntologyCodes(): boolean {
    return !!(this._umlsCui || this._snomedCode || this._rxnormCode || this._icdCode || this._loincCode);
  }

  /**
   * TASK-330 Phase 1 — true when this entity carries a transcript-span
   * provenance pointer (so summaries can cite the source offsets).
   */
  get hasTranscriptSpan(): boolean {
    return (
      this._transcriptContextItemId != null &&
      this._transcriptStartOffset != null &&
      this._transcriptEndOffset != null
    );
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId) {
      throw new BusinessException('Context item ID is required');
    }
    if (!this._text) {
      throw new BusinessException('Text is required');
    }
    if (!this._className) {
      throw new BusinessException('Class name is required');
    }
    if (this._confidence !== null && this._confidence !== undefined) {
      if (this._confidence < 0 || this._confidence > 1) {
        throw new BusinessException('Confidence must be between 0 and 1');
      }
    }
  }
}
