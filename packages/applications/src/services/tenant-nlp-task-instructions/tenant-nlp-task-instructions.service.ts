import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ArgumentInvalidException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { ResourceType, SysEventType, TenantNlpTaskInstructionsFactory, TenantNlpTaskInstructionsRepository } from '@arcaai/domains';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { ITenantNlpTaskInstructionsService } from './ITenantNlpTaskInstructionsService';
import { isKnownNlpInstructionTaskKey, TENANT_NLP_INSTRUCTION_TASK_KEYS } from './constants';
import { TenantNlpTaskInstructionsDtoMapper } from './tenant-nlp-task-instructions.dto.mapper';
import { TenantNlpTaskInstructionsResponse, UpsertTenantNlpTaskInstructionsRequest } from './dto';

/**
 * Tenant-writable topic/intent instruction content service (TASK-729).
 *
 * Deliberately separate from `AiTaskDefaultService`: this table carries
 * tenant-authored CONTENT for `nlp.topic`/`nlp.intent` only, never a
 * `modelSlug`, and is NOT under the `nlp.*` super-admin-only write lock —
 * an ordinary tenant admin (`manage:TenantNlpTaskInstructions`, enforced by
 * the gateway controller's authorization decorator) owns these rows. Model
 * selection for these two task keys still resolves through `AiTaskDefault`
 * under its unmodified lock.
 */
@Injectable()
export class TenantNlpTaskInstructionsService extends BaseService implements ITenantNlpTaskInstructionsService {
  constructor(
    @Inject(TenantNlpTaskInstructionsRepository) private readonly repository: TenantNlpTaskInstructionsRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantNlpTaskInstructions);
  }

  async getRow(taskKey: string, tenantId?: string): Promise<TenantNlpTaskInstructionsResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);

    const row = await this.repository.findByTenantAndTaskKey(scopedTenantId, taskKey);
    if (!row) {
      return TenantNlpTaskInstructionsDtoMapper.placeholder(scopedTenantId, taskKey);
    }
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: row.id });
    return TenantNlpTaskInstructionsDtoMapper.toResponse(row);
  }

  async upsertRow(taskKey: string, dto: UpsertTenantNlpTaskInstructionsRequest, tenantId?: string): Promise<TenantNlpTaskInstructionsResponse> {
    this.assertKnownTaskKey(taskKey);
    const scopedTenantId = this.resolveScopedTenantId(tenantId);

    const existing = await this.repository.findByTenantAndTaskKey(scopedTenantId, taskKey);

    if (!existing) {
      // No row yet — a create. The client must declare `expectedVersion: 0`
      // (an omitted token is tolerated as a create).
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== 0) {
        throw new OptimisticConcurrencyException('TenantNlpTaskInstructions', `${scopedTenantId}:${taskKey}`, {
          expectedVersion: dto.expectedVersion,
          currentVersion: 0,
        });
      }
      const entity = TenantNlpTaskInstructionsFactory.CreateTenantNlpTaskInstructions({
        tenantId: scopedTenantId,
        taskKey,
        instructionsJson: dto.instructionsJson ?? null,
        createdBy: this.requestUserId ?? undefined,
      });
      const saved = await this.repository.create(entity);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: { taskKey, instructionsJson: saved.instructionsJson ?? null },
      });
      return TenantNlpTaskInstructionsDtoMapper.toResponse(saved);
    }

    await this.updateEntity(existing, dto.instructionsJson !== undefined ? { instructionsJson: dto.instructionsJson } : {});
    if (!existing.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }
    if (dto.expectedVersion === undefined) {
      // A CAS update without a token cannot be verified — surface it as a
      // concurrency error (the gateway's @RequiresIfMatch 428s before this).
      throw new OptimisticConcurrencyException('TenantNlpTaskInstructions', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }
    const previousVersion = existing.version;
    const updated = await this.repository.updateWithVersion(existing.id, existing, dto.expectedVersion);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { taskKey, instructionsJson: updated.instructionsJson ?? null, previousVersion, newVersion: updated.version },
    });
    return TenantNlpTaskInstructionsDtoMapper.toResponse(updated);
  }

  // ────────────────────────────── internals ──────────────────────────────

  private assertKnownTaskKey(taskKey: string): void {
    if (!isKnownNlpInstructionTaskKey(taskKey)) {
      throw new ArgumentInvalidException(
        `Unknown NLP instruction task key '${taskKey}'. Expected one of: ${TENANT_NLP_INSTRUCTION_TASK_KEYS.join(', ')}`,
      );
    }
  }

  /** Explicit tenant target (super-admin `?tenantId=`) over the CLS tenant. */
  private resolveScopedTenantId(tenantId?: string): string {
    const scoped = tenantId ?? this.tenantId;
    if (!scoped) {
      throw new BadRequestException('Tenant ID is required');
    }
    return scoped;
  }
}
