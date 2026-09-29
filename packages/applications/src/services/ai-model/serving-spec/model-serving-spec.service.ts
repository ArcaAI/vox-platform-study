import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { AiModelEntity, AiModelRepository, ResourceStatusType, ResourceType, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import type { ResolvedServingSpec } from '@arcaai/types';
import { BaseService } from '../../../common/base.service';
import { IActiveUserContext } from '../../../interfaces';
import { buildResolvedServingSpec } from './build-resolved-serving-spec';
import { IModelServingSpecService } from './IModelServingSpecService';

/** The `AiModel.servedBy` value of every row `apps/vllm` executes (D-13). */
const SERVED_BY_VLLM = 'vllm';

/**
 * TASK-1021 (C-2) — which `AiModel` row `apps/vllm` builds an engine from.
 *
 * The cascade is CONFIGURATION's: request tenant → SYSTEM, two tiers, widening only on ABSENCE.
 * Both reads name their tenant explicitly, so a third tenant's row is unreachable by construction.
 * A soft-deleted tenant row is absent; a DISABLED one is the tenant's opinion and is refused
 * (409 `DISABLED`) rather than silently replaced by the platform row — which is why the read is
 * status-agnostic (`findBySlugIncludingDeleted`) instead of the ENABLED-only `findBySlug`.
 */
@Injectable()
export class ModelServingSpecService extends BaseService implements IModelServingSpecService {
  constructor(
    private readonly aiModelRepository: AiModelRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AiModel);
  }

  async resolve(slug: string, tenantId: string): Promise<ResolvedServingSpec> {
    const row = (await this.findVisible(tenantId, slug)) ?? (tenantId === SYSTEM_TENANT_ID ? null : await this.findVisible(SYSTEM_TENANT_ID, slug));
    if (!row || row.servedBy !== SERVED_BY_VLLM) {
      throw new NotFoundException({ code: 'MODEL_NOT_FOUND' });
    }

    const built = buildResolvedServingSpec(row);
    if (built.ok === false) {
      throw new ConflictException({ code: 'MODEL_NOT_SERVABLE', reason: built.reason });
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: row.id });
    return built.spec;
  }

  /** One tier's row under `slug`, whatever its status except soft-deleted. */
  private async findVisible(tenantId: string, slug: string): Promise<AiModelEntity | null> {
    const row = await this.aiModelRepository.findBySlugIncludingDeleted(tenantId, slug);
    return row && row.resourceStatus !== ResourceStatusType.DELETED ? row : null;
  }
}
