import {
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaScope,
  ConsultationContextSchemaStatus,
  ConsultationContextSchemaVersionRepository,
  DepartmentAgentEntity,
  DepartmentAgentFactory,
  DepartmentAgentRepository,
  DepartmentAgentRole,
  DepartmentEntity,
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
import {
  AgentLoopConfig,
  buildLoopConfigSnapshot,
  canonicalAgentConfigJson,
  hasLoopConfig,
  subscribedKindsProblems,
  writeScopeProblems,
} from './constants';

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
  /**
   * The seven loop-config fields (role/subscribedKinds/writeScope/goal/
   * guardrailProfile/alwaysActions/neverActions) were copied from the
   * golden source onto a new clone or a fast-forwarded row (OP-4). Zero today
   * for every real tenant because no SYSTEM golden agent sets any of the seven
   * fields yet — the counter exists so the day one does, propagation is visible
   * rather than a silent no-op.
   */
  configPropagated: number;
  /**
   * A golden agent's loop config could NOT be safely copied onto a tenant row —
   * it would create a second PRIMARY in the department, or reference a context
   * kind/output the target department's schema does not declare — and was left
   * untouched instead. Logged per-row with the specific reason(s); this counter
   * is the summary-level signal that the sweep did not silently drop work.
   */
  configBlocked: number;
}

/**
 * Reconcile ONE tenant's DepartmentAgent catalog against the SYSTEM agent
 * golden library. The SIBLING of `PipelineTemplateResyncService`
 * , applying the identical four conservative rules to a second
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
 * LOOP CONFIG (OP-4): the seven fields are copied onto a
 * tenant row at the SAME two proven-safe points above — (i) clone creation and
 * (ii) a content fast-forward — never independently of them. A locked row is
 * API-immutable (`assertNotTemplateLocked` blocks its entire `update()`), so
 * unlike template content there is no "customized by the tenant" risk to guard
 * against; the only real risk is writing a config that does not resolve in the
 * TARGET tenant (a `subscribedKinds`/`writeScope` kind the department's context
 * schema does not declare, or a `role: PRIMARY` that collides with an existing
 * PRIMARY). Both are checked with the same validation `AgentPromotionService`
 * applies before a cross-tenant promotion write (reimplemented locally — see
 * `loopConfigProblemsForTenant` — rather than imported, so this service and
 * `AgentPromotionService` evolve independently). A blocked row keeps its
 * current config, is logged, and counted in `configBlocked`; it is retried on
 * every subsequent run rather than silently dropped.
 *
 * Deliberately NOT independent of content: a golden agent whose loop config
 * changes without its template content also changing will not propagate until
 * the next content change bumps a clone past its anchor. Tracking config
 * staleness on its own timeline would need a second anchor (mirroring
 * `sourceTemplateVersionNumber`) purely to detect out-of-band config edits on
 * an API-immutable row — additional machinery with no present-day payoff, since
 * no golden agent sets any of the seven fields yet. See the Decisions section.
 *
 * TENANT CONTEXT: callers run this with an elevated, tenant-less context (a
 * super admin authenticates with an empty `tenantId`; the cron has no CLS at
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
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly contextSchemaVersionRepository: ConsultationContextSchemaVersionRepository,
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

    const summary: AgentTemplateResyncSummary = { added: 0, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 0 };

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
          // Reuse-only: no tenant department for this golden agent means the
          // tenant does not run that department. Skip it — do NOT provision one
          const cloneResult = await this.cloneGoldenIntoTenant(golden, tenantId);
          if (cloneResult.created) {
            summary.added += 1;
            if (cloneResult.configPropagated) summary.configPropagated += 1;
            if (cloneResult.configBlocked) summary.configBlocked += 1;
          } else {
            summary.skipped += 1;
            this.logger.log({
              message: 'Skipped golden agent - tenant has no department with this code',
              tenantId,
              goldenAgentSlug: golden.slug,
            });
          }
          continue;
        }

        const fastForwardResult = await this.fastForwardIfPristine(existing, golden, tenantId);
        if (fastForwardResult.contentAdvanced) {
          summary.fastForwarded += 1;
        } else {
          summary.skipped += 1;
        }
        if (fastForwardResult.configPropagated) summary.configPropagated += 1;
        if (fastForwardResult.configBlocked) summary.configBlocked += 1;
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

  /**
   * (i) The tenant has never had this golden agent — clone it in, locked.
   *
   * `created: false` when the tenant has no department for this golden agent,
   * in which case NOTHING is created (: resync reconciles agents
   * onto the tenant's existing departments; it must never provision one).
   * `configBlocked: true` when the golden agent DOES carry loop config (OP-4)
   * but it fails validation against the target department — the clone is still
   * created (template + lineage), just without the seven fields, which the
   * factory then defaults to "nothing configured".
   */
  private async cloneGoldenIntoTenant(
    golden: DepartmentAgentEntity,
    tenantId: string,
  ): Promise<{ created: boolean; configPropagated: boolean; configBlocked: boolean }> {
    const tenantDept = await this.resolveTenantDepartment(golden.departmentId, tenantId);
    if (!tenantDept) return { created: false, configPropagated: false, configBlocked: false };

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

    // OP-4 — the golden row's seven loop-config fields.
    // Applied only when the golden agent actually configures the loop surface
    // AND the config resolves in the target department; otherwise the clone
    // lands with the factory defaults ("nothing configured"), exactly as
    // before this change.
    const goldenLoopConfigSnapshot = buildLoopConfigSnapshot(golden);
    let configBlocked = false;
    let applyLoopConfig = false;
    if (hasLoopConfig(goldenLoopConfigSnapshot)) {
      const problems = await this.loopConfigProblemsForTenant(golden, tenantId, tenantDept.id);
      if (problems.length > 0) {
        configBlocked = true;
        this.logger.warn({
          message: 'Golden agent loop config could not be propagated to a new clone - leaving it unconfigured',
          tenantId,
          goldenAgentSlug: golden.slug,
          problems,
        });
      } else {
        applyLoopConfig = true;
      }
    }

    const clone = DepartmentAgentFactory.CreateDepartmentAgent({
      tenantId,
      departmentId: tenantDept.id,
      name: golden.name,
      slug: golden.slug,
      description: golden.description ?? undefined,
      promptTemplateId: savedTemplate.id,
      pinnedVersionNumber: null,
      role: applyLoopConfig ? golden.role : undefined,
      subscribedKinds: applyLoopConfig ? golden.subscribedKinds : undefined,
      writeScope: applyLoopConfig ? golden.writeScope : undefined,
      goal: applyLoopConfig ? golden.goal : undefined,
      guardrailProfile: applyLoopConfig ? golden.guardrailProfile : undefined,
      alwaysActions: applyLoopConfig ? golden.alwaysActions : undefined,
      neverActions: applyLoopConfig ? golden.neverActions : undefined,
      // Carry the golden row's capability bindings onto the
      // clone. Every SYSTEM golden agent has these NULL today, so this is
      // future-proofing with zero present-day effect (and the seeded ArcaAI
      // agents make the sweep a no-op for that tenant anyway).
      //
      // ASYMMETRY WORTH KNOWING (C3/C4 readers): only the BASE binding is
      // snapshotted into a fresh per-tenant template above. Capability bindings
      // are copied BY REFERENCE, so a golden row that ever sets one would leave
      // the clone pointing at the SYSTEM-owned template — readable since
      // PromptTemplate joined SYSTEM_SHARED_READ_MODELS, but NOT covered by the
      // pristine-detection anchor (`metaData.sourceTemplateVersionNumber`),
      // which only tracks the base template. If golden agents ever gain
      // capability bindings, extend the snapshot step rather than relying on
      // this copy.
      newPatientTemplateId: golden.newPatientTemplateId ?? null,
      revisitTemplateId: golden.revisitTemplateId ?? null,
      preSummaryTemplateId: golden.preSummaryTemplateId ?? null,
      livePromptTemplateId: golden.livePromptTemplateId ?? null,
      toolConfig: golden.toolConfig ?? null,
      llmOverrides: golden.llmOverrides ?? null,
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

    const configPropagated = hasLoopConfig(goldenLoopConfigSnapshot) && !configBlocked;

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
        configPropagated,
        configBlocked,
      },
    });
    return { created: true, configPropagated, configBlocked };
  }

  /**
   * (ii)/(iii)/(iv) — advance a pristine locked clone to the golden template's
   * current content, and (OP-4) propagate the seven loop-config fields at that
   * SAME sync point when they differ from golden. `contentAdvanced` is true
   * exactly when a fast-forward was written (unchanged contract). Config
   * propagation only runs once content has been proven safe to advance —
   * `configPropagated`/`configBlocked` are therefore always `false` whenever
   * `contentAdvanced` is `false` (see the class doc comment for why config has
   * no independent trigger).
   */
  private async fastForwardIfPristine(
    existing: DepartmentAgentEntity,
    golden: DepartmentAgentEntity,
    tenantId: string,
  ): Promise<{ contentAdvanced: boolean; configPropagated: boolean; configBlocked: boolean }> {
    const noOp = { contentAdvanced: false, configPropagated: false, configBlocked: false };

    // (iii) unlocked → the tenant owns this clone.
    if (!existing.templateLocked) {
      return noOp;
    }

    const goldenTemplate = await this.promptTemplateRepository.findById(golden.promptTemplateId);
    if (!goldenTemplate) {
      return noOp;
    }
    const goldenCurrentVersion = goldenTemplate.currentVersionNumber ?? 1;
    const anchor = this.sourceTemplateVersion(existing);

    // Already current — the idempotency branch.
    if (goldenCurrentVersion <= anchor) {
      return noOp;
    }

    const tenantTemplate = await this.promptTemplateRepository.findById(existing.promptTemplateId);
    if (!tenantTemplate) {
      return noOp;
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
      return noOp;
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

    // OP-4 — propagate the seven loop-config fields at this SAME
    // proven-safe sync point, when golden's config differs from what the clone
    // already carries. A locked row is API-immutable, so "differs" can only
    // mean golden moved or the row has never been synced — never a tenant edit.
    const existingConfigJson = canonicalAgentConfigJson(buildLoopConfigSnapshot(existing));
    const goldenConfigJson = canonicalAgentConfigJson(buildLoopConfigSnapshot(golden));
    let configPropagated = false;
    let configBlocked = false;
    if (existingConfigJson !== goldenConfigJson) {
      const problems = await this.loopConfigProblemsForTenant(golden, tenantId, existing.departmentId, existing.id);
      if (problems.length > 0) {
        configBlocked = true;
        this.logger.warn({
          message: "Golden agent loop config could not be propagated - leaving the clone's config unchanged",
          tenantId,
          agentId: existing.id,
          slug: existing.slug,
          problems,
        });
      } else {
        existing.role = golden.role;
        existing.subscribedKinds = golden.subscribedKinds ?? null;
        existing.writeScope = golden.writeScope ?? null;
        existing.goal = golden.goal ?? null;
        existing.guardrailProfile = golden.guardrailProfile ?? null;
        existing.alwaysActions = golden.alwaysActions ?? null;
        existing.neverActions = golden.neverActions ?? null;
        configPropagated = true;
      }
    }

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
        configPropagated,
        configBlocked,
      },
    });

    return { contentAdvanced: true, configPropagated, configBlocked };
  }

  /**
   * Cross-tenant reference safety for propagated loop config (OP-4) — mirrors
   * the validation `AgentPromotionService` runs before writing another
   * tenant's agent (`assertContextKindsDeclaredInTarget` /
   * `assertPrimaryRoleAvailable`), reimplemented locally rather than imported
   * so this service and `AgentPromotionService` (owned by a separate ticket)
   * can evolve independently — both are pure reads over the SAME allow-list
   * helpers in `./constants`. Returns problem strings; empty ⇒ safe to write.
   */
  private async loopConfigProblemsForTenant(
    config: AgentLoopConfig,
    tenantId: string,
    departmentId: string,
    excludeAgentId?: string,
  ): Promise<string[]> {
    const problems: string[] = [];

    if (config.role === DepartmentAgentRole.PRIMARY) {
      const existingPrimary = await this.agentRepository.findPrimaryForDepartment(tenantId, departmentId, excludeAgentId);
      if (existingPrimary) {
        problems.push(`role PRIMARY would conflict with the existing PRIMARY agent '${existingPrimary.slug}' in the department`);
      }
    }

    const kindKeys = config.subscribedKinds ? subscribedKindsProblems(config.subscribedKinds).kindKeys : [];
    const outputKeys = config.writeScope ? writeScopeProblems(config.writeScope).outputKeys : [];
    if (kindKeys.length > 0 || outputKeys.length > 0) {
      const declared = await this.resolveServableContextDefinition(tenantId, departmentId);
      if (!declared) {
        problems.push('references context kinds/outputs but the department has no published context schema to resolve them against');
      } else {
        const missingKinds = kindKeys.filter((key) => !declared.kinds.has(key));
        const missingOutputs = outputKeys.filter((key) => !declared.outputs.has(key));
        if (missingKinds.length > 0) problems.push(`subscribes to undeclared kind(s): ${missingKinds.join(', ')}`);
        if (missingOutputs.length > 0) problems.push(`writes undeclared output(s): ${missingOutputs.join(', ')}`);
      }
    }

    return problems;
  }

  /**
   * The department's servable context vocabulary — the same DEPARTMENT →
   * TENANT cascade `ConsultationContextSchemaService`/`AgentPromotionService`
   * use, read with an explicit `tenantId` since the extension injects nothing
   * on this elevated, tenant-less path.
   */
  private async resolveServableContextDefinition(
    tenantId: string,
    departmentId: string,
  ): Promise<{ kinds: Set<string>; outputs: Set<string> } | null> {
    const candidates = [
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.DEPARTMENT, departmentId),
      await this.contextSchemaRepository.findDefaultForScope(tenantId, ConsultationContextSchemaScope.TENANT, null),
    ];

    for (const schema of candidates) {
      if (!schema) continue;
      const servable =
        schema.pinnedVersionNumber != null &&
        (schema.status === ConsultationContextSchemaStatus.PUBLISHED || schema.status === ConsultationContextSchemaStatus.APPROVED);
      if (!servable) continue;
      const version = await this.contextSchemaVersionRepository.findBySchemaAndVersionNumber(schema.id, schema.pinnedVersionNumber as number);
      if (version) return extractDeclaredContextKeys(version.definition);
    }
    return null;
  }

  /**
   * Resolve the tenant's department for a golden department — REUSE ONLY.
   *
   * Returns the tenant's same-code department, or `null` when the tenant does
   * not have one. It NEVER creates a department.
   *
   * This used to clone the golden department shape into the tenant on a miss
   * . That made the SYSTEM golden catalog the de-facto source of
   * every tenant's department list: `GOLDEN_DEPARTMENTS` derives from the Global
   * `DEFAULT_DEPARTMENTS`, so each sweep provisioned one tenant department per
   * Global department, forever. It gave the ArcaAI tenant 15 departments in a
   * 629 ms window on 2026-07-30 — including six the tenant's own clinical model
   * does not have — and made deleting them futile, because the next sweep put
   * them straight back.
   *
   * A tenant's department set is authoritative and is owned by the tenant (for
   * ArcaAI it is pinned to HOPE v1's eleven; see the seed and ).
   * Resync reconciles AGENTS onto departments that already exist; it is not a
   * department provisioner. A golden agent whose department the tenant lacks is
   * skipped and logged, not silently materialized.
   */
  private async resolveTenantDepartment(goldenDepartmentId: string, tenantId: string): Promise<DepartmentEntity | null> {
    const goldenDept = await this.departmentRepository.findById(goldenDepartmentId);
    if (!goldenDept.code) return null;
    return (await this.departmentRepository.findByCode(tenantId, goldenDept.code)) ?? null;
  }

  /** The version the clone's content was taken from (default 1 for legacy rows). */
  private sourceTemplateVersion(agent: DepartmentAgentEntity): number {
    const raw = (agent.metaData as Record<string, unknown> | null | undefined)?.['sourceTemplateVersionNumber'];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
  }
}

/**
 * Every declared `kinds[].key` / `outputs[].key` in a ConsultationContextSchemaVersion
 * `definition` document — the SAME extraction `DepartmentAgentService` and
 * `AgentPromotionService` each keep their own copy of (small, pure, dependency-free;
 * kept local per this module's convention rather than imported).
 */
function extractDeclaredContextKeys(definition: unknown): { kinds: Set<string>; outputs: Set<string> } {
  const kinds = new Set<string>();
  const outputs = new Set<string>();
  if (definition !== null && typeof definition === 'object' && !Array.isArray(definition)) {
    const def = definition as Record<string, unknown>;
    if (Array.isArray(def.kinds)) {
      for (const kind of def.kinds) {
        const key = (kind as Record<string, unknown> | null)?.key;
        if (typeof key === 'string') kinds.add(key);
      }
    }
    if (Array.isArray(def.outputs)) {
      for (const output of def.outputs) {
        const key = (output as Record<string, unknown> | null)?.key;
        if (typeof key === 'string') outputs.add(key);
      }
    }
  }
  return { kinds, outputs };
}
