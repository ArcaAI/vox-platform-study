/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
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

  get exact(): IHighlightEntity['exact'] {
    return this._exact;
  }

  set exact(value: IHighlightEntity['exact']) {
    this.setProperty('exact', value);
  }

  get prefix(): IHighlightEntity['prefix'] {
    return this._prefix;
  }

  set prefix(value: IHighlightEntity['prefix']) {
    this.setProperty('prefix', value);
  }

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

  get note(): IHighlightEntity['note'] {
    return this._note;
  }

  set note(value: IHighlightEntity['note']) {
    this.setProperty('note', value);
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
