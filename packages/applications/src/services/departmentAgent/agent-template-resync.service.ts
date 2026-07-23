import {
  DepartmentAgentEntity,
  DepartmentAgentFactory,
  DepartmentAgentRepository,
  DepartmentEntity,
  DepartmentFactory,
  DepartmentRepository,
  PromptTemplateFactory,
  PromptTemplateRepository,
  PromptVersionFactory,
  PromptVersionRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';

/**
 * Reserved SYSTEM tenant that owns the master agent golden library. Mirrors the
 * literal already duplicated across `base.service.ts` / `tenant.service.ts` /
 * `pipeline-template-resync.service.ts` — kept local by the same convention so
 * this module carries no database dependency.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Per-run outcome, surfaced to the admin trigger and logged by the cron. */
export interface AgentTemplateResyncSummary {
  /** Golden agents the tenant did not have; cloned in as locked copies. */
  added: number;
  /** Pristine locked clones advanced to the golden template's current content. */
  fastForwarded: number;
  /** Rows left alone — customized, unlocked, drifted, or already current. */
  skipped: number;
}

/**
 * Reconcile ONE tenant's DepartmentAgent catalog against the SYSTEM agent
 * golden library (TASK-548). The SIBLING of `PipelineTemplateResyncService`
 * (TASK-531), applying the identical four conservative rules to a second
 * resource family. `PipelineTemplateResyncService` is NOT modified.
 *
 * Clone-on-provision (`TenantService.provisionTenantAgentCatalog`) runs exactly
 * once, at tenant creation. A tenant created before a golden agent existed never
 * receives it, and every clone stays frozen at its clone-time content even after
 * the golden template improves. This service is the missing reconciler for
 * EXISTING tenants, and it is intentionally conservative (it runs unattended
 * from a nightly cron, so the cost of a wrong write is a customer's lost work):
 *
 *   (i)   golden slug absent for the tenant → clone it (locked + lineage +
 *         APPROVED template snapshot + v1 version), reusing the provisioning
 *         mechanics.
 *   (ii)  LOCKED clone that is PRISTINE (its bound template content still equals
 *         the golden content at the version it was cloned from) and behind the
 *         golden template → fast-forward the bound template to the golden's
 *         current content, write a new version snapshot, bump the clone's
 *         `sourceTemplateVersionNumber` anchor, stay locked.
 *   (iii) UNLOCKED clone → NEVER touched. The tenant owns it (either customized
 *         via clone-to-customize, or a hand-created agent).
 *   (iv)  LOCKED clone whose bound template content no longer matches the golden
 *         source version (an out-of-band DB edit) → skipped and logged. Locked
 *         clones cannot drift through the API, so a mismatch is work we cannot
 *         account for; we report it rather than overwrite it.
 *
 * Idempotent by construction: after a fast-forward the clone's anchor equals the
 * golden current version, so the next run lands in the "already current" skip
 * branch and yields zeroes.
 *
 * TENANT CONTEXT: callers run this with an elevated, tenant-less context (a
 * global admin authenticates with an empty `tenantId`; the cron has no CLS at
 * all). Both make the tenant-scope Prisma extension pass through in its elevated
 * mode — the same path `PipelineTemplateResyncService` relies on to read the
 * SYSTEM catalog and write into a tenant that is not the caller's. The target
 * tenant is therefore always passed explicitly and never read from CLS.
 */
@Injectable()
export class AgentTemplateResyncService extends BaseService {
  private readonly logger = new Logger(AgentTemplateResyncService.name);

  constructor(
    private readonly agentRepository: DepartmentAgentRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.DepartmentAgent);
  }

  async resyncTenant(tenantId: string): Promise<AgentTemplateResyncSummary> {
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      // The SYSTEM library IS the template source; reconciling it against itself
      // is meaningless and would clone every row into itself.
      throw new BadRequestException('Cannot resync the SYSTEM tenant against itself');
    }

    const summary: AgentTemplateResyncSummary = { added: 0, fastForwarded: 0, skipped: 0 };

    const goldenAgents = await this.agentRepository.findAll({
      filters: { tenantId: SYSTEM_TENANT_ID, resourceStatus: 'ENABLED' },
    } as never);

    if (goldenAgents.length === 0) {
      this.logger.warn({ message: 'No SYSTEM golden agents to resync from', tenantId });
      return summary;
    }

    // One read of the tenant's catalog (all statuses — a DISABLED clone is still
    // a clone and must not be re-cloned into a duplicate slug).
    const existingRows = await this.agentRepository.findAll({ filters: { tenantId } } as never);
    const bySlug = new Map(existingRows.map((row) => [row.slug, row]));

    for (const golden of goldenAgents) {
      try {
        const existing = bySlug.get(golden.slug);

        if (!existing) {
          await this.cloneGoldenIntoTenant(golden, tenantId);
          summary.added += 1;
          continue;
        }

        if (await this.fastForwardIfPristine(existing, golden, tenantId)) {
          summary.fastForwarded += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        // Per-row isolation: one bad golden agent must never abort the rest
        // (mirrors `provisionTenantAgentCatalog`).
        summary.skipped += 1;
        this.logger.warn({
          message: 'Failed to resync golden agent for tenant - continuing',
          tenantId,
          goldenAgentSlug: golden.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({ message: 'Agent template resync completed', tenantId, ...summary });
    return summary;
  }

  /** (i) The tenant has never had this golden agent — clone it in, locked. */
  private async cloneGoldenIntoTenant(golden: DepartmentAgentEntity, tenantId: string): Promise<void> {
    const tenantDept = await this.resolveOrCreateTenantDepartment(golden.departmentId, tenantId);

    const goldenTemplate = await this.promptTemplateRepository.findById(golden.promptTemplateId);
    if (!goldenTemplate) {
      throw new Error(`Golden agent ${golden.slug} binds a missing template ${golden.promptTemplateId}`);
    }
    const goldenVersion = goldenTemplate.currentVersionNumber ?? 1;

    const snapshot = PromptTemplateFactory.CreatePromptTemplate({
      tenantId,
      // Name after the AGENT (unique per department), NOT the shared golden
      // template: the catch-all backs several departments, so a per-agent
      // snapshot named after the template would collide on the PromptTemplate
      // `(tenantId, name)` unique index.
      name: golden.name,
      description: goldenTemplate.description ?? undefined,
      content: goldenTemplate.content ?? undefined,
      category: goldenTemplate.category ?? undefined,
      status: 'APPROVED',
      variables: (goldenTemplate.variables as Record<string, unknown> | null) ?? undefined,
      departmentId: tenantDept.id,
      currentVersionNumber: 1,
      tags: goldenTemplate.tags ?? [],
      createdBy: this.requestUserId ?? undefined,
    });
    const savedTemplate = await this.promptTemplateRepository.create(snapshot);

    const v1 = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: savedTemplate.id,
      versionNumber: 1,
      content: savedTemplate.content ?? undefined,
      variables: (savedTemplate.variables as Record<string, unknown> | null) ?? undefined,
      changeReason: 'Added by SYSTEM agent golden library resync (TASK-548)',
      changedBy: this.requestUserId ?? undefined,
      createdBy: this.requestUserId ?? undefined,
    });
    await this.promptVersionRepository.create(v1);

    const clone = DepartmentAgentFactory.CreateDepartmentAgent({
      tenantId,
      departmentId: tenantDept.id,
      name: golden.name,
      slug: golden.slug,
      description: golden.description ?? undefined,
      promptTemplateId: savedTemplate.id,
      pinnedVersionNumber: null,
      templateLocked: true,
      sourceAgentTemplateSlug: golden.slug,
      metaData: { sourceTemplateVersionNumber: goldenVersion },
      tags: golden.tags ?? [],
      createdBy: this.requestUserId ?? undefined,
    });
    const savedAgent = await this.agentRepository.create(clone);

    if (golden.isDefault) {
      await this.agentRepository.setDefaultForDepartment(tenantId, tenantDept.id, savedAgent.id, this.requestUserId ?? undefined);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedAgent.id,
      createdAt: savedAgent.createdAt,
      data: {
        // NOTE: the event's own `tenantId` is CLS-sourced (a BaseService
        // security boundary), which for this elevated path resolves to SYSTEM.
        // The TARGET tenant therefore travels in the payload.
        tenantId,
        slug: savedAgent.slug,
        sourceAgentTemplateSlug: savedAgent.sourceAgentTemplateSlug ?? null,
        resyncAction: 'added',
      },
    });
  }

  /**
   * (ii)/(iii)/(iv) — advance a pristine locked clone to the golden template's
   * current content. Returns true when a fast-forward was written.
   */
  private async fastForwardIfPristine(existing: DepartmentAgentEntity, golden: DepartmentAgentEntity, tenantId: string): Promise<boolean> {
    // (iii) unlocked → the tenant owns this clone.
    if (!existing.templateLocked) {
      return false;
    }

    const goldenTemplate = await this.promptTemplateRepository.findById(golden.promptTemplateId);
    if (!goldenTemplate) {
      return false;
    }
    const goldenCurrentVersion = goldenTemplate.currentVersionNumber ?? 1;
    const anchor = this.sourceTemplateVersion(existing);

    // Already current — the idempotency branch.
    if (goldenCurrentVersion <= anchor) {
      return false;
    }

    const tenantTemplate = await this.promptTemplateRepository.findById(existing.promptTemplateId);
    if (!tenantTemplate) {
      return false;
    }

    // (iv) pristine check: the clone's bound content must still equal the golden
    // content at the version it was cloned from. When the golden source version
    // row is missing there is nothing to prove drift against, so we conservatively
    // skip rather than overwrite.
    const goldenAtAnchor = await this.promptVersionRepository.findByVersionNumber(golden.promptTemplateId, anchor);
    if (!goldenAtAnchor || tenantTemplate.content !== goldenAtAnchor.content) {
      this.logger.warn({
        message: 'Locked agent template drifted from its golden source version - skipping fast-forward',
        tenantId,
        agentId: existing.id,
        slug: existing.slug,
      });
      return false;
    }

    // Fast-forward the tenant template content to the golden current content,
    // write a new version snapshot, and bump the clone's anchor.
    const previousTemplateVersion = tenantTemplate.version;
    const nextVersionNumber = (await this.promptVersionRepository.findMaxVersionNumber(tenantTemplate.id)) + 1;
    tenantTemplate.content = goldenTemplate.content ?? null;
    tenantTemplate.currentVersionNumber = nextVersionNumber;
    tenantTemplate.updatedBy = this.requestUserId ?? null;
    const updatedTemplate = await this.promptTemplateRepository.updateWithVersion(tenantTemplate.id, tenantTemplate, previousTemplateVersion);

    const version = PromptVersionFactory.CreatePromptVersion({
      tenantId,
      promptTemplateId: updatedTemplate.id,
      versionNumber: nextVersionNumber,
      content: updatedTemplate.content ?? undefined,
      variables: (updatedTemplate.variables as Record<string, unknown> | null) ?? undefined,
      changeReason: `Fast-forwarded to SYSTEM golden template '${golden.slug}' by resync (TASK-548)`,
      changedBy: this.requestUserId ?? undefined,
      createdBy: this.requestUserId ?? undefined,
    });
    await this.promptVersionRepository.create(version);

    const previousAgentVersion = existing.version;
    existing.metaData = { ...(existing.metaData ?? {}), sourceTemplateVersionNumber: goldenCurrentVersion };
    existing.updatedBy = this.requestUserId ?? null;
    const updatedAgent = await this.agentRepository.updateWithVersion(existing.id, existing, previousAgentVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: existing.id,
      data: {
        tenantId,
        slug: existing.slug,
        sourceAgentTemplateSlug: existing.sourceAgentTemplateSlug ?? null,
        previousTemplateVersion,
        newSourceTemplateVersionNumber: goldenCurrentVersion,
        agentVersion: updatedAgent.version,
        resyncAction: 'fastForwarded',
      },
    });

    return true;
  }

  /**
   * Resolve the tenant's department for a golden department: reuse the
   * same-code department when it exists, else clone the golden department shape.
   */
  private async resolveOrCreateTenantDepartment(goldenDepartmentId: string, tenantId: string): Promise<DepartmentEntity> {
    const goldenDept = await this.departmentRepository.findById(goldenDepartmentId);
    const existing = goldenDept.code ? await this.departmentRepository.findByCode(tenantId, goldenDept.code) : null;
    if (existing) {
      return existing;
    }

    const department = DepartmentFactory.CreateDepartment({
      tenantId,
      code: goldenDept.code ?? undefined,
      name: goldenDept.name ?? undefined,
      description: goldenDept.description ?? undefined,
      defaultSummaryTemplate: goldenDept.defaultSummaryTemplate ?? undefined,
      promptConfig: (goldenDept.promptConfig as Record<string, unknown> | null) ?? undefined,
      createdBy: this.requestUserId ?? undefined,
    });
    return this.departmentRepository.create(department);
  }

  /** The version the clone's content was taken from (default 1 for legacy rows). */
  private sourceTemplateVersion(agent: DepartmentAgentEntity): number {
    const raw = (agent.metaData as Record<string, unknown> | null | undefined)?.['sourceTemplateVersionNumber'];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  }
}
