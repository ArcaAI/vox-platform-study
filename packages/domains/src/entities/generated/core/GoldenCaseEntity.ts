/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IGoldenCaseEntity extends IBaseTenantEntity {
  goldenSetId: string;
  label?: string | null;
  transcript: string;
  referenceNote: string;
  // TASK-369 Phase 3C — Vault-Transit (hope-phi) ciphertext of the free-text
  // clinical fields + shared key version. Plaintext columns retained for the
  // dual-read soak (removal is Phase 6).
  encryptedTranscript?: Buffer | null;
  encryptedReferenceNote?: Buffer | null;
  keyVersion?: number | null;
}

export class GoldenCaseEntity extends BaseTenantEntity {
  private _goldenSetId: IGoldenCaseEntity['goldenSetId'];
  private _label?: IGoldenCaseEntity['label'];
  private _transcript: IGoldenCaseEntity['transcript'];
  private _referenceNote: IGoldenCaseEntity['referenceNote'];
  private _encryptedTranscript?: IGoldenCaseEntity['encryptedTranscript'];
  private _encryptedReferenceNote?: IGoldenCaseEntity['encryptedReferenceNote'];
  private _keyVersion?: IGoldenCaseEntity['keyVersion'];

  constructor(init: IGoldenCaseEntity) {
    super(init);
    this._goldenSetId = init.goldenSetId;
    this._label = init.label;
    this._transcript = init.transcript;
    this._referenceNote = init.referenceNote;
    this._encryptedTranscript = init.encryptedTranscript;
    this._encryptedReferenceNote = init.encryptedReferenceNote;
    this._keyVersion = init.keyVersion;
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

  // TASK-369 Phase 3C — free-text clinical PHI. @Secret() marks it for
  // audit-log redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get transcript(): IGoldenCaseEntity['transcript'] {
    return this._transcript;
  }

  set transcript(value: IGoldenCaseEntity['transcript']) {
    this.setProperty('transcript', value);
  }

  @Secret()
  get referenceNote(): IGoldenCaseEntity['referenceNote'] {
    return this._referenceNote;
  }

  set referenceNote(value: IGoldenCaseEntity['referenceNote']) {
    this.setProperty('referenceNote', value);
  }

  // TASK-369 Phase 3C — Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedTranscript(): IGoldenCaseEntity['encryptedTranscript'] {
    return this._encryptedTranscript;
  }

  set encryptedTranscript(value: IGoldenCaseEntity['encryptedTranscript']) {
    this.setProperty('encryptedTranscript', value);
  }

  @Secret()
  get encryptedReferenceNote(): IGoldenCaseEntity['encryptedReferenceNote'] {
    return this._encryptedReferenceNote;
  }

  set encryptedReferenceNote(value: IGoldenCaseEntity['encryptedReferenceNote']) {
    this.setProperty('encryptedReferenceNote', value);
  }

  get keyVersion(): IGoldenCaseEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IGoldenCaseEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
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
