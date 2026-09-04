import { Injectable } from '@nestjs/common';
import { Prisma, SYSTEM_TENANT_ID } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentEntity } from '../../../entities';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '../../../enums';
import { AgentEntityMapper } from '../../../mappers';
import { Agent } from '../../../models';

/**
 * `Agent` — rows ARE versions (TASK-863). Tenant-scoped, soft-deletable, and a
 * `SYSTEM_SHARED_READ_MODELS` member: the tenant-scope extension widens every
 * READ to `tenantId IN [caller, SYSTEM]` by itself, and REJECTS a non-string
 * `tenantId` filter — so the widened reads below pass NO `tenantId` and
 * post-filter in code (defence in depth for a call with no CLS tenant).
 */
@Injectable()
export class AgentRepository extends Repository<AgentEntity, Agent> {
  /** What "a live version" means, written ONCE and shared by every read that serves callers. */
  private static readonly PUBLISHED_AND_ACTIVE = {
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    resourceStatus: ResourceStatusType.ENABLED,
  } as const;

  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agent', AgentEntityMapper.getInstance());
  }

  /**
   * The ONE row `/api/v1/agents/:slug` and the resolver serve: the caller's own
   * ACTIVE PUBLISHED version of `slug`, else SYSTEM's. `null` — never a throw —
   * for a foreign, unknown, unpublished or inactive slug, so the caller maps all
   * of those to one 404 (404-over-403).
   */
  async findPublishedActiveBySlug(tenantId: string, slug: string): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({
      where: { slug, ...AgentRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ tenantId: 'desc' }],
    });
    const visible = rows.filter((row) => row.tenantId === tenantId || row.tenantId === SYSTEM_TENANT_ID);
    const own = visible.find((row) => row.tenantId === tenantId);
    const row = own ?? visible.find((row) => row.tenantId === SYSTEM_TENANT_ID) ?? null;
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /**
   * Every live agent visible to the tenant — one row per slug, the tenant's own
   * row shadowing SYSTEM's (`GET /api/v1/agents`; the same predicate as
   * `findPublishedActiveBySlug`, so what a list advertises a by-slug read serves).
   */
  async findPublishedActiveVisible(tenantId: string, task?: AgentTask): Promise<AgentEntity[]> {
    const rows = await this.findManyTolerant({
      where: { ...(task ? { task } : {}), ...AgentRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ slug: 'asc' }, { tenantId: 'desc' }],
    });
    const bySlug = new Map<string, Agent>();
    for (const row of rows) {
      if (row.tenantId !== tenantId && row.tenantId !== SYSTEM_TENANT_ID) continue;
      const current = bySlug.get(row.slug);
      if (!current || (current.tenantId !== tenantId && row.tenantId === tenantId)) bySlug.set(row.slug, row);
    }
    const mapper = AgentEntityMapper.getInstance();
    return [...bySlug.values()].map((row) => mapper.toDomainEntity(row));
  }

  /** A row by id, visible when it belongs to the caller or to SYSTEM; `null` otherwise. */
  async findByIdVisible(id: string, tenantId: string): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({ where: { id } });
    const row = rows.find((candidate) => candidate.tenantId === tenantId || candidate.tenantId === SYSTEM_TENANT_ID);
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /** The caller's OWN currently-active published row of a lineage (for `demoteExistingActive`). */
  async findOwnActiveBySlug(tenantId: string, slug: string): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({ where: { slug, ...AgentRepository.PUBLISHED_AND_ACTIVE } });
    const row = rows.find((candidate) => candidate.tenantId === tenantId);
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /** Every version row of the caller's `(tenantId, slug)` lineage, newest first. */
  async findAllVersionsBySlug(tenantId: string, slug: string): Promise<AgentEntity[]> {
    const rows = await this.findManyTolerant({
      where: { slug, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ versionNumber: 'desc' }],
    });
    const mapper = AgentEntityMapper.getInstance();
    return rows.filter((row) => row.tenantId === tenantId).map((row) => mapper.toDomainEntity(row));
  }

  /** The caller's own rows (admin list), newest first. */
  async findAllForTenant(tenantId: string, task?: AgentTask): Promise<AgentEntity[]> {
    const rows = await this.findManyTolerant({
      where: { ...(task ? { task } : {}), resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ slug: 'asc' }, { versionNumber: 'desc' }],
    });
    const mapper = AgentEntityMapper.getInstance();
    return rows.filter((row) => row.tenantId === tenantId).map((row) => mapper.toDomainEntity(row));
  }

  /**
   * `max(versionNumber)` for a lineage, `0` when new — minted FROM THE TX CLIENT
   * (the `WorkflowDefinitionRepository` / `PromptVersionRepository` discipline) so a
   * lagging counter cannot recompute an existing versionNumber. Not filtered by
   * `resourceStatus`: a soft-deleted row's number is still live in the unique index.
   */
  async findMaxVersionNumber(tenantId: string, slug: string, tx?: Prisma.TransactionClient | unknown): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors WorkflowDefinitionRepository.findMaxVersionNumber.
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await model.aggregate({
      where: { tenantId, slug },
      _max: { versionNumber: true },
    });
    return result?._max?.versionNumber ?? 0;
  }

  /** `findMany` on the raw delegate; a `DataNotFoundException` is an empty result, anything else surfaces. */
  private async findManyTolerant(args: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'>[] }): Promise<Agent[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the raw delegate shape isn't exposed through DomainModel typings.
      const rows: Agent[] | null = await (this.db as any).findMany(args);
      return rows ?? [];
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return [];
      }
      throw err;
    }
  }
}
