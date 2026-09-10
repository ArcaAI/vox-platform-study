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
 * Tenant-writable topic/intent instruction content service.
 *
 * Deliberately separate from `AiRoutingPolicyService`: this table carries
 * tenant-authored CONTENT for `nlp.topic`/`nlp.intent` only, never a
 * `modelSlug`, and is NOT under the `nlp.*` super-admin-only write lock —
 * an ordinary tenant admin (`manage:TenantNlpTaskInstructions`, enforced by
 * the gateway controller's authorization decorator) owns these rows. Model
 * selection for these two task keys still resolves through `AiRoutingPolicy`
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
    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(existing, dto.expectedVersion);
    if (dto.expectedVersion === undefined) {
      // A CAS update without a token cannot be verified — surface it as a
      // concurrency error (the gateway's @RequiresIfMatch 428s before this).
      throw new OptimisticConcurrencyException('TenantNlpTaskInstructions', existing.id, {
        expectedVersion: dto.expectedVersion,
        currentVersion: existing.version,
      });
    }
    // PUT is idempotent by contract (RFC 9110 §9.2.2): re-sending a value that is
    // already stored must yield the SAME observable result as the first send, not a
    // 400. Returning the current representation satisfies BOTH that and the
    // phantom-write rule — no version bump, no `updatedAt` rewrite, no
    // ResourceUpdated event. (PATCH routes keep throwing `ArgumentInvalidException`;
    // there "you sent me nothing to change" IS the documented answer.)
    // The OCC precondition above has already run, so a STALE token still gets 412
    // rather than a misleading 200.
    if (!existing.hasChanges) {
      return TenantNlpTaskInstructionsDtoMapper.toResponse(existing);
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
