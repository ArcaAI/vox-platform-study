import { Injectable } from '@nestjs/common';
import { Prisma, SYSTEM_TENANT_ID } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository, formatFindAllProps } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { WorkflowDefinitionEntity } from '../../../entities';
import { ResourceStatusType, WorkflowDefinitionStatus } from '../../../enums';
import { DbFilters } from '../../../interfaces';
import { WorkflowDefinitionEntityMapper } from '../../../mappers';
import { WorkflowDefinition } from '../../../models';

/**
 * TASK-965 (OD-965-3) — ONE version row of a lineage, projected. The AGENT half's
 * `AgentLineageVersionRef` with `registryChecksum` where an agent carries `modelId`: what a
 * reader needs to know about a published workflow version is whether the node registry has
 * drifted under it, not which model it names.
 */
export interface WorkflowLineageVersionRef {
  id: string;
  versionNumber: number;
  status: WorkflowDefinitionStatus;
  publishedAt: Date | null;
  /** Who last wrote the row. On the ACTIVE row that is the publisher — `publishEntity` stamps `updatedBy`. */
  publishedBy: string | null;
  updatedAt: Date;
  registryChecksum: string | null;
  compiledConfigChecksum: string | null;
}

/** TASK-965 (OD-965-3) — one SLUG and everything a lineage list row has to say about it. */
export interface WorkflowLineage {
  slug: string;
  name: string;
  paletteKey: string;
  versionCount: number;
  latestVersionNumber: number;
  deprecatedCount: number;
  active: WorkflowLineageVersionRef | null;
  draft: WorkflowLineageVersionRef | null;
  origin: { sourceTemplateSlug: string | null; templateLocked: boolean };
  tags: string[];
  updatedAt: Date;
}

export interface WorkflowLineageQuery {
  page?: number;
  limit?: number;
  paletteKey?: string;
  filters?: DbFilters;
  search?: string;
  searchFields?: string[];
}

/**
 * The columns a lineage projection reads. `graph`, `compiledConfig` and `validationReport` are
 * ABSENT on purpose — this read walks every live version row of a tenant, and a workflow's graph
 * is the largest JSON column in the schema.
 */
const WORKFLOW_LINEAGE_SELECT = {
  id: true,
  tenantId: true,
  slug: true,
  name: true,
  paletteKey: true,
  versionNumber: true,
  status: true,
  isActive: true,
  registryChecksum: true,
  compiledConfigChecksum: true,
  publishedAt: true,
  deprecatedAt: true,
  sourceTemplateSlug: true,
  templateLocked: true,
  tags: true,
  updatedAt: true,
  updatedBy: true,
} as const;

type WorkflowLineageRow = {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  paletteKey: string;
  versionNumber: number;
  status: WorkflowDefinitionStatus;
  isActive: boolean;
  registryChecksum: string | null;
  compiledConfigChecksum: string | null;
  publishedAt: Date | null;
  deprecatedAt: Date | null;
  sourceTemplateSlug: string | null;
  templateLocked: boolean;
  tags: string[];
  updatedAt: Date;
  updatedBy: string | null;
};

const OPEN_STATUSES: ReadonlySet<WorkflowDefinitionStatus> = new Set([WorkflowDefinitionStatus.DRAFT, WorkflowDefinitionStatus.VALIDATED]);

function workflowVersionRef(row: WorkflowLineageRow): WorkflowLineageVersionRef {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    status: row.status,
    publishedAt: row.publishedAt ?? null,
    publishedBy: row.updatedBy ?? null,
    updatedAt: row.updatedAt,
    registryChecksum: row.registryChecksum ?? null,
    compiledConfigChecksum: row.compiledConfigChecksum ?? null,
  };
}

/** Fold one slug's version rows (any order) into the lineage a list row renders. */
export function foldWorkflowLineage(rows: readonly WorkflowLineageRow[]): WorkflowLineage {
  const byVersionDesc = [...rows].sort((a, b) => b.versionNumber - a.versionNumber);
  const active = byVersionDesc.find((row) => row.status === WorkflowDefinitionStatus.PUBLISHED && row.isActive) ?? null;
  const draft = byVersionDesc.find((row) => OPEN_STATUSES.has(row.status)) ?? null;
  const naming = active ?? byVersionDesc[0];
  return {
    slug: naming.slug,
    name: naming.name,
    paletteKey: naming.paletteKey,
    versionCount: rows.length,
    latestVersionNumber: byVersionDesc[0].versionNumber,
    deprecatedCount: rows.filter((row) => row.status === WorkflowDefinitionStatus.DEPRECATED).length,
    active: active ? workflowVersionRef(active) : null,
    draft: draft ? workflowVersionRef(draft) : null,
    origin: { sourceTemplateSlug: naming.sourceTemplateSlug ?? null, templateLocked: naming.templateLocked ?? false },
    tags: naming.tags ?? [],
    updatedAt: rows.reduce((newest, row) => (row.updatedAt > newest ? row.updatedAt : newest), rows[0].updatedAt),
  };
}

/**
 * `WorkflowDefinition` — a single table whose rows ARE versions (see the
 * Prisma model's file header). Ordinary tenant-scoped, soft-deletable model
 * (in `TENANT_SCOPED_MODELS`, not in `MODELS_WITHOUT_SOFT_DELETE`).
 */
@Injectable()
export class WorkflowDefinitionRepository extends Repository<WorkflowDefinitionEntity, WorkflowDefinition> {
  /**
   * What "the tenant's live version of a slug" means, written ONCE.
   *
   * `findPublishedBySlug` (one slug) and `findActivePublishedByTenant` (the whole tenant) are
   * necessarily different queries, but they must select from the same population or the
   * single-slug answer and the list answer diverge — a slug a list route advertises that a
   * by-slug gate then refuses, or the reverse. Both spread this object rather than restating
   * the filter, so adding a condition to one is adding it to both.
   */
  private static readonly PUBLISHED_AND_ACTIVE = {
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    resourceStatus: ResourceStatusType.ENABLED,
  } as const;

  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'workflowDefinition', WorkflowDefinitionEntityMapper.getInstance());
  }

  /**
   * The row the exposure gateway invokes: the tenant's ACTIVE
   * PUBLISHED version of `slug`. Returns `null` — never throws — for a
   * foreign tenant's slug, an unpublished/inactive slug, or a slug that does
   * not exist at all, so the caller maps every one of those to a 404
   * (404-over-403; rule 04 §NEVER). Uses `findFirstTolerant` because the base
   * `findFirst` THROWS `DataNotFoundException` on a miss — a genuine miss
   * here is the expected common case, not an error.
   */
  async findPublishedBySlug(tenantId: string, slug: string): Promise<WorkflowDefinitionEntity | null> {
    return this.findFirstTolerant({ tenantId, slug, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE });
  }

  /**
   * TASK-965 (G7) — the PINNED version of a lineage, for a reader that was given an explicit
   * `versionNumber` rather than "whatever is active". The agent plane has had this read since
   * TASK-876 (`findPublishedVisibleBySlugVersion`) and the workflow plane did not, so a caller
   * holding a pin had only {@link findPublishedBySlug} — which answers the ACTIVE version and
   * would therefore serve a DIFFERENT version than the one named, silently.
   *
   * Deliberately NOT narrowed by `isActive`: the point of a pin is a version that may no longer
   * be the active one. `null` — never a throw — for a foreign, unknown, unpublished or deleted
   * version, so the caller maps all of those to one 404.
   */
  async findPublishedBySlugVersion(tenantId: string, slug: string, versionNumber: number): Promise<WorkflowDefinitionEntity | null> {
    return this.findFirstTolerant({
      tenantId,
      slug,
      versionNumber,
      status: WorkflowDefinitionStatus.PUBLISHED,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  }

  /**
   * TASK-965 (OD-965-3) — the caller's definitions ONE ROW PER SLUG, paginated BY SLUG.
   *
   * `GET admin/workflow-definitions` pages per VERSION, so a client that grouped that list into
   * lineages would fold whatever fragment of a lineage landed on its page — and the switcher and
   * the assignment picker silently truncate at 100/200 rows for the same reason. The fold happens
   * here instead, and `count` is a count of LINEAGES.
   *
   * The AGENT half's `findLineagesForTenant`, field for field; `paletteKey` takes the place of
   * `task` as the first-class narrowing.
   */
  async findLineagesForTenant(tenantId: string, query: WorkflowLineageQuery = {}): Promise<{ data: WorkflowLineage[]; count: number }> {
    const { skip, take, where } = formatFindAllProps({
      page: query.page,
      limit: query.limit,
      filters: query.filters,
      search: query.search,
      searchFields: query.searchFields,
    });
    const rows: WorkflowLineageRow[] = await this.db.findMany({
      where: {
        ...(where as Record<string, unknown>),
        tenantId,
        ...(query.paletteKey ? { paletteKey: query.paletteKey } : {}),
        resourceStatus: ResourceStatusType.ENABLED,
      },
      select: WORKFLOW_LINEAGE_SELECT,
      orderBy: [{ slug: 'asc' }, { versionNumber: 'desc' }],
    });

    const bySlug = new Map<string, WorkflowLineageRow[]>();
    for (const row of rows) {
      if (row.tenantId !== tenantId) continue;
      const group = bySlug.get(row.slug);
      if (group) group.push(row);
      else bySlug.set(row.slug, [row]);
    }

    const lineages = [...bySlug.values()]
      .map((group) => foldWorkflowLineage(group))
      .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));

    return { data: take ? lineages.slice(skip, skip + take) : lineages, count: lineages.length };
  }

  /**
   * The tenant's published + ACTIVE workflows, one row per slug (the movable
   * pointer means at most one such row per `(tenantId, slug)`) — backs
   * `GET /api/v1/workflows` ( exposure plane list route).
   */
  async findActivePublishedByTenant(tenantId: string): Promise<WorkflowDefinitionEntity[]> {
    return this.findAll({
      filters: { tenantId, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE },
      sort: [{ slug: 'asc' }],
    });
  }

  /**
   * Every version row for a `(tenantId, slug)` lineage, most recent first —
   * used to compute the next `versionNumber` and to resolve
   * `parentVersionId` branches.
   */
  async findAllVersionsBySlug(tenantId: string, slug: string): Promise<WorkflowDefinitionEntity[]> {
    return this.findAll({
      filters: { tenantId, slug, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ versionNumber: 'desc' }],
    });
  }

  /**
   * Every version row of this tenant bound to one consultation context schema, newest lineage
   * first — what the schema's "used by" read and its publish-impact gate walk.
   *
   * Reads the stamped COLUMN, never the `graph`/`compiledConfig` JSON: the column is written at
   * publish from the same resolution the compiler freezes, and only a column can be indexed
   * (`WorkflowDefinition_tenantId_contextSchemaId_idx`). A DRAFT is absent by construction — it
   * has no published binding yet, so it is not a consumer of anything.
   *
   * Deliberately NOT filtered to PUBLISHED + ACTIVE: a superseded or deprecated version is still
   * worth SHOWING an admin, and the caller (not this read) decides which rows count toward the
   * acknowledgement gate. It IS filtered to ENABLED — a soft-deleted definition is gone.
   */
  async findByContextSchemaId(tenantId: string, contextSchemaId: string): Promise<WorkflowDefinitionEntity[]> {
    return this.findAll({
      filters: { tenantId, contextSchemaId, resourceStatus: ResourceStatusType.ENABLED },
      sort: [{ slug: 'asc' }, { versionNumber: 'desc' }],
    });
  }

  /**
   * `max(versionNumber)` for a `(tenantId, slug)` lineage, `0` when the slug is new — the
   * `WorkflowDefinitionService.create` discipline (mirrors `PromptVersionRepository
   * .findMaxVersionNumber`): mint `max + 1` FROM THE TX CLIENT, never `currentVersionNumber +
   * 1`, so a lagging counter cannot recompute an existing versionNumber and trip the
   * `(tenantId, slug, versionNumber)` unique constraint. Deliberately NOT filtered by
   * `resourceStatus` — a soft-deleted row's versionNumber is still live in the DB unique index.
   */
  async findMaxVersionNumber(tenantId: string, slug: string, tx?: Prisma.TransactionClient | unknown): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors PromptVersionRepository.findMaxVersionNumber; the aggregate client shape isn't exposed through DomainModel typings.
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await model.aggregate({
      where: { tenantId, slug },
      _max: { versionNumber: true },
    });
    return result?._max?.versionNumber ?? 0;
  }

  /**
   * the ONE row a clone may be seeded from: `tenantId IN [caller, SYSTEM]`, and the
   * SYSTEM half narrowed to the platform template library ({@link PUBLISHED_AND_ACTIVE}).
   * Returns `null` for every other id, so the caller maps a foreign tenant's definition to a
   * 404 exactly like a nonexistent one (404-over-403).
   *
   * `client` is REQUIRED and is the UNSCOPED base client. `WorkflowDefinition` is deliberately
   * NOT a `SYSTEM_SHARED_READ_MODELS` member (`tenant-scope.ts`: "the SYSTEM-tenant
   * platform-default rows reach a tenant via the clone path, not shared read"), so the extended
   * client would THROW on the SYSTEM branch of this filter rather than serve it. Widening the
   * allow-list() instead would leak SYSTEM rows into every tenant's `list`, where `getById`
   * then 404s them. The tenant pin therefore lives HERE, explicitly, in the only query that is
   * allowed to see two tenants — the same posture (and the same justification) as
   * `TenantService.provisionTenantDepartmentCatalog`'s golden-department read.
   *
   * A tenant's OWN row is clonable at any status: forking your own draft is the ordinary case.
   * A SYSTEM row must be PUBLISHED + ACTIVE — a SYSTEM draft is unreleased platform work.
   */
  async findCloneSource(id: string, tenantId: string, client: unknown): Promise<WorkflowDefinitionEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors findMaxVersionNumber; the caller-supplied client's delegate shape isn't exposed through DomainModel typings.
    const model: any = (client as Record<string, any>)[this._modelName];
    const row = await model.findFirst({
      where: {
        id,
        resourceStatus: ResourceStatusType.ENABLED,
        OR: [{ tenantId }, { tenantId: SYSTEM_TENANT_ID, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE }],
      },
    });
    return row ? WorkflowDefinitionEntityMapper.getInstance().toDomainEntity(row) : null;
  }

  /**
   * the platform template library: the SYSTEM tenant's live published definitions,
   * one row per slug (the movable `isActive` pointer guarantees that). Same
   * {@link PUBLISHED_AND_ACTIVE} predicate `findCloneSource` accepts for a SYSTEM source, so
   * what a tenant can SEE in the library and what it can CLONE are the same set by
   * construction — a listed template that then refuses to clone would be the exact gap that
   * constant exists to prevent.
   *
   * Takes the UNSCOPED client for the reason spelled out on `findCloneSource`.
   */
  async findSystemTemplates(client: unknown): Promise<WorkflowDefinitionEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findCloneSource.
    const model: any = (client as Record<string, any>)[this._modelName];
    const rows = await model.findMany({
      where: { tenantId: SYSTEM_TENANT_ID, ...WorkflowDefinitionRepository.PUBLISHED_AND_ACTIVE },
      orderBy: [{ paletteKey: 'asc' }, { slug: 'asc' }],
    });
    const mapper = WorkflowDefinitionEntityMapper.getInstance();
    return rows.map((row: WorkflowDefinition) => mapper.toDomainEntity(row));
  }

  /**
   * `findFirst` throws `DataNotFoundException` on a miss. Only a genuine miss
   * maps to null — anything else (most importantly the tenant-scope
   * extension's cross-tenant throw) must SURFACE. Same treatment as
   * `ConsultationContextSchemaRepository.findFirstTolerant`.
   */
  private async findFirstTolerant(filters: Record<string, unknown>): Promise<WorkflowDefinitionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<WorkflowDefinition> would require importing the Prisma-generated model type here.
      const result = await this.findFirst({ filters: filters as any });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
