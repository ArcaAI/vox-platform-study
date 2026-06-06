/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IGoldenCaseEntity extends IBaseTenantEntity {
  goldenSetId: string;
  label?: string | null;
  transcript: string;
  referenceNote: string;
}

export class GoldenCaseEntity extends BaseTenantEntity {
  private _goldenSetId: IGoldenCaseEntity['goldenSetId'];
  private _label?: IGoldenCaseEntity['label'];
  private _transcript: IGoldenCaseEntity['transcript'];
  private _referenceNote: IGoldenCaseEntity['referenceNote'];

  constructor(init: IGoldenCaseEntity) {
    super(init);
    this._goldenSetId = init.goldenSetId;
    this._label = init.label;
    this._transcript = init.transcript;
    this._referenceNote = init.referenceNote;
  }

  get goldenSetId(): IGoldenCaseEntity['goldenSetId'] {
    return this._goldenSetId;
  }

  set goldenSetId(value: IGoldenCaseEntity['goldenSetId']) {
    this.setProperty('goldenSetId', value);
  }

  get label(): IGoldenCaseEntity['label'] {
    return this._label;
  }

  set label(value: IGoldenCaseEntity['label']) {
    this.setProperty('label', value);
  }

  get transcript(): IGoldenCaseEntity['transcript'] {
    return this._transcript;
  }

  set transcript(value: IGoldenCaseEntity['transcript']) {
    this.setProperty('transcript', value);
  }

  get referenceNote(): IGoldenCaseEntity['referenceNote'] {
    return this._referenceNote;
  }

  set referenceNote(value: IGoldenCaseEntity['referenceNote']) {
    this.setProperty('referenceNote', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._goldenSetId) {
      throw new BusinessException('GoldenCase goldenSetId is required.');
    }
    if (!this._transcript || this._transcript.trim().length === 0) {
      throw new BusinessException('GoldenCase transcript is required.');
    }
    if (!this._referenceNote || this._referenceNote.trim().length === 0) {
      throw new BusinessException('GoldenCase referenceNote is required.');
    }
  }
}
