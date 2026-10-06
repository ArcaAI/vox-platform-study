import { Inject, Injectable } from '@nestjs/common';
import { Prisma, SYSTEM_TENANT_ID } from '@arcaai/database';

import { Repository } from '../../../common';
import { CoreDatabaseService } from '../../../common/databaseServices/core/core.database.service';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { GovernedPromptPieceEntity } from '../../../entities';
import { GovernedPromptPieceKind, GovernedPromptSourceType, GovernedPromptVerdict, ResourceStatusType } from '../../../enums';
import { JsonValue } from '../../../interfaces';
import { GovernedPromptPieceEntityMapper } from '../../../mappers';
import { GovernedPromptPiece } from '../../../models';
import { generateId } from '../../../utils';

/** One verdict to record — no text, ever (TASK-1047 FC-3). */
export interface GovernedPromptVerdictInput {
  tenantId: string;
  digest: string;
  policyVersion: string;
  kind: GovernedPromptPieceKind;
  sourceType: GovernedPromptSourceType;
  sourceId: string | null;
  sourceKey: string | null;
  verdict: GovernedPromptVerdict;
  findings: JsonValue | null;
  textChars: number;
  screenedAt: Date;
  /** Who caused the screen (`createdBy` / `updatedBy`); `null` for the boot backfill. */
  actorId: string | null;
}

/** A published agent the boot backfill must re-screen: the frozen artifact is the piece source. */
export interface GovernedBackfillAgentSource {
  id: string;
  tenantId: string;
  compiledConfig: unknown;
}

/** The APPROVED (pinned) version of a prompt template the boot backfill must re-screen. */
export interface GovernedBackfillVersionSource {
  id: string;
  tenantId: string;
  promptTemplateId: string;
  content: string;
}

/**
 * TASK-1047 — the governed-prompt registry.
 *
 * Every method uses the BASE client with an explicit `tenantId` (the `ComposedPromptRecord`
 * precedent), for three reasons the scoped client cannot serve:
 *  - the boot backfill runs with NO CLS tenant (the scope extension would throw), and walks every
 *    tenant's content;
 *  - platform pieces and promote-to-system register under SYSTEM while a TENANT request may be in
 *    CLS (the scope extension refuses a SYSTEM `tenantId` in a tenant context);
 *  - a call-time read must see [request tenant, SYSTEM] whatever is in CLS.
 * The model carries no text and no secret: a digest, a verdict and a source reference. Writes are
 * only ever issued by `GovernedPromptRegistryService`, which names the tenant it registers under.
 */
@Injectable()
export class GovernedPromptPieceRepository extends Repository<GovernedPromptPieceEntity, GovernedPromptPiece> {
  constructor(
    private readonly unitOfWorkService: CoreUnitOfWorkService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(unitOfWorkService, 'governedPromptPiece', GovernedPromptPieceEntityMapper.getInstance());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client(model: 'governedPromptPiece' | 'agent' | 'promptTemplate' | 'promptVersion'): any {
    return (this.databaseService.baseClient as unknown as Record<string, unknown>)[model];
  }

  private toEntity(model: GovernedPromptPiece): GovernedPromptPieceEntity {
    return GovernedPromptPieceEntityMapper.getInstance().toDomainEntity(model);
  }

  /** PASS rows for `digests` under `policyVersion`, owned by the tenant or SYSTEM. */
  async findPassing(tenantId: string, digests: readonly string[], policyVersion: string): Promise<GovernedPromptPieceEntity[]> {
    const unique = [...new Set(digests)];
    if (unique.length === 0) return [];
    const tenants = tenantId === SYSTEM_TENANT_ID ? [SYSTEM_TENANT_ID] : [tenantId, SYSTEM_TENANT_ID];
    const rows: GovernedPromptPiece[] = await this.client('governedPromptPiece').findMany({
      where: {
        tenantId: { in: tenants },
        digest: { in: unique },
        policyVersion,
        verdict: GovernedPromptVerdict.PASS,
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
    });
    return rows.map((row) => this.toEntity(row));
  }

  /** Record one verdict: ONE row per (tenant, digest, policyVersion); a re-screen refreshes it. */
  async upsertVerdict(input: GovernedPromptVerdictInput): Promise<GovernedPromptPieceEntity> {
    const fields = {
      kind: input.kind,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceKey: input.sourceKey,
      verdict: input.verdict,
      // A PASS after a FAIL must CLEAR the old findings, so null is written, never skipped.
      findings: input.findings ?? Prisma.DbNull,
      textChars: input.textChars,
      screenedAt: input.screenedAt,
    };
    const saved: GovernedPromptPiece = await this.client('governedPromptPiece').upsert({
      where: { tenantId_digest_policyVersion: { tenantId: input.tenantId, digest: input.digest, policyVersion: input.policyVersion } },
      create: {
        id: generateId(),
        tenantId: input.tenantId,
        digest: input.digest,
        policyVersion: input.policyVersion,
        ...fields,
        ...(input.actorId ? { createdBy: input.actorId } : {}),
      },
      update: {
        ...fields,
        resourceStatus: ResourceStatusType.ENABLED,
        updatedBy: input.actorId,
        version: { increment: 1 },
      },
    });
    return this.toEntity(saved);
  }

  /** Every verdict recorded for one source (newest first), optionally under one policy version. */
  async findBySource(sourceType: GovernedPromptSourceType, sourceId: string, policyVersion?: string): Promise<GovernedPromptPieceEntity[]> {
    const rows: GovernedPromptPiece[] = await this.client('governedPromptPiece').findMany({
      where: {
        sourceType,
        sourceId,
        ...(policyVersion !== undefined ? { policyVersion } : {}),
        resourceStatus: { not: ResourceStatusType.DELETED },
      },
      orderBy: [{ screenedAt: 'desc' }],
    });
    return rows.map((row) => this.toEntity(row));
  }

  /**
   * Boot backfill — every PUBLISHED agent across all tenants (id, tenant, frozen artifact).
   * A read projection, not entities: the backfill only needs the frozen prompt to re-derive pieces.
   */
  async findPublishedAgentSources(): Promise<GovernedBackfillAgentSource[]> {
    return this.client('agent').findMany({
      where: { status: 'PUBLISHED', resourceStatus: { not: ResourceStatusType.DELETED } },
      select: { id: true, tenantId: true, compiledConfig: true },
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    });
  }

  /** Boot backfill — the pinned version of every APPROVED prompt template across all tenants. */
  async findApprovedVersionSources(): Promise<GovernedBackfillVersionSource[]> {
    const templates: Array<{ id: string; approvedVersionNumber: number }> = await this.client('promptTemplate').findMany({
      where: { status: 'APPROVED', approvedVersionNumber: { not: null }, resourceStatus: { not: ResourceStatusType.DELETED } },
      select: { id: true, approvedVersionNumber: true },
    });
    if (templates.length === 0) return [];
    return this.client('promptVersion').findMany({
      where: { OR: templates.map((template) => ({ promptTemplateId: template.id, versionNumber: template.approvedVersionNumber })) },
      select: { id: true, tenantId: true, promptTemplateId: true, content: true },
      orderBy: [{ tenantId: 'asc' }, { id: 'asc' }],
    });
  }
}
