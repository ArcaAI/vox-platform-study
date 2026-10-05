/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * One clinician feedback fact on a consultation or on a target inside it.
 * Append-only: a changed rating is a NEW row that supersedes the previous one
 * (`supersedesId`), and only the newest rated row per (tenant, actor,
 * targetKey) carries `isLatest`. The free-text comment persists only as
 * Vault-Transit (hope-phi) ciphertext (`encryptedComment` + `keyVersion`);
 * `comment` is the transient plaintext (see the repository encryption
 * sidecar). Provenance columns are ids / versions only.
 */
export interface IConsultationFeedbackEntity extends IBaseTenantEntity {
  consultationId: string;
  encounterSeq?: number | null;
  actorUserId: string;
  // jwt | api-key | service-account
  actorCredentialClass: string;
  actorPrincipalId?: string | null;
  clientApp?: string | null;
  clientSurface?: string | null;
  targetKind?: Enums.FeedbackTargetKind | null;
  targetContextItemId?: string | null;
  targetVersionNumber?: number | null;
  targetSectionKey?: string | null;
  targetDocumentKey?: string | null;
  targetEntityRef?: string | null;
  entityLabel?: string | null;
  // "kind|item|ver|section|entity"; null without a target
  targetKey?: string | null;
  rating?: Enums.FeedbackRating | null;
  reasonCodes?: string[];
  // Transient plaintext of `encryptedComment` (never persisted).
  comment?: string | null;
  encryptedComment?: Buffer | null;
  keyVersion?: number | null;
  mediaIds?: string[];
  correctionContextItemId?: string | null;
  correctionVersionNumber?: number | null;
  provenance?: JsonValue | null;
  provAgentSlug?: string | null;
  provAgentVersion?: number | null;
  provModelName?: string | null;
  provPromptVersion?: string | null;
  provWorkflowRunId?: string | null;
  provActivityRunId?: string | null;
  idempotencyKey?: string | null;
  isLatest?: boolean;
  supersedesId?: string | null;
}

export class ConsultationFeedbackEntity extends BaseTenantEntity {
  private _consultationId: IConsultationFeedbackEntity['consultationId'];
  private _encounterSeq?: IConsultationFeedbackEntity['encounterSeq'];
  private _actorUserId: IConsultationFeedbackEntity['actorUserId'];
  private _actorCredentialClass: IConsultationFeedbackEntity['actorCredentialClass'];
  private _actorPrincipalId?: IConsultationFeedbackEntity['actorPrincipalId'];
  private _clientApp?: IConsultationFeedbackEntity['clientApp'];
  private _clientSurface?: IConsultationFeedbackEntity['clientSurface'];
  private _targetKind?: IConsultationFeedbackEntity['targetKind'];
  private _targetContextItemId?: IConsultationFeedbackEntity['targetContextItemId'];
  private _targetVersionNumber?: IConsultationFeedbackEntity['targetVersionNumber'];
  private _targetSectionKey?: IConsultationFeedbackEntity['targetSectionKey'];
  private _targetDocumentKey?: IConsultationFeedbackEntity['targetDocumentKey'];
  private _targetEntityRef?: IConsultationFeedbackEntity['targetEntityRef'];
  private _entityLabel?: IConsultationFeedbackEntity['entityLabel'];
  private _targetKey?: IConsultationFeedbackEntity['targetKey'];
  private _rating?: IConsultationFeedbackEntity['rating'];
  private _reasonCodes: IConsultationFeedbackEntity['reasonCodes'];
  private _comment?: IConsultationFeedbackEntity['comment'];
  private _encryptedComment?: IConsultationFeedbackEntity['encryptedComment'];
  private _keyVersion?: IConsultationFeedbackEntity['keyVersion'];
  private _mediaIds: IConsultationFeedbackEntity['mediaIds'];
  private _correctionContextItemId?: IConsultationFeedbackEntity['correctionContextItemId'];
  private _correctionVersionNumber?: IConsultationFeedbackEntity['correctionVersionNumber'];
  private _provenance?: IConsultationFeedbackEntity['provenance'];
  private _provAgentSlug?: IConsultationFeedbackEntity['provAgentSlug'];
  private _provAgentVersion?: IConsultationFeedbackEntity['provAgentVersion'];
  private _provModelName?: IConsultationFeedbackEntity['provModelName'];
  private _provPromptVersion?: IConsultationFeedbackEntity['provPromptVersion'];
  private _provWorkflowRunId?: IConsultationFeedbackEntity['provWorkflowRunId'];
  private _provActivityRunId?: IConsultationFeedbackEntity['provActivityRunId'];
  private _idempotencyKey?: IConsultationFeedbackEntity['idempotencyKey'];
  private _isLatest: IConsultationFeedbackEntity['isLatest'];
  private _supersedesId?: IConsultationFeedbackEntity['supersedesId'];

  constructor(init: IConsultationFeedbackEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._encounterSeq = init.encounterSeq;
    this._actorUserId = init.actorUserId;
    this._actorCredentialClass = init.actorCredentialClass;
    this._actorPrincipalId = init.actorPrincipalId;
    this._clientApp = init.clientApp;
    this._clientSurface = init.clientSurface;
    this._targetKind = init.targetKind;
    this._targetContextItemId = init.targetContextItemId;
    this._targetVersionNumber = init.targetVersionNumber;
    this._targetSectionKey = init.targetSectionKey;
    this._targetDocumentKey = init.targetDocumentKey;
    this._targetEntityRef = init.targetEntityRef;
    this._entityLabel = init.entityLabel;
    this._targetKey = init.targetKey;
    this._rating = init.rating;
    this._reasonCodes = init.reasonCodes ?? [];
    this._comment = init.comment;
    this._encryptedComment = init.encryptedComment;
    this._keyVersion = init.keyVersion;
    this._mediaIds = init.mediaIds ?? [];
    this._correctionContextItemId = init.correctionContextItemId;
    this._correctionVersionNumber = init.correctionVersionNumber;
    this._provenance = init.provenance;
    this._provAgentSlug = init.provAgentSlug;
    this._provAgentVersion = init.provAgentVersion;
    this._provModelName = init.provModelName;
    this._provPromptVersion = init.provPromptVersion;
    this._provWorkflowRunId = init.provWorkflowRunId;
    this._provActivityRunId = init.provActivityRunId;
    this._idempotencyKey = init.idempotencyKey;
    this._isLatest = init.isLatest ?? true;
    this._supersedesId = init.supersedesId;
  }

  get consultationId(): IConsultationFeedbackEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IConsultationFeedbackEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get encounterSeq(): IConsultationFeedbackEntity['encounterSeq'] {
    return this._encounterSeq;
  }

  set encounterSeq(value: IConsultationFeedbackEntity['encounterSeq']) {
    this.setProperty('encounterSeq', value);
  }

  get actorUserId(): IConsultationFeedbackEntity['actorUserId'] {
    return this._actorUserId;
  }

  set actorUserId(value: IConsultationFeedbackEntity['actorUserId']) {
    this.setProperty('actorUserId', value);
  }

  get actorCredentialClass(): IConsultationFeedbackEntity['actorCredentialClass'] {
    return this._actorCredentialClass;
  }

  set actorCredentialClass(value: IConsultationFeedbackEntity['actorCredentialClass']) {
    this.setProperty('actorCredentialClass', value);
  }

  get actorPrincipalId(): IConsultationFeedbackEntity['actorPrincipalId'] {
    return this._actorPrincipalId;
  }

  set actorPrincipalId(value: IConsultationFeedbackEntity['actorPrincipalId']) {
    this.setProperty('actorPrincipalId', value);
  }

  get clientApp(): IConsultationFeedbackEntity['clientApp'] {
    return this._clientApp;
  }

  set clientApp(value: IConsultationFeedbackEntity['clientApp']) {
    this.setProperty('clientApp', value);
  }

  get clientSurface(): IConsultationFeedbackEntity['clientSurface'] {
    return this._clientSurface;
  }

  set clientSurface(value: IConsultationFeedbackEntity['clientSurface']) {
    this.setProperty('clientSurface', value);
  }

  get targetKind(): IConsultationFeedbackEntity['targetKind'] {
    return this._targetKind;
  }

  set targetKind(value: IConsultationFeedbackEntity['targetKind']) {
    this.setProperty('targetKind', value);
  }

  get targetContextItemId(): IConsultationFeedbackEntity['targetContextItemId'] {
    return this._targetContextItemId;
  }

  set targetContextItemId(value: IConsultationFeedbackEntity['targetContextItemId']) {
    this.setProperty('targetContextItemId', value);
  }

  get targetVersionNumber(): IConsultationFeedbackEntity['targetVersionNumber'] {
    return this._targetVersionNumber;
  }

  set targetVersionNumber(value: IConsultationFeedbackEntity['targetVersionNumber']) {
    this.setProperty('targetVersionNumber', value);
  }

  get targetSectionKey(): IConsultationFeedbackEntity['targetSectionKey'] {
    return this._targetSectionKey;
  }

  set targetSectionKey(value: IConsultationFeedbackEntity['targetSectionKey']) {
    this.setProperty('targetSectionKey', value);
  }

  get targetDocumentKey(): IConsultationFeedbackEntity['targetDocumentKey'] {
    return this._targetDocumentKey;
  }

  set targetDocumentKey(value: IConsultationFeedbackEntity['targetDocumentKey']) {
    this.setProperty('targetDocumentKey', value);
  }

  get targetEntityRef(): IConsultationFeedbackEntity['targetEntityRef'] {
    return this._targetEntityRef;
  }

  set targetEntityRef(value: IConsultationFeedbackEntity['targetEntityRef']) {
    this.setProperty('targetEntityRef', value);
  }

  get entityLabel(): IConsultationFeedbackEntity['entityLabel'] {
    return this._entityLabel;
  }

  set entityLabel(value: IConsultationFeedbackEntity['entityLabel']) {
    this.setProperty('entityLabel', value);
  }

  get targetKey(): IConsultationFeedbackEntity['targetKey'] {
    return this._targetKey;
  }

  set targetKey(value: IConsultationFeedbackEntity['targetKey']) {
    this.setProperty('targetKey', value);
  }

  get rating(): IConsultationFeedbackEntity['rating'] {
    return this._rating;
  }

  set rating(value: IConsultationFeedbackEntity['rating']) {
    this.setProperty('rating', value);
  }

  get reasonCodes(): IConsultationFeedbackEntity['reasonCodes'] {
    return this._reasonCodes;
  }

  set reasonCodes(value: IConsultationFeedbackEntity['reasonCodes']) {
    this.setProperty('reasonCodes', value);
  }

  // Free-text clinician comment (PHI-prone). Transient; persists only as ciphertext.
  @Secret()
  get comment(): IConsultationFeedbackEntity['comment'] {
    return this._comment;
  }

  set comment(value: IConsultationFeedbackEntity['comment']) {
    this.setProperty('comment', value);
  }

  // Vault-Transit ciphertext of `comment`.
  @Secret()
  get encryptedComment(): IConsultationFeedbackEntity['encryptedComment'] {
    return this._encryptedComment;
  }

  set encryptedComment(value: IConsultationFeedbackEntity['encryptedComment']) {
    this.setProperty('encryptedComment', value);
  }

  get keyVersion(): IConsultationFeedbackEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IConsultationFeedbackEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get mediaIds(): IConsultationFeedbackEntity['mediaIds'] {
    return this._mediaIds;
  }

  set mediaIds(value: IConsultationFeedbackEntity['mediaIds']) {
    this.setProperty('mediaIds', value);
  }

  get correctionContextItemId(): IConsultationFeedbackEntity['correctionContextItemId'] {
    return this._correctionContextItemId;
  }

  set correctionContextItemId(value: IConsultationFeedbackEntity['correctionContextItemId']) {
    this.setProperty('correctionContextItemId', value);
  }

  get correctionVersionNumber(): IConsultationFeedbackEntity['correctionVersionNumber'] {
    return this._correctionVersionNumber;
  }

  set correctionVersionNumber(value: IConsultationFeedbackEntity['correctionVersionNumber']) {
    this.setProperty('correctionVersionNumber', value);
  }

  get provenance(): IConsultationFeedbackEntity['provenance'] {
    return this._provenance;
  }

  set provenance(value: IConsultationFeedbackEntity['provenance']) {
    this.setProperty('provenance', value);
  }

  get provAgentSlug(): IConsultationFeedbackEntity['provAgentSlug'] {
    return this._provAgentSlug;
  }

  set provAgentSlug(value: IConsultationFeedbackEntity['provAgentSlug']) {
    this.setProperty('provAgentSlug', value);
  }

  get provAgentVersion(): IConsultationFeedbackEntity['provAgentVersion'] {
    return this._provAgentVersion;
  }

  set provAgentVersion(value: IConsultationFeedbackEntity['provAgentVersion']) {
    this.setProperty('provAgentVersion', value);
  }

  get provModelName(): IConsultationFeedbackEntity['provModelName'] {
    return this._provModelName;
  }

  set provModelName(value: IConsultationFeedbackEntity['provModelName']) {
    this.setProperty('provModelName', value);
  }

  get provPromptVersion(): IConsultationFeedbackEntity['provPromptVersion'] {
    return this._provPromptVersion;
  }

  set provPromptVersion(value: IConsultationFeedbackEntity['provPromptVersion']) {
    this.setProperty('provPromptVersion', value);
  }

  get provWorkflowRunId(): IConsultationFeedbackEntity['provWorkflowRunId'] {
    return this._provWorkflowRunId;
  }

  set provWorkflowRunId(value: IConsultationFeedbackEntity['provWorkflowRunId']) {
    this.setProperty('provWorkflowRunId', value);
  }

  get provActivityRunId(): IConsultationFeedbackEntity['provActivityRunId'] {
    return this._provActivityRunId;
  }

  set provActivityRunId(value: IConsultationFeedbackEntity['provActivityRunId']) {
    this.setProperty('provActivityRunId', value);
  }

  get idempotencyKey(): IConsultationFeedbackEntity['idempotencyKey'] {
    return this._idempotencyKey;
  }

  set idempotencyKey(value: IConsultationFeedbackEntity['idempotencyKey']) {
    this.setProperty('idempotencyKey', value);
  }

  get isLatest(): IConsultationFeedbackEntity['isLatest'] {
    return this._isLatest;
  }

  set isLatest(value: IConsultationFeedbackEntity['isLatest']) {
    this.setProperty('isLatest', value);
  }

  get supersedesId(): IConsultationFeedbackEntity['supersedesId'] {
    return this._supersedesId;
  }

  set supersedesId(value: IConsultationFeedbackEntity['supersedesId']) {
    this.setProperty('supersedesId', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!this._actorUserId) {
      throw new BusinessException('Actor user is required');
    }
  }
}
