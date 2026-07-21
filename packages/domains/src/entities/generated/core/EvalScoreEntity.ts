/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IEvalScoreEntity extends IBaseTenantEntity {
  evalRunId: string;
  goldenCaseId: string;
  metric: string;
  score: number;
  maxScore?: number | null;
  rationale?: string | null;
  judgeModel?: string | null;
  details?: JsonValue | null;
  // Vault-Transit (hope-phi) ciphertext of the free-text
  // clinical fields + shared key version. Phase 6 dropped the plaintext columns;
  // plaintext survives only as transient fields repopulated by decrypt-on-read.
  encryptedRationale?: Buffer | null;
  encryptedDetails?: Buffer | null;
  keyVersion?: number | null;
}

export class EvalScoreEntity extends BaseTenantEntity {
  private _evalRunId: IEvalScoreEntity['evalRunId'];
  private _goldenCaseId: IEvalScoreEntity['goldenCaseId'];
  private _metric: IEvalScoreEntity['metric'];
  private _score: IEvalScoreEntity['score'];
  private _maxScore?: IEvalScoreEntity['maxScore'];
  private _rationale?: IEvalScoreEntity['rationale'];
  private _judgeModel?: IEvalScoreEntity['judgeModel'];
  private _details?: IEvalScoreEntity['details'];
  private _encryptedRationale?: IEvalScoreEntity['encryptedRationale'];
  private _encryptedDetails?: IEvalScoreEntity['encryptedDetails'];
  private _keyVersion?: IEvalScoreEntity['keyVersion'];

  constructor(init: IEvalScoreEntity) {
    super(init);
    this._evalRunId = init.evalRunId;
    this._goldenCaseId = init.goldenCaseId;
    this._metric = init.metric;
    this._score = init.score;
    this._maxScore = init.maxScore;
    this._rationale = init.rationale;
    this._judgeModel = init.judgeModel;
    this._details = init.details;
    this._encryptedRationale = init.encryptedRationale;
    this._encryptedDetails = init.encryptedDetails;
    this._keyVersion = init.keyVersion;
  }

  get evalRunId(): IEvalScoreEntity['evalRunId'] {
    return this._evalRunId;
  }

  set evalRunId(value: IEvalScoreEntity['evalRunId']) {
    this.setProperty('evalRunId', value);
  }

  get goldenCaseId(): IEvalScoreEntity['goldenCaseId'] {
    return this._goldenCaseId;
  }

  set goldenCaseId(value: IEvalScoreEntity['goldenCaseId']) {
    this.setProperty('goldenCaseId', value);
  }

  get metric(): IEvalScoreEntity['metric'] {
    return this._metric;
  }

  set metric(value: IEvalScoreEntity['metric']) {
    this.setProperty('metric', value);
  }

  get score(): IEvalScoreEntity['score'] {
    return this._score;
  }

  set score(value: IEvalScoreEntity['score']) {
    this.setProperty('score', value);
  }

  get maxScore(): IEvalScoreEntity['maxScore'] {
    return this._maxScore;
  }

  set maxScore(value: IEvalScoreEntity['maxScore']) {
    this.setProperty('maxScore', value);
  }

  // Free-text clinical PHI. @Secret() marks it for
  // audit-log redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get rationale(): IEvalScoreEntity['rationale'] {
    return this._rationale;
  }

  set rationale(value: IEvalScoreEntity['rationale']) {
    this.setProperty('rationale', value);
  }

  get judgeModel(): IEvalScoreEntity['judgeModel'] {
    return this._judgeModel;
  }

  set judgeModel(value: IEvalScoreEntity['judgeModel']) {
    this.setProperty('judgeModel', value);
  }

  @Secret()
  get details(): IEvalScoreEntity['details'] {
    return this._details;
  }

  set details(value: IEvalScoreEntity['details']) {
    this.setProperty('details', value);
  }

  // Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedRationale(): IEvalScoreEntity['encryptedRationale'] {
    return this._encryptedRationale;
  }

  set encryptedRationale(value: IEvalScoreEntity['encryptedRationale']) {
    this.setProperty('encryptedRationale', value);
  }

  @Secret()
  get encryptedDetails(): IEvalScoreEntity['encryptedDetails'] {
    return this._encryptedDetails;
  }

  set encryptedDetails(value: IEvalScoreEntity['encryptedDetails']) {
    this.setProperty('encryptedDetails', value);
  }

  get keyVersion(): IEvalScoreEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IEvalScoreEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._evalRunId) {
      throw new BusinessException('EvalScore evalRunId is required.');
    }
    if (!this._goldenCaseId) {
      throw new BusinessException('EvalScore goldenCaseId is required.');
    }
    if (!this._metric || this._metric.trim().length === 0) {
      throw new BusinessException('EvalScore metric is required.');
    }
    if (this._score === undefined || this._score === null || Number.isNaN(this._score)) {
      throw new BusinessException('EvalScore score is required and must be a number.');
    }
  }
}
