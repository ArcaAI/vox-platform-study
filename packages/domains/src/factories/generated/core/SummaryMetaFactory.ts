/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { SummaryMetaEntity, ISummaryMetaEntity } from '../../../entities';

export interface CreateSummaryMetaProps extends BaseEntityFactoryCreateProps {
  contextItemId: ISummaryMetaEntity['contextItemId'];
  aiModelId?: ISummaryMetaEntity['aiModelId'];
  aiModelVersion?: ISummaryMetaEntity['aiModelVersion'];
  promptVersion?: ISummaryMetaEntity['promptVersion'];
  processingTimeMs?: ISummaryMetaEntity['processingTimeMs'];
  inputTokens?: ISummaryMetaEntity['inputTokens'];
  outputTokens?: ISummaryMetaEntity['outputTokens'];
  // Generation-stats headline fields, matching the columns the entity and
  // mapper already surface: `stopReason` is the NORMALIZED stop reason,
  // `ttftMs` time-to-first-token, `tokensPerSecond` decode throughput.
  stopReason?: ISummaryMetaEntity['stopReason'];
  ttftMs?: ISummaryMetaEntity['ttftMs'];
  tokensPerSecond?: ISummaryMetaEntity['tokensPerSecond'];
  caseNoteIds?: ISummaryMetaEntity['caseNoteIds'];
  preSummaryIds?: ISummaryMetaEntity['preSummaryIds'];
  previousSummaryIds?: ISummaryMetaEntity['previousSummaryIds'];
  generatedAt?: ISummaryMetaEntity['generatedAt'];
  cacheHit?: ISummaryMetaEntity['cacheHit'];
  qualityScore?: ISummaryMetaEntity['qualityScore'];
  promptResolvedFrom?: ISummaryMetaEntity['promptResolvedFrom'];
  resolvedPromptId?: ISummaryMetaEntity['resolvedPromptId'];
  // Clinical-harness sensor scores + citation provenance
  entityFaithfulnessScore?: ISummaryMetaEntity['entityFaithfulnessScore'];
  coverageScore?: ISummaryMetaEntity['coverageScore'];
  ragTriadScore?: ISummaryMetaEntity['ragTriadScore'];
  citationsMap?: ISummaryMetaEntity['citationsMap'];
  guardrailDecisions?: ISummaryMetaEntity['guardrailDecisions'];
  attestationRef?: ISummaryMetaEntity['attestationRef'];
  modelName?: ISummaryMetaEntity['modelName'];
  // Two-phase (optimistic) assurance state
  gateDecision?: ISummaryMetaEntity['gateDecision'];
  assuranceCompletedAt?: ISummaryMetaEntity['assuranceCompletedAt'];
  // DNA redaction/rewrite audit (TASK-551). `redactionManifest` is the transient
  // plaintext audit blob (encrypt-on-write via the repository sidecar into
  // `encryptedRedactionManifest`); `redactionApplied` is the plaintext marker.
  redactionApplied?: ISummaryMetaEntity['redactionApplied'];
  redactionManifest?: ISummaryMetaEntity['redactionManifest'];
  tenantId: ISummaryMetaEntity['tenantId'];

  createdAt?: ISummaryMetaEntity['createdAt'];
}

export class SummaryMetaFactory {
  /**
   * Create a summary metadata record
   */
  static CreateSummaryMeta(props: CreateSummaryMetaProps): SummaryMetaEntity {
    const id = generateId();
    const now = new Date();

    return new SummaryMetaEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,

      contextItemId: props.contextItemId,
      aiModelId: props.aiModelId ?? null,
      aiModelVersion: props.aiModelVersion ?? null,
      promptVersion: props.promptVersion ?? null,
      processingTimeMs: props.processingTimeMs ?? null,
      inputTokens: props.inputTokens ?? null,
      outputTokens: props.outputTokens ?? null,
      stopReason: props.stopReason ?? null,
      ttftMs: props.ttftMs ?? null,
      tokensPerSecond: props.tokensPerSecond ?? null,
      caseNoteIds: props.caseNoteIds ?? [],
      preSummaryIds: props.preSummaryIds ?? [],
      previousSummaryIds: props.previousSummaryIds ?? [],
      generatedAt: props.generatedAt ?? null,
      cacheHit: props.cacheHit ?? null,
      qualityScore: props.qualityScore ?? null,
      promptResolvedFrom: props.promptResolvedFrom ?? null,
      resolvedPromptId: props.resolvedPromptId ?? null,
      entityFaithfulnessScore: props.entityFaithfulnessScore ?? null,
      coverageScore: props.coverageScore ?? null,
      ragTriadScore: props.ragTriadScore ?? null,
      citationsMap: props.citationsMap ?? null,
      guardrailDecisions: props.guardrailDecisions ?? null,
      attestationRef: props.attestationRef ?? null,
      modelName: props.modelName ?? null,
      gateDecision: props.gateDecision ?? null,
      assuranceCompletedAt: props.assuranceCompletedAt ?? null,
      redactionApplied: props.redactionApplied ?? null,
      redactionManifest: props.redactionManifest ?? null,
      tenantId: props.tenantId,
    });
  }

  /**
   * Create summary metadata with AI model info
   */
  static CreateWithAiModel(
    tenantId: string,
    contextItemId: string,
    aiModelId: string,
    aiModelVersion: string,
    promptVersion?: string,
    processingTimeMs?: number,
    inputTokens?: number,
    outputTokens?: number,
  ): SummaryMetaEntity {
    return this.CreateSummaryMeta({
      tenantId,
      contextItemId,
      aiModelId,
      aiModelVersion,
      promptVersion,
      processingTimeMs,
      inputTokens,
      outputTokens,
      generatedAt: new Date(),
    });
  }

  /**
   * Create summary metadata with context references
   */
  static CreateWithContext(
    tenantId: string,
    contextItemId: string,
    aiModelId: string,
    aiModelVersion: string,
    context: {
      caseNoteIds?: string[];
      preSummaryIds?: string[];
      previousSummaryIds?: string[];
    },
    processingTimeMs?: number,
  ): SummaryMetaEntity {
    return this.CreateSummaryMeta({
      tenantId,
      contextItemId,
      aiModelId,
      aiModelVersion,
      caseNoteIds: context.caseNoteIds,
      preSummaryIds: context.preSummaryIds,
      previousSummaryIds: context.previousSummaryIds,
      processingTimeMs,
      generatedAt: new Date(),
    });
  }
}
