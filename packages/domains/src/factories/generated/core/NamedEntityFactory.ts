/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { NamedEntityEntity, INamedEntityEntity } from '../../../entities';
import { JsonValue } from '../../../interfaces';

export interface CreateNamedEntityProps extends BaseEntityFactoryCreateProps {
  contextItemId: INamedEntityEntity['contextItemId'];
  text: INamedEntityEntity['text'];
  className: INamedEntityEntity['className'];
  normalizedText?: INamedEntityEntity['normalizedText'];
  startOffset?: INamedEntityEntity['startOffset'];
  endOffset?: INamedEntityEntity['endOffset'];
  confidence?: INamedEntityEntity['confidence'];
  aiModelId?: INamedEntityEntity['aiModelId'];
  aiModelVersion?: INamedEntityEntity['aiModelVersion'];
  processingTimeMs?: INamedEntityEntity['processingTimeMs'];
  metadata?: INamedEntityEntity['metadata'];
  // TASK-330 Phase 1 — clinical ontology codes
  umlsCui?: INamedEntityEntity['umlsCui'];
  snomedCode?: INamedEntityEntity['snomedCode'];
  rxnormCode?: INamedEntityEntity['rxnormCode'];
  icdCode?: INamedEntityEntity['icdCode'];
  loincCode?: INamedEntityEntity['loincCode'];
  // TASK-330 Phase 1 — transcript-span provenance
  transcriptContextItemId?: INamedEntityEntity['transcriptContextItemId'];
  transcriptStartOffset?: INamedEntityEntity['transcriptStartOffset'];
  transcriptEndOffset?: INamedEntityEntity['transcriptEndOffset'];
  tenantId: INamedEntityEntity['tenantId'];

  createdAt?: INamedEntityEntity['createdAt'];
}

export class NamedEntityFactory {
  /**
   * Create a named entity
   */
  static CreateNamedEntity(props: CreateNamedEntityProps): NamedEntityEntity {
    const id = generateId();
    const now = new Date();

    return new NamedEntityEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,

      contextItemId: props.contextItemId,
      text: props.text,
      className: props.className,
      normalizedText: props.normalizedText ?? null,
      startOffset: props.startOffset ?? null,
      endOffset: props.endOffset ?? null,
      confidence: props.confidence ?? null,
      aiModelId: props.aiModelId ?? null,
      aiModelVersion: props.aiModelVersion ?? null,
      processingTimeMs: props.processingTimeMs ?? null,
      metadata: props.metadata ?? null,
      umlsCui: props.umlsCui ?? null,
      snomedCode: props.snomedCode ?? null,
      rxnormCode: props.rxnormCode ?? null,
      icdCode: props.icdCode ?? null,
      loincCode: props.loincCode ?? null,
      transcriptContextItemId: props.transcriptContextItemId ?? null,
      transcriptStartOffset: props.transcriptStartOffset ?? null,
      transcriptEndOffset: props.transcriptEndOffset ?? null,
      tenantId: props.tenantId,
    });
  }

  /**
   * Create a medication entity
   */
  static CreateMedication(
    tenantId: string,
    contextItemId: string,
    text: string,
    confidence?: number,
    normalizedText?: string,
    startOffset?: number,
    endOffset?: number,
    metadata?: JsonValue,
  ): NamedEntityEntity {
    return this.CreateNamedEntity({
      tenantId,
      contextItemId,
      text,
      className: NamedEntityEntity.CLASS_MEDICATION,
      normalizedText,
      startOffset,
      endOffset,
      confidence,
      metadata,
    });
  }

  /**
   * Create a condition/diagnosis entity
   */
  static CreateCondition(
    tenantId: string,
    contextItemId: string,
    text: string,
    confidence?: number,
    normalizedText?: string,
    startOffset?: number,
    endOffset?: number,
    metadata?: JsonValue,
  ): NamedEntityEntity {
    return this.CreateNamedEntity({
      tenantId,
      contextItemId,
      text,
      className: NamedEntityEntity.CLASS_CONDITION,
      normalizedText,
      startOffset,
      endOffset,
      confidence,
      metadata,
    });
  }

  /**
   * Create a procedure entity
   */
  static CreateProcedure(
    tenantId: string,
    contextItemId: string,
    text: string,
    confidence?: number,
    normalizedText?: string,
    startOffset?: number,
    endOffset?: number,
    metadata?: JsonValue,
  ): NamedEntityEntity {
    return this.CreateNamedEntity({
      tenantId,
      contextItemId,
      text,
      className: NamedEntityEntity.CLASS_PROCEDURE,
      normalizedText,
      startOffset,
      endOffset,
      confidence,
      metadata,
    });
  }

  /**
   * Create an anatomy entity
   */
  static CreateAnatomy(
    tenantId: string,
    contextItemId: string,
    text: string,
    confidence?: number,
    normalizedText?: string,
    startOffset?: number,
    endOffset?: number,
    metadata?: JsonValue,
  ): NamedEntityEntity {
    return this.CreateNamedEntity({
      tenantId,
      contextItemId,
      text,
      className: NamedEntityEntity.CLASS_ANATOMY,
      normalizedText,
      startOffset,
      endOffset,
      confidence,
      metadata,
    });
  }

  /**
   * Create a named entity with AI model info
   */
  static CreateWithAiModel(
    tenantId: string,
    contextItemId: string,
    text: string,
    className: string,
    aiModelId: string,
    aiModelVersion: string,
    confidence?: number,
    processingTimeMs?: number,
    normalizedText?: string,
    startOffset?: number,
    endOffset?: number,
    metadata?: JsonValue,
  ): NamedEntityEntity {
    return this.CreateNamedEntity({
      tenantId,
      contextItemId,
      text,
      className,
      normalizedText,
      startOffset,
      endOffset,
      confidence,
      aiModelId,
      aiModelVersion,
      processingTimeMs,
      metadata,
    });
  }
}
