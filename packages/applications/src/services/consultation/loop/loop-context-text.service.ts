import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ContextItemEntity, ContextItemRepository, ResourceType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ILoopContextTextService } from './ILoopContextTextService';

/**
 * TASK-664 — reads the extracted text of a context item for the loop's
 * `document.extract_text` action.
 *
 * **Why the harness asks the gateway instead of extracting for itself.** The
 * gateway already owns document extraction: `OcrEnrichmentProcessor` runs OCR
 * plus NLP `/extract` when an ATTACHMENT arrives and persists the result onto
 * `ContextItem.metaData.extractedText`. Giving the harness a second extraction
 * path would mean a second set of storage credentials, a second PHI egress
 * surface, and two implementations that can disagree about what a document
 * says. One extraction, read from where it already lives.
 *
 * Never throws. A missing item, a cross-tenant id (hidden as a miss by the
 * tenant-scope extension) and an item whose OCR has not run yet are all `null`,
 * which the loop reads as "nothing derived" and treats as the end of that
 * cascade branch rather than as an error — the same degrade-don't-fail posture
 * `LoopConfigService` takes, and for the same reason: this is a service-token
 * internal read with no user to surface an error to.
 */
@Injectable()
export class LoopContextTextService extends BaseService implements ILoopContextTextService {
  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
  }

  async resolveExtractedText(tenantId: string, consultationId: string, contextItemId: string): Promise<string | null> {
    const item = await this.findTolerant(contextItemId);
    if (!item) return null;

    // Tenant AND parent checks, both of them. The tenant-scope extension
    // already hides a cross-tenant row, but an id belonging to a DIFFERENT
    // consultation of the SAME tenant would otherwise leak one consultation's
    // document text into another's loop.
    if (item.tenantId !== tenantId) return null;
    if (item.consultationId !== consultationId) return null;

    const metaData = item.metaData as Record<string, unknown> | null | undefined;
    const extracted = metaData?.extractedText;
    if (typeof extracted !== 'string') return null;
    const trimmed = extracted.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** `findById` throws `DataNotFoundException` on a miss — never surfaced as a throw here. */
  private async findTolerant(contextItemId: string): Promise<ContextItemEntity | null> {
    try {
      return await this.contextItemRepository.findById(contextItemId);
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }
}
