/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationFeedback extends BaseTenantDataModel {
  public consultationId: string;
  public encounterSeq: number | null;
  public actorUserId: string;
  public actorCredentialClass: string;
  public actorPrincipalId: string | null;
  public clientApp: string | null;
  public clientSurface: string | null;
  public targetKind: Enums.FeedbackTargetKind | null;
  public targetContextItemId: string | null;
  public targetVersionNumber: number | null;
  public targetSectionKey: string | null;
  public targetDocumentKey: string | null;
  public targetEntityRef: string | null;
  public entityLabel: string | null;
  public targetKey: string | null;
  public rating: Enums.FeedbackRating | null;
  public reasonCodes: string[];
  public encryptedComment: Uint8Array | null;
  public keyVersion: number | null;
  public mediaIds: string[];
  public correctionContextItemId: string | null;
  public correctionVersionNumber: number | null;
  public provenance: JsonValue | null;
  public provAgentSlug: string | null;
  public provAgentVersion: number | null;
  public provModelName: string | null;
  public provPromptVersion: string | null;
  public provWorkflowRunId: string | null;
  public provActivityRunId: string | null;
  public idempotencyKey: string | null;
  public isLatest: boolean;
  public supersedesId: string | null;

  constructor(data: ConsultationFeedback & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.encounterSeq = data.encounterSeq;
    this.actorUserId = data.actorUserId;
    this.actorCredentialClass = data.actorCredentialClass;
    this.actorPrincipalId = data.actorPrincipalId;
    this.clientApp = data.clientApp;
    this.clientSurface = data.clientSurface;
    this.targetKind = data.targetKind;
    this.targetContextItemId = data.targetContextItemId;
    this.targetVersionNumber = data.targetVersionNumber;
    this.targetSectionKey = data.targetSectionKey;
    this.targetDocumentKey = data.targetDocumentKey;
    this.targetEntityRef = data.targetEntityRef;
    this.entityLabel = data.entityLabel;
    this.targetKey = data.targetKey;
    this.rating = data.rating;
    this.reasonCodes = data.reasonCodes;
    this.encryptedComment = data.encryptedComment;
    this.keyVersion = data.keyVersion;
    this.mediaIds = data.mediaIds;
    this.correctionContextItemId = data.correctionContextItemId;
    this.correctionVersionNumber = data.correctionVersionNumber;
    this.provenance = data.provenance;
    this.provAgentSlug = data.provAgentSlug;
    this.provAgentVersion = data.provAgentVersion;
    this.provModelName = data.provModelName;
    this.provPromptVersion = data.provPromptVersion;
    this.provWorkflowRunId = data.provWorkflowRunId;
    this.provActivityRunId = data.provActivityRunId;
    this.idempotencyKey = data.idempotencyKey;
    this.isLatest = data.isLatest;
    this.supersedesId = data.supersedesId;
  }
}
