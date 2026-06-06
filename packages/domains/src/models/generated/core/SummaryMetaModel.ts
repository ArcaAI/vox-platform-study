/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Models from './';

export class SummaryMeta extends BaseTenantDataModel {
  public contextItemId: string;
  public aiModelId: string | null;
  public aiModelVersion: string | null;
  public promptVersion: string | null;
  public processingTimeMs: number | null;
  public inputTokens: number | null;
  public outputTokens: number | null;
  public caseNoteIds: string[];
  public preSummaryIds: string[];
  public previousSummaryIds: string[];
  public generatedAt: Date | null;
  public cacheHit: boolean | null;
  public qualityScore: number | null;
  public promptResolvedFrom: string | null;
  public resolvedPromptId: string | null;
  // TASK-330 Phase 1 — clinical-harness sensor scores + citation provenance
  public entityFaithfulnessScore: number | null;
  public coverageScore: number | null;
  public ragTriadScore: number | null;
  public citationsMap: JsonValue | null;
  public guardrailDecisions: JsonValue | null;
  public attestationRef: string | null;
  public modelName: string | null;

  constructor(data: SummaryMeta & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.aiModelId = data.aiModelId;
    this.aiModelVersion = data.aiModelVersion;
    this.promptVersion = data.promptVersion;
    this.processingTimeMs = data.processingTimeMs;
    this.inputTokens = data.inputTokens;
    this.outputTokens = data.outputTokens;
    this.caseNoteIds = data.caseNoteIds ?? [];
    this.preSummaryIds = data.preSummaryIds ?? [];
    this.previousSummaryIds = data.previousSummaryIds ?? [];
    this.generatedAt = data.generatedAt;
    this.cacheHit = data.cacheHit;
    this.qualityScore = data.qualityScore;
    this.promptResolvedFrom = data.promptResolvedFrom;
    this.resolvedPromptId = data.resolvedPromptId;
    this.entityFaithfulnessScore = data.entityFaithfulnessScore;
    this.coverageScore = data.coverageScore;
    this.ragTriadScore = data.ragTriadScore;
    this.citationsMap = data.citationsMap;
    this.guardrailDecisions = data.guardrailDecisions;
    this.attestationRef = data.attestationRef;
    this.modelName = data.modelName;
  }
}
