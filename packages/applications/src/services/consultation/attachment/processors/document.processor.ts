import { Inject, Injectable } from '@nestjs/common';
import { ContextItemRepository, ContextItemType } from '@arcaai/domains';
import { IContextService } from '../../context/IContextService';
import { attachmentExtension } from '../attachment-policy';
import { AttachmentProcessInput, AttachmentProcessOutcome, ContextItemEncounterWriter, stampEncounterSeq } from './attachment-processor';

/**
 * A file becomes an ATTACHMENT item carrying its `Media` id. Text extraction is the existing
 * `OcrEnrichmentProcessor`, which reacts to the item's `ContextAdded` event; `fileName` is the
 * ids-only stored name (the client's own file name is PHI-prone and stays encrypted on the row).
 */
export async function addFileContextItem(
  contextService: IContextService,
  contextItems: ContextItemEncounterWriter,
  input: AttachmentProcessInput,
): Promise<AttachmentProcessOutcome> {
  const ext = attachmentExtension(input.mime);
  const item = await contextService.addContext(input.consultationId, {
    type: ContextItemType.ATTACHMENT,
    mediaId: input.mediaId,
    metadata: {
      attachmentId: input.attachmentId,
      mimeType: input.mime,
      fileName: ext ? `${input.attachmentId}.${ext}` : input.attachmentId,
    },
  });
  await stampEncounterSeq(contextItems, item.id, input.encounterSeq);
  return { pending: false, contextItemId: item.id };
}

/** `document` (PDF / text): an ATTACHMENT item; supported on the default engine (OD-C1). */
@Injectable()
export class DocumentAttachmentProcessor {
  constructor(
    @Inject(IContextService) private readonly contextService: IContextService,
    private readonly contextItems: ContextItemRepository,
  ) {}

  process(input: AttachmentProcessInput): Promise<AttachmentProcessOutcome> {
    return addFileContextItem(this.contextService, this.contextItems, input);
  }
}
