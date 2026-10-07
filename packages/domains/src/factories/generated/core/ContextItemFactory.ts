/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ContextItemEntity, IContextItemEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateContextItemProps extends BaseEntityFactoryCreateProps {
  consultationId: IContextItemEntity['consultationId'];
  type: IContextItemEntity['type'];
  source?: IContextItemEntity['source'];
  currentVersionNumber?: IContextItemEntity['currentVersionNumber'];
  content?: IContextItemEntity['content'];
  /** TASK-999 — plaintext size of `content`, measured by the WRITER. Omitted = never measured (NULL), which is what every pre-TASK-999 caller produces. */
  contentWordCount?: IContextItemEntity['contentWordCount'];
  contentCharCount?: IContextItemEntity['contentCharCount'];
  mediaId?: IContextItemEntity['mediaId'];
  dnaWritingStyleId?: IContextItemEntity['dnaWritingStyleId'];
  // Optional; omitted by every pre-existing caller, which is the
  // regression guarantee: a write that names no kind produces exactly the row
  // it produced before.
  kindKey?: IContextItemEntity['kindKey'];
  contextSchemaVersionId?: IContextItemEntity['contextSchemaVersionId'];
  // . Optional and defaulted to null, so every pre-existing
  // caller produces exactly the row it produced before.
  documentKey?: IContextItemEntity['documentKey'];
  // Consultation record model. Optional and defaulted to null (occurredAt to
  // now), so every pre-existing caller produces exactly the row it did before.
  encounterSeq?: IContextItemEntity['encounterSeq'];
  segmentSeq?: IContextItemEntity['segmentSeq'];
  segmentKey?: IContextItemEntity['segmentKey'];
  t0Ms?: IContextItemEntity['t0Ms'];
  t1Ms?: IContextItemEntity['t1Ms'];
  speaker?: IContextItemEntity['speaker'];
  capturedAt?: IContextItemEntity['capturedAt'];
  occurredAt?: IContextItemEntity['occurredAt'];
  // TASK-1050 — omitted by every pre-existing caller (the row then takes the
  // DB default CLEAN); a WITHHELD outbound-block placeholder sets it at create.
  guardrailStatus?: IContextItemEntity['guardrailStatus'];
  metaData?: IContextItemEntity['metaData'];
  qdrantSynced?: IContextItemEntity['qdrantSynced'];
  tenantId: IContextItemEntity['tenantId'];

  createdAt?: IContextItemEntity['createdAt'];
  updatedAt?: IContextItemEntity['updatedAt'];
  createdBy?: IContextItemEntity['createdBy'];
  updatedBy?: IContextItemEntity['updatedBy'];
}

export class ContextItemFactory {
  /**
   * Create a context item
   */
  static CreateContextItem(props: CreateContextItemProps): ContextItemEntity {
    const id = generateId();
    const now = new Date();

    return new ContextItemEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      consultationId: props.consultationId,
      type: props.type,
      source: props.source ?? Enums.ContextItemSource.USER,
      currentVersionNumber: props.currentVersionNumber ?? 1,
      content: props.content ?? null,
      contentWordCount: props.contentWordCount ?? null,
      contentCharCount: props.contentCharCount ?? null,
      mediaId: props.mediaId ?? null,
      dnaWritingStyleId: props.dnaWritingStyleId ?? null,
      kindKey: props.kindKey ?? null,
      contextSchemaVersionId: props.contextSchemaVersionId ?? null,
      documentKey: props.documentKey ?? null,
      encounterSeq: props.encounterSeq ?? null,
      segmentSeq: props.segmentSeq ?? null,
      segmentKey: props.segmentKey ?? null,
      t0Ms: props.t0Ms ?? null,
      t1Ms: props.t1Ms ?? null,
      speaker: props.speaker ?? null,
      capturedAt: props.capturedAt ?? null,
      occurredAt: props.occurredAt ?? props.capturedAt ?? now,
      guardrailStatus: props.guardrailStatus,
      metaData: props.metaData,
      qdrantSynced: props.qdrantSynced ?? false,
      qdrantSyncedAt: null,
      tenantId: props.tenantId,
    });
  }

  /**
   * Create one finalized transcript utterance (TRANSCRIPT_SEGMENT). The
   * caller allocates `segmentSeq` (ConsultationRepository.allocateSegmentSeqs)
   * and encrypts `content` before persisting.
   */
  static CreateTranscriptSegment(props: {
    tenantId: string;
    consultationId: string;
    encounterSeq: number;
    segmentSeq: number;
    segmentKey: string;
    content: string;
    t0Ms?: number | null;
    t1Ms?: number | null;
    speaker?: string | null;
    capturedAt?: Date | null;
    metaData?: IContextItemEntity['metaData'];
    createdBy?: string | null;
  }): ContextItemEntity {
    return this.CreateContextItem({
      tenantId: props.tenantId,
      consultationId: props.consultationId,
      type: Enums.ContextItemType.TRANSCRIPT_SEGMENT,
      source: Enums.ContextItemSource.TRANSCRIPTION,
      content: props.content,
      encounterSeq: props.encounterSeq,
      segmentSeq: props.segmentSeq,
      segmentKey: props.segmentKey,
      t0Ms: props.t0Ms,
      t1Ms: props.t1Ms,
      speaker: props.speaker,
      capturedAt: props.capturedAt,
      metaData: props.metaData,
      createdBy: props.createdBy ?? 'system',
    });
  }

  /**
   * Create an audio recording context item (container for AudioRecording entities)
   */
  static CreateAudioRecording(tenantId: string, consultationId: string, createdBy: string = 'system'): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.AUDIO_RECORDING,
      source: Enums.ContextItemSource.SYSTEM,
      createdBy,
    });
  }

  /**
   * Create a worknote context item
   */
  static CreateWorknote(tenantId: string, consultationId: string, content: string, createdBy: string): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.WORKNOTE,
      source: Enums.ContextItemSource.USER,
      content,
      createdBy,
    });
  }

  /**
   * Create a raw AI-generated summary context item
   */
  static CreateRawSummary(
    tenantId: string,
    consultationId: string,
    content: string,
    dnaWritingStyleId?: string,
    createdBy: string = 'system',
  ): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.RAW_SUMMARY,
      source: Enums.ContextItemSource.AI,
      content,
      dnaWritingStyleId,
      createdBy,
    });
  }

  /**
   * Create a user-modified summary context item
   */
  static CreateModifiedSummary(
    tenantId: string,
    consultationId: string,
    content: string,
    dnaWritingStyleId?: string,
    createdBy?: string,
  ): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.MODIFIED_SUMMARY,
      source: Enums.ContextItemSource.USER,
      content,
      dnaWritingStyleId,
      createdBy,
    });
  }

  /**
   * Create a pre-summary context item (AI-generated summary of case notes)
   * Pre-summaries are used to provide comprehensive context for final summarization
   */
  static CreatePreSummary(
    tenantId: string,
    consultationId: string,
    content: string,
    dnaWritingStyleId?: string,
    createdBy: string = 'system',
  ): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.PRE_SUMMARY,
      source: Enums.ContextItemSource.AI,
      content,
      dnaWritingStyleId,
      createdBy,
    });
  }

  /**
   * Create a transcript context item
   */
  static CreateTranscript(tenantId: string, consultationId: string, content: string, createdBy: string = 'system'): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.TRANSCRIPT,
      source: Enums.ContextItemSource.TRANSCRIPTION,
      content,
      createdBy,
    });
  }

  /**
   * Create a case note context item
   */
  static CreateCaseNote(tenantId: string, consultationId: string, content: string, createdBy: string): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.CASE_NOTE,
      source: Enums.ContextItemSource.USER,
      content,
      createdBy,
    });
  }

  /**
   * Create a named entity container context item
   */
  static CreateNamedEntityContainer(tenantId: string, consultationId: string, createdBy: string = 'system'): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.NAMED_ENTITY,
      source: Enums.ContextItemSource.AI,
      createdBy,
    });
  }

  /**
   * Create an attachment context item
   */
  static CreateAttachment(tenantId: string, consultationId: string, createdBy: string, mediaId?: string, content?: string): ContextItemEntity {
    return this.CreateContextItem({
      tenantId,
      consultationId,
      type: Enums.ContextItemType.ATTACHMENT,
      source: Enums.ContextItemSource.USER,
      mediaId,
      content,
      createdBy,
    });
  }
}
