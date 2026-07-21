import {
  AsrPipelineEntity,
  AsrPipelineFactory,
  AsrPipelineRepository,
  AsrPipelineVersionFactory,
  AsrPipelineVersionRepository,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Reserved SYSTEM tenant that owns the master pipeline catalog. Mirrors the
 * literal already duplicated in `base.service.ts` / `tenant.service.ts` — kept
 * local by the same convention so this module carries no database dependency.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Per-run outcome, surfaced to the admin trigger and logged by the cron. */
export interface PipelineTemplateResyncSummary {
  /** Templates the tenant did not have; cloned in as locked copies. */
  added: number;
  /** Pristine locked copies advanced to the template's current config. */
  fastForwarded: number;
  /** Rows left alone — customized, unlocked, drifted, or already current. */
  skipped: number;
}

/**
 * Reconcile ONE tenant's pipeline catalog against the
 * SYSTEM templates.
 *
 * Clone-on-provision (`TenantService.provisionTenantPipelineCatalog`) runs
 * exactly once, at tenant creation. So a tenant created before a template
 * existed never receives it, and every copy stays frozen at its clone-time
 * config even after the template improves. This service is the missing
 * reconciler for EXISTING tenants.
 *
 * It is intentionally conservative — it runs unattended from a nightly cron, so
 * the cost of a wrong write is a customer's lost configuration:
 *
 *   (i)   template slug absent for the tenant → clone it (locked + lineage +
 *         v1 snapshot), reusing the provisioning mechanics.
 *   (ii)  LOCKED copy that is consistent with its own version history and
 *         behind the template → fast-forward the YAML, write a new snapshot,
 *         stay locked.
 *   (iii) UNLOCKED row → NEVER touched. Either the tenant customized it, or the
 *         lineage backfill could not prove it pristine and deliberately left it
 *         unlocked. Both mean "hands off".
 *   (iv)  LOCKED copy whose YAML no longer matches its own latest snapshot →
 *         skipped and logged. Locked rows cannot drift through the API once the
 *         write guards land, so a mismatch means an out-of-band DB edit; we
 *         report it rather than overwrite work we cannot account for.
 *
 * Idempotent by construction: after a fast-forward the copy equals the template
 * and lands in the "already current" skip branch, so re-running yields zeroes.
 *
 * TENANT CONTEXT: callers run this with an elevated, tenant-less context (a
 * global admin authenticates with an empty `tenantId`; the cron has no CLS at
 * all). Both make `ClsTenantContextProvider.getTenantId()` return `undefined`,
 * which puts the tenant-scope Prisma extension into its elevated pass-through —
 * the same path `provisionTenantPipelineCatalog` already relies on to write
 * into a tenant that is not the caller's. The target tenant is therefore always
 * passed explicitly and never read from CLS.
 */
@Injectable()
export class PipelineTemplateResyncService extends BaseService {
  private readonly logger = new Logger(PipelineTemplateResyncService.name);

  constructor(
    private readonly pipelineRepository: AsrPipelineRepository,
    private readonly versionRepository: AsrPipelineVersionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AsrPipeline);
  }

  async resyncTenant(tenantId: string): Promise<PipelineTemplateResyncSummary> {
    if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
      // The SYSTEM catalog IS the template source; reconciling it against
      // itself is meaningless and would clone every row into itself.
      throw new BadRequestException('Cannot resync the SYSTEM tenant against itself');
    }

    const templates = await this.pipelineRepository.findEnabledPipelines(SYSTEM_TENANT_ID);
    const summary: PipelineTemplateResyncSummary = { added: 0, fastForwarded: 0, skipped: 0 };

    if (templates.length === 0) {
      this.logger.warn({ message: 'No SYSTEM ASR pipeline templates to resync from', tenantId });
      return summary;
    }

    // One read of the tenant's catalog (all statuses — a DISABLED copy is still
    // a copy and must not be re-cloned into a duplicate slug).
    const existingRows = await this.pipelineRepository.findAllForAdmin(tenantId);
    const bySlug = new Map(existingRows.map((row) => [row.slug, row]));

    for (const template of templates) {
      try {
        const existing = bySlug.get(template.slug);

        if (!existing) {
          await this.cloneTemplateIntoTenant(template, tenantId);
          summary.added += 1;
          continue;
        }

        if (await this.fastForwardIfPristine(existing, template, tenantId)) {
          summary.fastForwarded += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (error) {
        // Per-row isolation: one bad template must never abort the rest of the
        // catalog (mirrors `provisionTenantPipelineCatalog`).
        summary.skipped += 1;
        this.logger.warn({
          message: 'Failed to resync ASR pipeline template for tenant - continuing',
          tenantId,
          templateSlug: template.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log({ message: 'Pipeline template resync completed', tenantId, ...summary });
    return summary;
  }

  /** (i) The tenant has never had this template — clone it in, locked. */
  private async cloneTemplateIntoTenant(template: AsrPipelineEntity, tenantId: string): Promise<void> {
    const clone = AsrPipelineFactory.CreateAsrPipeline({
      tenantId,
      name: template.name,
      slug: template.slug,
      description: template.description ?? undefined,
      // The template ROW's `configYaml` is the authoritative live config (it is
      // what the STT runtime resolves); its version rows are history derived
      // from it. Unlike `provisionTenantPipelineCatalog`, which reads the
      // newest snapshot, we take the row directly — the two can only ever
      // disagree if the template itself drifted, and in that case the row wins.
      configYaml: template.configYaml,
      tags: template.tags,
      templateLocked: true,
      sourceTemplateSlug: template.slug,
      createdBy: this.requestUserId ?? undefined,
    });

    const saved = await this.pipelineRepository.create(clone);
    await this.snapshotVersion(
      saved,
      tenantId,
      'Added by SYSTEM pipeline template resync (TASK-531)',
    );

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        // NOTE: the event's own `tenantId` is always CLS-sourced (a security
        // boundary in BaseService), which for this elevated path resolves to
        // SYSTEM. The TARGET tenant therefore travels in the payload.
        tenantId,
        slug: saved.slug,
        sourceTemplateSlug: saved.sourceTemplateSlug ?? null,
        resyncAction: 'added',
      },
    });
  }

  /**
   * (ii)/(iii)/(iv) — advance a pristine locked copy to the template's current
   * config. Returns true when a fast-forward was written.
   */
  private async fastForwardIfPristine(
    existing: AsrPipelineEntity,
    template: AsrPipelineEntity,
    tenantId: string,
  ): Promise<boolean> {
    // (iii) unlocked → the tenant owns this row.
    if (!existing.templateLocked) {
      return false;
    }

    // Fast-forward target: the template row's live config (see the note in
    // `cloneTemplateIntoTenant`).
    const templateConfigYaml = template.configYaml;

    // Already current — the idempotency branch.
    if (existing.configYaml === templateConfigYaml) {
      return false;
    }

    // (iv) the copy must still match its own latest snapshot. When it has no
    // version history at all (rows created by the seed, which writes none) there
    // is nothing to contradict the lock, and the lock was only ever granted to a
    // provably-pristine row — so an empty history is treated as consistent.
    const ownVersions = await this.versionRepository.findByPipeline(existing.id);
    const ownLatestYaml = ownVersions[0]?.configYaml;
    if (ownLatestYaml !== undefined && ownLatestYaml !== existing.configYaml) {
      this.logger.warn({
        message: 'Locked pipeline copy drifted from its own version history - skipping fast-forward',
        tenantId,
        pipelineId: existing.id,
        slug: existing.slug,
      });
      return false;
    }

    const previousVersion = existing.version;
    existing.configYaml = templateConfigYaml;
    existing.updatedBy = this.requestUserId ?? null;

    const updated = await this.pipelineRepository.updateWithVersion(
      existing.id,
      existing,
      existing.version,
    );

    await this.snapshotVersion(
      updated,
      tenantId,
      `Fast-forwarded to SYSTEM template '${template.slug}' by resync (TASK-531)`,
    );

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: existing.id,
      data: {
        tenantId,
        slug: existing.slug,
        sourceTemplateSlug: existing.sourceTemplateSlug ?? null,
        previousVersion,
        newVersion: updated.version,
        resyncAction: 'fastForwarded',
      },
    });

    return true;
  }

  /** Write the pipeline's current config as its next version snapshot. */
  private async snapshotVersion(
    pipeline: AsrPipelineEntity,
    tenantId: string,
    changeReason: string,
  ): Promise<void> {
    const versionNumber = await this.versionRepository.getNextVersionNumber(pipeline.id);
    const version = AsrPipelineVersionFactory.CreateAsrPipelineVersion({
      asrPipelineId: pipeline.id,
      versionNumber,
      configYaml: pipeline.configYaml,
      name: pipeline.name,
      description: pipeline.description ?? null,
      changeReason,
      changedBy: this.requestUserId ?? null,
      tenantId,
      createdBy: this.requestUserId ?? undefined,
    });
    await this.versionRepository.create(version);
  }
}
