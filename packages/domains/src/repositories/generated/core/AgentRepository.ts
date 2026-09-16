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
 * `Agent` — rows ARE versions (TASK-863). Tenant-scoped and soft-deletable.
 *
 * TASK-890 L13 (OD-M) — it is NO LONGER a `SYSTEM_SHARED_READ_MODELS` member. An agent is
 * CONTENT (§1.5): SYSTEM holds the REFERENCE SET a tenant is provisioned from, and every
 * runtime read answers the CALLER's own rows. The reads below therefore pass no `tenantId` (the
 * extension merges the caller's in) and post-filter on the caller ALONE — defence in depth for
 * a call made with no CLS tenant, where the extension cannot filter at all.
 *
 * The one family allowed to see SYSTEM says so explicitly on the unscoped client:
 * {@link findSystemReferences} / {@link findSystemReferenceBySlug}, consumed by provisioning and
 * the super-admin library branch, never by a resolver.
 */
/**
 * TASK-974 D-1 — the lineage keys {@link AgentRepository.findPlatformHiddenBySlug} may serve.
 *
 * MIRRORED, not imported: the authority is `PLATFORM_HIDDEN_AGENTS`
 * (`packages/applications/src/services/agent/platform-hidden-agents.ts`), which also records
 * each slug's task and the reason it is platform-owned — but `packages/applications` sits ABOVE
 * this package in the dependency graph, so it cannot be read from here. The same shape
 * `service-account-seed.test.ts` uses for `SVC_SCOPE_IMPLICATIONS`, for the same reason.
 *
 * Parity is PROVEN, not trusted: `platform-hidden-agents.test.ts` in the applications package
 * asserts the two lists are the same set, so adding a slug in one place and not the other fails
 * a test rather than silently refusing (or silently widening) a read.
 */
export const PLATFORM_HIDDEN_AGENT_SLUGS: ReadonlySet<string> = new Set(['dna-writing-style-analyst']);

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
   * The ONE row `/api/v1/agents/:slug` and the resolver serve: the caller's own ACTIVE PUBLISHED
   * version of `slug`. `null` — never a throw — for a foreign, unknown, unpublished or inactive
   * slug, so the caller maps all of those to one 404 (404-over-403).
   *
   * TASK-890 OD-M — a SYSTEM row is no longer an answer here. A tenant that expects a platform
   * agent has its own provisioned CLONE of it, carrying the same slug.
   */
  async findPublishedActiveBySlug(tenantId: string, slug: string): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({
      where: { slug, ...AgentRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ tenantId: 'desc' }],
    });
    const row = rows.find((candidate) => candidate.tenantId === tenantId) ?? null;
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /**
   * TASK-876 — ONE PINNED version of the CALLER's lineage, for a reader that was given an
   * explicit `versionNumber` rather than "whatever is active". `findPublishedActiveBySlug`
   * cannot serve that: it answers the ACTIVE version, so a caller holding a pin would silently
   * read — and report on — a different version.
   *
   * Not filtered by `isActive`: the point of a pin is a version that may no longer be the active
   * one. `null` — never a throw — for a foreign, unknown, unpublished or deleted version.
   */
  async findPublishedVisibleBySlugVersion(tenantId: string, slug: string, versionNumber: number): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({
      where: { slug, versionNumber, status: WorkflowDefinitionStatus.PUBLISHED, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ tenantId: 'desc' }],
    });
    const row = rows.find((candidate) => candidate.tenantId === tenantId) ?? null;
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /**
   * Every live agent of the CALLER's tenant — one row per slug (`GET /api/v1/agents`; the same
   * predicate as `findPublishedActiveBySlug`, so what a list advertises a by-slug read serves).
   */
  async findPublishedActiveVisible(tenantId: string, task?: AgentTask): Promise<AgentEntity[]> {
    const rows = await this.findManyTolerant({
      where: { ...(task ? { task } : {}), ...AgentRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ slug: 'asc' }, { tenantId: 'desc' }],
    });
    const bySlug = new Map<string, Agent>();
    for (const row of rows) {
      if (row.tenantId !== tenantId) continue;
      if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
    }
    const mapper = AgentEntityMapper.getInstance();
    return [...bySlug.values()].map((row) => mapper.toDomainEntity(row));
  }

  /**
   * TASK-890 §3.4 (OD-M) — the REFERENCE LIBRARY: the SYSTEM tenant's live published agents,
   * read on the UNSCOPED base client with an EXPLICIT `tenantId` pin.
   *
   * `Agent` LEAVES `SYSTEM_SHARED_READ_MODELS` (§1.5: an agent is CONTENT, and content is
   * cloned rather than shared), so there is no read widening left to lean on and none is
   * wanted: after the flip a tenant sees its OWN agents and nothing else. The reference set is
   * still real — it is what a tenant is provisioned FROM — so exactly one family of reads is
   * allowed to see two tenants, and it says so in its own `where` rather than through an
   * extension. Line for line the `WorkflowDefinitionRepository.findCloneSource` /
   * `findSystemTemplates` pattern, for the same reason it exists there.
   *
   * `client` is REQUIRED and is the unscoped base client — the scoped one would merge the
   * caller's tenant into this `where` and answer nothing.
   *
   * Consumed ONLY by `TenantReferenceSetService` (provisioning / re-sync) and by
   * `AgentService.resolveVisibleSource`'s platform-library branch. NEVER by a runtime resolver:
   * a runtime miss is `AGENT_NOT_ASSIGNED`, never a SYSTEM read.
   */
  async findSystemReferences(client: unknown, task?: AgentTask): Promise<AgentEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors WorkflowDefinitionRepository.findSystemTemplates; the caller-supplied client's delegate shape isn't exposed through DomainModel typings.
    const model: any = (client as Record<string, any>)[this._modelName];
    const rows: Agent[] = await model.findMany({
      where: { ...(task ? { task } : {}), tenantId: SYSTEM_TENANT_ID, ...AgentRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ slug: 'asc' }],
    });
    const mapper = AgentEntityMapper.getInstance();
    return (rows ?? []).map((row) => mapper.toDomainEntity(row));
  }

  /**
   * TASK-974 D-1 — the PLATFORM HIDDEN agent of `slug`: the SYSTEM tenant's live published row,
   * read on the UNSCOPED base client with an EXPLICIT `tenantId` pin, exactly like
   * {@link findSystemReferences} above.
   *
   * It is the SECOND declared family of two-tenant reads, and it differs from the first in one
   * way that is the entire safety argument: the reference library will serve ANY SYSTEM slug,
   * because provisioning legitimately iterates all of them, while this read serves ONLY the
   * slugs of {@link PLATFORM_HIDDEN_AGENT_SLUGS}. A slug outside that list THROWS before any
   * query runs — the read is a platform-capability lookup, never a general-purpose cross-tenant
   * one, and a caller that could pass an arbitrary slug would have turned it into exactly that.
   *
   * `client` is REQUIRED and is the unscoped base client; the scoped one would merge the
   * caller's tenant into this `where` and answer nothing.
   *
   * `null` — never a throw — when SYSTEM carries no live row for an ALLOWED slug: that is a
   * platform misconfiguration for the CALLER to name (the DNA processor fails the job with
   * `DNA_ANALYST_AGENT_UNAVAILABLE`), not something this read can decide.
   *
   * Consumed ONLY by the platform service that owns the capability. NEVER by the assignment
   * cascade, and never as a fallback for a tenant agent that is merely missing.
   */
  async findPlatformHiddenBySlug(client: unknown, slug: string): Promise<AgentEntity | null> {
    if (!PLATFORM_HIDDEN_AGENT_SLUGS.has(slug)) {
      throw new Error(
        `'${slug}' is not a platform hidden agent. This unscoped SYSTEM read serves only ${[...PLATFORM_HIDDEN_AGENT_SLUGS].join(', ')}; ` +
          'declare the slug in PLATFORM_HIDDEN_AGENTS (and here) or use a tenant-scoped read.',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findSystemReferences.
    const model: any = (client as Record<string, any>)[this._modelName];
    const row: Agent | null = await model.findFirst({
      where: { slug, tenantId: SYSTEM_TENANT_ID, ...AgentRepository.PUBLISHED_AND_ACTIVE },
    });
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /** ONE reference-library row by slug — the same predicate {@link findSystemReferences} lists, so what is listed can always be cloned. */
  async findSystemReferenceBySlug(slug: string, client: unknown): Promise<AgentEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findSystemReferences.
    const model: any = (client as Record<string, any>)[this._modelName];
    const row: Agent | null = await model.findFirst({
      where: { slug, tenantId: SYSTEM_TENANT_ID, ...AgentRepository.PUBLISHED_AND_ACTIVE },
    });
    return row ? AgentEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /** A row by id, when it belongs to the CALLER; `null` otherwise (a SYSTEM row included — OD-M). */
  async findByIdVisible(id: string, tenantId: string): Promise<AgentEntity | null> {
    const rows = await this.findManyTolerant({ where: { id } });
    const row = rows.find((candidate) => candidate.tenantId === tenantId);
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
   * Every version row of this tenant bound to one consultation context schema — the AGENT half of
   * a schema's "used by" read, beside `WorkflowDefinitionRepository.findByContextSchemaId`.
   *
   * An agent pins by column (`contextSchemaId` + `contextSchemaVersionNumber`, indexed as
   * `Agent_contextSchemaId_idx`), so unlike the workflow half there is nothing to backfill.
   * Filters to ENABLED only, for the same reason its sibling does: which rows COUNT toward a
   * publish gate is the caller's decision, not this read's.
   */
  async findByContextSchemaId(tenantId: string, contextSchemaId: string): Promise<AgentEntity[]> {
    const rows = await this.findManyTolerant({
      where: { contextSchemaId, resourceStatus: ResourceStatusType.ENABLED },
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
