/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class SummaryMeta extends BaseTenantDataModel {
  public contextItemId: string;
  public aiModelId: string | null;
  public aiModelVersion: string | null;
  public promptVersion: string | null;
  public processingTimeMs: number | null;
  public inputTokens: number | null;
  public outputTokens: number | null;
  public cacheHit: boolean | null;
  public qualityScore: number | null;
  public caseNoteIds: string[];
  public preSummaryIds: string[];
  public previousSummaryIds: string[];
  public generatedAt: Date | null;
  public promptResolvedFrom: string | null;
  public resolvedPromptId: string | null;
  // TASK-330 Phase 1 — clinical-harness sensor scores + citation provenance
  public entityFaithfulnessScore: number | null;
  public coverageScore: number | null;
  public ragTriadScore: number | null;
  // TASK-369 Phase 6 — plaintext citationsMap / guardrailDecisions columns
  // DROPPED; persistence is ciphertext-only. The entity keeps these as transient
  // fields repopulated by repository decrypt-on-read.
  public attestationRef: string | null;
  public modelName: string | null;
  // TASK-355 Phase D — two-phase (optimistic) assurance state
  public gateDecision: string | null;
  public assuranceCompletedAt: Date | null;
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedCitationsMap: Uint8Array | null;
  public encryptedGuardrailDecisions: Uint8Array | null;
  public keyVersion: number | null;
  @VirtualDbProperty()
  public ContextItem: Models.ContextItem | undefined;

  constructor(data: SummaryMeta & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.aiModelId = data.aiModelId;
    this.aiModelVersion = data.aiModelVersion;
    this.promptVersion = data.promptVersion;
    this.processingTimeMs = data.processingTimeMs;
    this.inputTokens = data.inputTokens;
    this.outputTokens = data.outputTokens;
    this.cacheHit = data.cacheHit;
    this.qualityScore = data.qualityScore;
    this.caseNoteIds = data.caseNoteIds ?? [];
    this.preSummaryIds = data.preSummaryIds ?? [];
    this.previousSummaryIds = data.previousSummaryIds ?? [];
    this.generatedAt = data.generatedAt;
    this.promptResolvedFrom = data.promptResolvedFrom;
    this.resolvedPromptId = data.resolvedPromptId;
    this.entityFaithfulnessScore = data.entityFaithfulnessScore;
    this.coverageScore = data.coverageScore;
    this.ragTriadScore = data.ragTriadScore;
    this.attestationRef = data.attestationRef;
    this.modelName = data.modelName;
    this.gateDecision = data.gateDecision;
    this.assuranceCompletedAt = data.assuranceCompletedAt;
    this.encryptedCitationsMap = data.encryptedCitationsMap;
    this.encryptedGuardrailDecisions = data.encryptedGuardrailDecisions;
    this.keyVersion = data.keyVersion;
    this.ContextItem = data.ContextItem;
  }
}
