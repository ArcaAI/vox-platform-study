import { ContextItemEntity, ContextItemVersionEntity, AudioRecordingEntity, SummaryMetaEntity, NamedEntityEntity } from '@arcaai/domains';
import { ContextItemResponse, ContextItemVersionResponse, AudioRecordingResponse, SummaryMetaResponse, NamedEntityResponse } from './dto';

export class ContextDtoMapper {
  /**
   * Map ContextItemEntity to ContextItemResponse
   */
  static toResponse(entity: ContextItemEntity): ContextItemResponse {
    const response: ContextItemResponse = {
      id: entity.id,
      consultationId: entity.consultationId,
      type: entity.type,
      source: entity.source,
      content: entity.content ?? undefined,
      mediaId: entity.mediaId ?? undefined,
      dnaWritingStyleId: entity.dnaWritingStyleId ?? undefined,
      metadata: (entity.metaData as Record<string, unknown> | undefined) ?? undefined,
      currentVersionNumber: entity.currentVersionNumber,
      qdrantSynced: entity.qdrantSynced,
      qdrantSyncedAt: entity.qdrantSyncedAt?.toISOString(),
      isSummary: entity.isSummary,
      isFinalSummary: entity.isFinalSummary,
      isPreSummary: entity.isPreSummary,
      isTranscript: entity.isTranscript,
      isCaseNote: entity.isCaseNote,
      isWorknote: entity.isWorknote,
      isNamedEntity: entity.isNamedEntity,
      isAttachment: entity.isAttachment,
      isAiGenerated: entity.isAiGenerated,
      isMediaType: !entity.requiresContent,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };

    // Map nested relations if present
    if (entity.AudioRecordings && entity.AudioRecordings.length > 0) {
      response.audioRecordings = entity.AudioRecordings.map(this.toAudioRecordingResponse);
    }

    if (entity.SummaryMeta) {
      response.summaryMeta = this.toSummaryMetaResponse(entity.SummaryMeta);
    }

    if (entity.NamedEntities && entity.NamedEntities.length > 0) {
      response.namedEntities = entity.NamedEntities.map(this.toNamedEntityResponse);
    }

    if (entity.Versions && entity.Versions.length > 0) {
      response.versions = entity.Versions.map(this.toVersionResponse);
    }

    return response;
  }

  /**
   * Map AudioRecordingEntity to AudioRecordingResponse
   */
  static toAudioRecordingResponse(entity: AudioRecordingEntity): AudioRecordingResponse {
    return {
      id: entity.id,
      mediaId: entity.mediaId,
      rawMediaId: entity.rawMediaId ?? undefined,
      processedMediaId: entity.processedMediaId ?? undefined,
      duration: entity.duration ?? undefined,
      durationFormatted: entity.durationFormatted ?? undefined,
      format: entity.format ?? undefined,
      sampleRate: entity.sampleRate ?? undefined,
      channels: entity.channels ?? undefined,
      bitrate: entity.bitrate ?? undefined,
      language: entity.language ?? undefined,
      sequenceNumber: entity.sequenceNumber,
      recordedAt: entity.recordedAt?.toISOString(),
      createdAt: entity.createdAt.toISOString(),
    };
  }

  /**
   * Map SummaryMetaEntity to SummaryMetaResponse
   */
  static toSummaryMetaResponse(entity: SummaryMetaEntity): SummaryMetaResponse {
    return {
      id: entity.id,
      aiModelId: entity.aiModelId ?? undefined,
      aiModelVersion: entity.aiModelVersion ?? undefined,
      promptVersion: entity.promptVersion ?? undefined,
      processingTimeMs: entity.processingTimeMs ?? undefined,
      processingTimeSeconds: entity.processingTimeSeconds ?? undefined,
      inputTokens: entity.inputTokens ?? undefined,
      outputTokens: entity.outputTokens ?? undefined,
      totalTokens: entity.totalTokens,
      caseNoteIds: entity.caseNoteIds.length > 0 ? entity.caseNoteIds : undefined,
      preSummaryIds: entity.preSummaryIds.length > 0 ? entity.preSummaryIds : undefined,
      previousSummaryIds: entity.previousSummaryIds.length > 0 ? entity.previousSummaryIds : undefined,
      hasAnyContext: entity.hasAnyContext,
      generatedAt: entity.generatedAt?.toISOString(),
      cacheHit: entity.cacheHit ?? undefined,
      qualityScore: entity.qualityScore ?? undefined,
      promptResolvedFrom: (entity.promptResolvedFrom ?? undefined) as SummaryMetaResponse['promptResolvedFrom'],
      resolvedPromptId: entity.resolvedPromptId ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }

  /**
   * Map NamedEntityEntity to NamedEntityResponse
   */
  static toNamedEntityResponse(entity: NamedEntityEntity): NamedEntityResponse {
    return {
      id: entity.id,
      text: entity.text,
      className: entity.className,
      normalizedText: entity.normalizedText ?? undefined,
      displayText: entity.displayText,
      startOffset: entity.startOffset ?? undefined,
      endOffset: entity.endOffset ?? undefined,
      confidence: entity.confidence ?? undefined,
      isHighConfidence: entity.isHighConfidence,
      aiModelId: entity.aiModelId ?? undefined,
      aiModelVersion: entity.aiModelVersion ?? undefined,
      processingTimeMs: entity.processingTimeMs ?? undefined,
      metadata: entity.metadata as Record<string, unknown> | undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }

  /**
   * Map ContextItemVersionEntity to ContextItemVersionResponse
   */
  static toVersionResponse(entity: ContextItemVersionEntity): ContextItemVersionResponse {
    return {
      id: entity.id,
      contextItemId: entity.contextItemId,
      versionNumber: entity.versionNumber,
      content: entity.content ?? undefined,
      contentDiff: entity.contentDiff ?? undefined,
      changeReason: entity.changeReason ?? undefined,
      changeSummary: entity.changeSummary ?? undefined,
      changedBy: entity.changedBy ?? undefined,
      changeSource: entity.changeSource ?? undefined,
      fieldChanges: entity.fieldChanges as Record<string, unknown> | undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
