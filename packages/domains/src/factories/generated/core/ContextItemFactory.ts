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
      mediaId: props.mediaId ?? null,
      dnaWritingStyleId: props.dnaWritingStyleId ?? null,
      kindKey: props.kindKey ?? null,
      contextSchemaVersionId: props.contextSchemaVersionId ?? null,
      documentKey: props.documentKey ?? null,
      qdrantSynced: props.qdrantSynced ?? false,
      qdrantSyncedAt: null,
      tenantId: props.tenantId,
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
