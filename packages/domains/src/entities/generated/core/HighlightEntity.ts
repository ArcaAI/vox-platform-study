/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import * as Enums from '../../../enums';

export interface IHighlightEntity extends IBaseTenantEntity {
  consultationId: string;
  sourceContextItemId?: string | null;
  targetKind: Enums.HighlightTargetKind;
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  startOffset: number;
  endOffset: number;
  color?: string | null;
  label?: string | null;
  note?: string | null;
  // TASK-369 Phase 3C — Vault-Transit (hope-phi) ciphertext of the quote
  // selectors + note + shared key version. Phase 6 dropped the plaintext
  // columns; plaintext survives only as transient fields repopulated by
  // decrypt-on-read.
  encryptedExact?: Buffer | null;
  encryptedPrefix?: Buffer | null;
  encryptedSuffix?: Buffer | null;
  encryptedNote?: Buffer | null;
  keyVersion?: number | null;
}

export class HighlightEntity extends BaseTenantEntity {
  private _consultationId: IHighlightEntity['consultationId'];
  private _sourceContextItemId?: IHighlightEntity['sourceContextItemId'];
  private _targetKind: IHighlightEntity['targetKind'];
  private _exact: IHighlightEntity['exact'];
  private _prefix?: IHighlightEntity['prefix'];
  private _suffix?: IHighlightEntity['suffix'];
  private _startOffset: IHighlightEntity['startOffset'];
  private _endOffset: IHighlightEntity['endOffset'];
  private _color?: IHighlightEntity['color'];
  private _label?: IHighlightEntity['label'];
  private _note?: IHighlightEntity['note'];
  private _encryptedExact?: IHighlightEntity['encryptedExact'];
  private _encryptedPrefix?: IHighlightEntity['encryptedPrefix'];
  private _encryptedSuffix?: IHighlightEntity['encryptedSuffix'];
  private _encryptedNote?: IHighlightEntity['encryptedNote'];
  private _keyVersion?: IHighlightEntity['keyVersion'];

  constructor(init: IHighlightEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._sourceContextItemId = init.sourceContextItemId;
    this._targetKind = init.targetKind;
    this._exact = init.exact;
    this._prefix = init.prefix;
    this._suffix = init.suffix;
    this._startOffset = init.startOffset;
    this._endOffset = init.endOffset;
    this._color = init.color;
    this._label = init.label;
    this._note = init.note;
    this._encryptedExact = init.encryptedExact;
    this._encryptedPrefix = init.encryptedPrefix;
    this._encryptedSuffix = init.encryptedSuffix;
    this._encryptedNote = init.encryptedNote;
    this._keyVersion = init.keyVersion;
  }

  get consultationId(): IHighlightEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IHighlightEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get sourceContextItemId(): IHighlightEntity['sourceContextItemId'] {
    return this._sourceContextItemId;
  }

  set sourceContextItemId(value: IHighlightEntity['sourceContextItemId']) {
    this.setProperty('sourceContextItemId', value);
  }

  get targetKind(): IHighlightEntity['targetKind'] {
    return this._targetKind;
  }

  set targetKind(value: IHighlightEntity['targetKind']) {
    this.setProperty('targetKind', value);
  }

  // TASK-369 Phase 3C — quote selectors + note are free-text clinical PHI.
  // @Secret() marks them for audit-log redaction.
  @Secret()
  get exact(): IHighlightEntity['exact'] {
    return this._exact;
  }

  set exact(value: IHighlightEntity['exact']) {
    this.setProperty('exact', value);
  }

  @Secret()
  get prefix(): IHighlightEntity['prefix'] {
    return this._prefix;
  }

  set prefix(value: IHighlightEntity['prefix']) {
    this.setProperty('prefix', value);
  }

  @Secret()
  get suffix(): IHighlightEntity['suffix'] {
    return this._suffix;
  }

  set suffix(value: IHighlightEntity['suffix']) {
    this.setProperty('suffix', value);
  }

  get startOffset(): IHighlightEntity['startOffset'] {
    return this._startOffset;
  }

  set startOffset(value: IHighlightEntity['startOffset']) {
    this.setProperty('startOffset', value);
  }

  get endOffset(): IHighlightEntity['endOffset'] {
    return this._endOffset;
  }

  set endOffset(value: IHighlightEntity['endOffset']) {
    this.setProperty('endOffset', value);
  }

  get color(): IHighlightEntity['color'] {
    return this._color;
  }

  set color(value: IHighlightEntity['color']) {
    this.setProperty('color', value);
  }

  get label(): IHighlightEntity['label'] {
    return this._label;
  }

  set label(value: IHighlightEntity['label']) {
    this.setProperty('label', value);
  }

  @Secret()
  get note(): IHighlightEntity['note'] {
    return this._note;
  }

  set note(value: IHighlightEntity['note']) {
    this.setProperty('note', value);
  }

  // TASK-369 Phase 3C — Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedExact(): IHighlightEntity['encryptedExact'] {
    return this._encryptedExact;
  }

  set encryptedExact(value: IHighlightEntity['encryptedExact']) {
    this.setProperty('encryptedExact', value);
  }

  @Secret()
  get encryptedPrefix(): IHighlightEntity['encryptedPrefix'] {
    return this._encryptedPrefix;
  }

  set encryptedPrefix(value: IHighlightEntity['encryptedPrefix']) {
    this.setProperty('encryptedPrefix', value);
  }

  @Secret()
  get encryptedSuffix(): IHighlightEntity['encryptedSuffix'] {
    return this._encryptedSuffix;
  }

  set encryptedSuffix(value: IHighlightEntity['encryptedSuffix']) {
    this.setProperty('encryptedSuffix', value);
  }

  @Secret()
  get encryptedNote(): IHighlightEntity['encryptedNote'] {
    return this._encryptedNote;
  }

  set encryptedNote(value: IHighlightEntity['encryptedNote']) {
    this.setProperty('encryptedNote', value);
  }

  get keyVersion(): IHighlightEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IHighlightEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Length of the anchored span. Derived from the TextPositionSelector
   * offsets (not from `exact`, which may have been normalized).
   */
  get spanLength(): number {
    return this._endOffset - this._startOffset;
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!this._targetKind) {
      throw new BusinessException('Target kind is required');
    }
    if (!this._exact || this._exact.trim().length === 0) {
      throw new BusinessException('Highlight exact text is required');
    }
    if (this._startOffset === null || this._startOffset === undefined || this._startOffset < 0) {
      throw new BusinessException('Highlight startOffset must be a non-negative integer');
    }
    if (this._endOffset === null || this._endOffset === undefined || this._endOffset < this._startOffset) {
      throw new BusinessException('Highlight endOffset must be greater than or equal to startOffset');
    }
  }
}
