import { Inject, Injectable } from '@nestjs/common';
import { ContextItemRepository } from '@arcaai/domains';
import { IContextService } from '../../context/IContextService';
import { AttachmentProcessInput, AttachmentProcessOutcome } from './attachment-processor';
import { addFileContextItem } from './document.processor';

/**
 * `image`: an ATTACHMENT item. Only reachable when the consultation's workflow subscribes to
 * `vision.extract_text` — the capability check refuses the kind at intent otherwise (OD-C1).
 */
@Injectable()
export class ImageAttachmentProcessor {
  constructor(
    @Inject(IContextService) private readonly contextService: IContextService,
    private readonly contextItems: ContextItemRepository,
  ) {}

  process(input: AttachmentProcessInput): Promise<AttachmentProcessOutcome> {
    return addFileContextItem(this.contextService, this.contextItems, input);
  }
}
