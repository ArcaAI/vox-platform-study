import { Inject, Injectable } from '@nestjs/common';
import { ContextItemRepository, ContextItemType } from '@arcaai/domains';
import { isStrictUtf8 } from '../../../media-upload/media-content-sniff';
import { IContextService } from '../../context/IContextService';
import { ATTACHMENT_ERROR_CODES, AttachmentPolicyError } from '../attachment-policy';
import { AttachmentProcessInput, AttachmentProcessOutcome, stampEncounterSeq } from './attachment-processor';

/** A plain-text upload becomes a CASE_NOTE item (v1), linked back by `metaData.attachmentId`. */
@Injectable()
export class CaseNoteAttachmentProcessor {
  constructor(
    @Inject(IContextService) private readonly contextService: IContextService,
    private readonly contextItems: ContextItemRepository,
  ) {}

  /** 415 `ATTACHMENT_CONTENT_MISMATCH` unless the whole body is strict UTF-8 with no NUL byte. */
  assertText(body: Buffer): void {
    if (!isStrictUtf8(body) || body.includes(0)) {
      throw new AttachmentPolicyError(ATTACHMENT_ERROR_CODES.CONTENT_MISMATCH, 415, 'A case note must be UTF-8 text.');
    }
  }

  async process(input: AttachmentProcessInput): Promise<AttachmentProcessOutcome> {
    const body = input.body ?? Buffer.alloc(0);
    this.assertText(body);
    const content = body.toString('utf8').replace(/^﻿/, '');
    const item = await this.contextService.addContext(input.consultationId, {
      type: ContextItemType.CASE_NOTE,
      content,
      metadata: { attachmentId: input.attachmentId, mediaId: input.mediaId },
    });
    await stampEncounterSeq(this.contextItems, item.id, input.encounterSeq);
    return { pending: false, contextItemId: item.id };
  }
}
