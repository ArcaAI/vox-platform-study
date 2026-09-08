import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  AgentEntity,
  AgentFactory,
  AgentModelFallbackEntity,
  AgentModelFallbackFactory,
  AgentModelFallbackRepository,
  AgentPromotionFactory,
  AgentPromotionRepository,
  AgentRepository,
  AiModelRepository,
  ConsultationContextSchemaEntity,
  ConsultationContextSchemaRepository,
  ConsultationContextSchemaVersionRepository,
  CoreDatabaseService,
  PromptTemplateFactory,
  PromptTemplateRepository,
  PromptVersionFactory,
  PromptVersionRepository,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import { canonicalJson } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { IActiveUserContext } from '../../interfaces';
import { IAgentService } from '../agent/IAgentService';
import { IConsultationContextSchemaService } from '../consultation-context-schema/IConsultationContextSchemaService';
import { IAgentPromoteToSystemService } from './IAgentPromoteToSystemService';
import { PromoteAgentToSystemRequest, PromoteAgentToSystemResponse } from './dto';
import { runInTenantContext } from './tenant-context';

/**
 * The Global build tenant. A LITERAL, exactly as `WorkflowDefinitionService` and
 * `ServiceAccountService` carry it — there is no shared constant, and inventing one here would
 * suggest `50000000-…` is a config TIER. It is not: it is a CUSTOMER tenant used as the platform
 * admin's playground (`00-project-context.md` §"The two reserved tenants are NOT two config
 * tiers"), and the only path on which naming it is correct is this one, where it is the declared
 * SOURCE of a promotion rather than a fallback in a runtime cascade.
 */
const GLOBAL_PLAYGROUND_TENANT_ID = '50000000-0000-0000-0000-000000000000';

const PROMPT_TEMPLATE_ID_KEY = 'promptTemplateId';
const PROMPT_VERSION_NUMBER_KEY = 'promptVersionNumber';
const EVAL_GATE_KEY = 'evalGate';

/** The one method this service needs of the agent lifecycle. */
interface AgentPublishPort {
  publish(id: string, dto: { activate?: boolean }): Promise<{ id: string }>;
}
/** The two methods this service needs of the context-schema lifecycle (the `documentTemplates` precedent). */
interface ContextSchemaWritePort {
  create(dto: { slug: string; name: string; description?: string; sourceTemplateSlug?: string; templateLocked?: boolean }): Promise<{ id: string }>;
  publish(id: string, dto: { definition: Record<string, unknown>; changeReason?: string }): Promise<unknown>;
}

/**
 * TASK-930 §6.1 — the AGENT half of the HOPE promotion process.
 *
 * ## One declared path, not a second cross-tenant push
 *
 * Owner decision #4: *the platform admin builds in Global (`50000000-…`) and promotes into
 * SYSTEM (`00000000-…`); SYSTEM is the reference set every customer tenant is provisioned from;
 * only the platform admin manages SYSTEM.* `WorkflowDefinitionService.promoteToSystem` is that
 * path for a WORKFLOW; this is the same path for an AGENT, and it is deliberately the ONLY way
 * an agent row reaches SYSTEM. An arbitrary tenant → tenant push already exists
 * (`POST admin/agents/{slug}/clone`, `POST admin/agents/{slug}/sync`) and
 * `AgentService.assertManagesAgentsIn` refuses SYSTEM as a target by name, pointing here.
 *
 * ## What it adds over a copy
 *
 * The copy itself is the ordinary one: values, never references. What promotion adds is the half
 * a cross-tenant push must never do — RECOMPILE against SYSTEM's own catalogue, PUBLISH and
 * ACTIVATE. That is safe here for the reason it is refused in general: publishing into a customer
 * tenant would re-point that customer's live consultations, and SYSTEM runs none. Publishing
 * there changes what a tenant with NO OPINION is provisioned with, which is exactly the intent.
 *
 * The recompile is `IAgentService.publish` — the agent lifecycle's own path, run standing in
 * SYSTEM's tenant context. A second compile implementation here would be a second thing to keep
 * in step with the model catalogue and the finding rules.
 *
 * ## Tenant context
 *
 * Like `AgentPromotionService`, this runs under an ELEVATED TENANT-LESS context for a MECHANICAL
 * reason: with a tenant pinned, the tenant-scope extension forces the caller's `tenantId` into
 * every read, which makes the cross-tenant read impossible rather than merely unauthorized. The
 * corollary is that nothing here may rely on ambient scoping — every read NAMES its tenant
 * through `runInTenantContext`, and every write inside the transaction passes `tx` and an
 * explicit `tenantId`.
 *
 * ## Referenced content
 *
 * | Reference | Treatment |
 * |---|---|
 * | `instruction.promptTemplateId`, Global-owned | DEEP-COPIED into SYSTEM (`sourceTemplateId` stamped, APPROVED where the source was) and re-bound; the version pin drops to the copy's v1 |
 * | `instruction.promptTemplateId`, SYSTEM-owned | left alone — copying it would fork the platform library |
 * | `contextSchemaId` | re-bound to the SYSTEM schema of the SAME slug, copied when SYSTEM carries none |
 * | `instruction.evalGate` | STRIPPED — `goldenSetId` names a corpus of Vault-Transit-encrypted `GoldenCase` PHI, and not even the pointer crosses a tenant boundary |
 * | `modelId` and the fallback chain | re-resolved BY SLUG in SYSTEM; a slug SYSTEM does not carry is a 409 `MODEL_NOT_RESOLVABLE`, never a dangling id |
 */
@Injectable()
export class AgentPromoteToSystemService extends BaseService implements IAgentPromoteToSystemService {
  private readonly logger = new Logger(AgentPromoteToSystemService.name);

  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly fallbackRepository: AgentModelFallbackRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly contextSchemaRepository: ConsultationContextSchemaRepository,
    private readonly contextSchemaVersionRepository: ConsultationContextSchemaVersionRepository,
    private readonly aiModelRepository: AiModelRepository,
    private readonly promotionRepository: AgentPromotionRepository,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    /**
     * The two kind-owning services are resolved from the CONTAINER at call time rather than
     * injected, for the reason `TenantReferenceSetService` records: importing their modules here
     * closes a module cycle that stops the gateway booting. `strict: false` looks the token up
     * across the whole application.
     */
    private readonly moduleRef: ModuleRef,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.AgentPromotion);
  }

  async promoteToSystem(dto: PromoteAgentToSystemRequest): Promise<PromoteAgentToSystemResponse> {
    // ---- 1. Mechanical precondition + THE privilege boundary --------------
    this.assertElevatedTenantlessContext();
    const userId = this.requestUserId;
    if (!userId) {
      throw new ForbiddenException('Promoting an agent into SYSTEM requires an authenticated platform administrator.');
    }

    // ---- 2. The exact immutable Global version ----------------------------
    const source = await this.resolveGlobalSource(dto.sourceSlug, dto.versionNumber);
    const sourceFallbacks = await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
      this.fallbackRepository.findByAgentId(source.id),
    );

    const warnings: string[] = [];

    // ---- 3. The context schema — copied through its OWNING service --------
    // Before the transaction, because the copy is `create` + `publish` on
    // `ConsultationContextSchemaService` (shape validation, checksum, the pin move) and a
    // service cannot enrol in a transaction this one opened. The same split
    // `TenantReferenceSetService.copyDocumentTemplates` makes, for the same reason.
    const contextSchema = await this.resolveContextSchemaInSystem(source, warnings);

    // ---- 4 + 5. The copy and its immutable record — ONE transaction -------
    const { saved, copiedPromptTemplates, promotion } = await this.databaseService.baseClient.$transaction(async (tx) => {
      const { instruction, copied } = await this.materializeInstruction(source, userId, tx);
      const modelId = await this.resolveModelIdInSystem(source.modelId, tx);
      const fallbackModelIds: string[] = [];
      for (const row of [...sourceFallbacks].sort((a, b) => a.priority - b.priority)) {
        fallbackModelIds.push(await this.resolveModelIdInSystem(row.modelId, tx));
      }

      const versionNumber = (await this.agentRepository.findMaxVersionNumber(SYSTEM_TENANT_ID, source.slug, tx)) + 1;
      const entity = AgentFactory.CreateAgent({
        tenantId: SYSTEM_TENANT_ID,
        slug: source.slug,
        name: source.name,
        description: source.description ?? null,
        task: source.task,
        versionNumber,
        // `parentVersionId` means "the previous version of THIS lineage", and a promotion starts
        // a different one. The provenance edge is the four `source*` columns plus the WORM row.
        parentVersionId: null,
        modelId,
        contextSchemaId: contextSchema.id,
        // SYSTEM's own pin governs: the source's number is a version inside GLOBAL's lineage.
        contextSchemaVersionNumber: null,
        instruction,
        parameters: source.parameters ?? null,
        inputSchema: source.inputSchema ?? null,
        outputSchema: source.outputSchema ?? null,
        tools: source.tools ?? null,
        tags: source.tags ?? [],
        sourceAgentId: source.id,
        sourceTenantId: source.tenantId,
        sourceSlug: source.slug,
        sourceVersionNumber: source.versionNumber,
        createdBy: userId,
      });
      // A DRAFT until `publish` recompiles it: `AgentEntity.validate()` refuses a PUBLISHED row
      // with no `compiledConfig`, and stamping one here would be the second compiler.
      entity.validate();
      const written = await this.agentRepository.create(entity, tx);

      const fallbacks: AgentModelFallbackEntity[] = [];
      for (const [priority, id] of fallbackModelIds.entries()) {
        const link = AgentModelFallbackFactory.CreateAgentModelFallback({
          tenantId: SYSTEM_TENANT_ID,
          agentId: written.id,
          priority,
          modelId: id,
          createdBy: userId,
        });
        link.validate();
        fallbacks.push(await this.fallbackRepository.create(link, tx));
      }

      const snapshot = promotionSnapshot(written, fallbackModelIds);
      const record = AgentPromotionFactory.CreateAgentPromotion({
        fromTenantId: GLOBAL_PLAYGROUND_TENANT_ID,
        toTenantId: SYSTEM_TENANT_ID,
        // The four WORM columns keep the names they were created with; see
        // `AgentPromotionService`'s header for what they now carry.
        agentVersionId: source.id,
        sourceAgentId: source.slug,
        targetAgentId: written.slug,
        targetAgentVersionId: written.id,
        configSnapshot: snapshot as never,
        checksum: `sha256:${createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}`,
        warnings: warnings as never,
        promotedBy: userId,
        createdBy: userId,
        metaData: { changeReason: dto.changeReason },
      } as never);
      record.validate();

      return {
        saved: written,
        copiedPromptTemplates: copied,
        promotion: await this.promotionRepository.create(record, tx),
      };
    });

    // ---- 6. Recompile + publish + activate, in SYSTEM's own context -------
    const agents = this.port<AgentPublishPort>(IAgentService);
    if (!agents) {
      // Fail LOUDLY rather than returning an unpublished SYSTEM row: an unpublished reference
      // agent is invisible to `findSystemReferences`, so provisioning would silently skip it.
      throw new ConflictException({
        message: 'The agent lifecycle service is not wired, so the promoted SYSTEM row could not be published.',
        code: 'AGENT_SERVICE_UNAVAILABLE',
      });
    }
    await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () => agents.publish(saved.id, { activate: true }));

    // Announced only AFTER the copy commits — an event for a promotion that rolled back would be
    // a claim about something that never happened.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: promotion.id,
      createdAt: promotion.createdAt,
      data: {
        action: 'promote-agent-to-system',
        // The event's own `tenantId` is CLS-sourced and is empty on this elevated path, so BOTH
        // tenants travel in the payload.
        fromTenantId: GLOBAL_PLAYGROUND_TENANT_ID,
        toTenantId: SYSTEM_TENANT_ID,
        slug: saved.slug,
        versionNumber: saved.versionNumber,
        sourceAgentId: source.id,
        targetAgentId: saved.id,
        changeReason: dto.changeReason,
      },
    });

    return {
      agentId: saved.id,
      slug: saved.slug,
      versionNumber: saved.versionNumber,
      copied: { promptTemplates: copiedPromptTemplates, contextSchemas: contextSchema.copied ? 1 : 0 },
      promotionId: promotion.id,
      warnings,
    };
  }

  // =========================================================================
  // Guards
  // =========================================================================

  /**
   * The applications-layer mirror of "the tenant-scope extension is in pass-through", stated as
   * its own check for the reason `AgentPromotionService` gives: it turns a raw `TenantScope`
   * 500 — or a silently empty read taken for a 404 — into an actionable 403.
   *
   * The super-admin half is a PRIVILEGE boundary (403), NOT the 404-over-403 cross-tenant
   * posture: "only the platform admin manages SYSTEM" is a statement about the actor, not about
   * whether a row exists.
   */
  private assertElevatedTenantlessContext(): void {
    if (this.tenantId) {
      throw new ForbiddenException(
        'Promoting an agent into SYSTEM crosses a tenant boundary and requires an elevated tenant-less context; clear the working tenant and retry.',
      );
    }
    if (!isSuperAdmin(this.requestUser)) {
      throw new ForbiddenException('Only a platform administrator may promote an agent into the SYSTEM reference set.');
    }
  }

  /** One collaborator, or `undefined` when the host app did not register it. */
  private port<T>(token: symbol): T | undefined {
    try {
      return this.moduleRef.get<T>(token as never, { strict: false });
    } catch {
      return undefined;
    }
  }

  /**
   * The exact immutable Global version to promote — an explicit `versionNumber`, else Global's
   * ACTIVE PUBLISHED row for that slug.
   *
   * Defaulting to the ACTIVE PUBLISHED row rather than the newest is `AgentPromotionService`'s
   * call, repeated here on purpose: the newest row may be an unfinished draft, and an unvalidated
   * agent published into SYSTEM becomes every tenant's default on their next provisioning.
   *
   * A slug Global does not own is a **404** (indistinguishable from missing); a slug it owns but
   * has not published is a **409 `AGENT_NOT_PUBLISHED`** — the difference between "there is
   * nothing here" and "there is something here and it is not ready".
   */
  private async resolveGlobalSource(slug: string, versionNumber?: number): Promise<AgentEntity> {
    if (versionNumber !== undefined) {
      const versions = await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
        this.agentRepository.findAllVersionsBySlug(GLOBAL_PLAYGROUND_TENANT_ID, slug),
      );
      const match = versions.find((row) => row.versionNumber === versionNumber);
      if (!match) {
        throw new NotFoundException(`Agent '${slug}' has no version ${versionNumber} in the Global build tenant`);
      }
      this.assertPublished(match);
      return match;
    }

    const active = await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
      this.agentRepository.findOwnActiveBySlug(GLOBAL_PLAYGROUND_TENANT_ID, slug),
    );
    if (active) {
      this.assertPublished(active);
      return active;
    }

    const versions = await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
      this.agentRepository.findAllVersionsBySlug(GLOBAL_PLAYGROUND_TENANT_ID, slug),
    );
    if (versions.length === 0) {
      throw new NotFoundException(`Agent '${slug}' not found`);
    }
    throw new ConflictException({
      message: `Agent '${slug}' has no ACTIVE PUBLISHED version in the Global build tenant. Publish it there, or name an explicit version to promote one deliberately.`,
      code: 'AGENT_NOT_PUBLISHED',
    });
  }

  private assertPublished(entity: AgentEntity): void {
    if (entity.status === WorkflowDefinitionStatus.PUBLISHED) return;
    throw new ConflictException({
      message: `Agent '${entity.slug}' version ${entity.versionNumber} is ${entity.status}. Only a PUBLISHED Global version may become the platform default.`,
      code: 'AGENT_NOT_PUBLISHED',
    });
  }

  // =========================================================================
  // Referenced content
  // =========================================================================

  /**
   * The promoted `instruction`: the source's, with the eval gate stripped and any GLOBAL-owned
   * prompt binding re-pointed at a SYSTEM copy of that template.
   */
  private async materializeInstruction(
    source: AgentEntity,
    userId: string,
    tx: unknown,
  ): Promise<{ instruction: Record<string, unknown> | null; copied: number }> {
    const declared = asRecord(source.instruction);
    if (!declared) return { instruction: null, copied: 0 };

    const instruction: Record<string, unknown> = { ...declared };
    if (EVAL_GATE_KEY in instruction) delete instruction[EVAL_GATE_KEY];

    const boundId = instruction[PROMPT_TEMPLATE_ID_KEY];
    if (typeof boundId !== 'string' || boundId.length === 0) {
      // A version pin with no template is half a reference; it would number a version of nothing.
      if (PROMPT_VERSION_NUMBER_KEY in instruction) delete instruction[PROMPT_VERSION_NUMBER_KEY];
      return { instruction, copied: 0 };
    }

    const template = await this.safeFindTemplate(boundId);
    // A SYSTEM template is already the platform's own; copying it would fork the library. An id
    // that no longer reads is left as it is — `publish` reports it as a finding rather than this
    // method silently unbinding the instruction.
    if (!template || template.tenantId === SYSTEM_TENANT_ID) return { instruction, copied: 0 };

    const existing =
      (await this.promptTemplateRepository.findByTenantAndSourceTemplateId(SYSTEM_TENANT_ID, template.id).catch(() => null)) ??
      (template.name ? await this.promptTemplateRepository.findByName(SYSTEM_TENANT_ID, template.name).catch(() => null) : null);
    if (existing) {
      // Idempotent: a second promotion of the same lineage re-binds to the copy the first made
      // rather than forking it.
      instruction[PROMPT_TEMPLATE_ID_KEY] = existing.id;
      const approved = existing.approvedVersionNumber ?? null;
      if (approved === null) delete instruction[PROMPT_VERSION_NUMBER_KEY];
      else instruction[PROMPT_VERSION_NUMBER_KEY] = approved;
      return { instruction, copied: 0 };
    }

    // The APPROVED snapshot travels, not the mutable draft column — `PromptManagementService
    // .cloneFromSystem`'s rule, and for the same reason: the approved version is what the source
    // actually served.
    const pinned = template.approvedVersionNumber ?? null;
    const version =
      pinned === null
        ? null
        : await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
            this.promptVersionRepository.findByVersionNumber(template.id, pinned).catch(() => null),
          );
    const content = version?.content ?? template.content ?? '';
    const variables = ((version?.variables ?? template.variables) as Record<string, unknown> | null) ?? null;

    const copy = PromptTemplateFactory.CreatePromptTemplate({
      tenantId: SYSTEM_TENANT_ID,
      name: template.name ?? null,
      description: template.description ?? null,
      content,
      category: template.category ?? null,
      // APPROVED where the source was: a DRAFT copy falls through the resolver, which would
      // silently change what the promoted agent renders.
      status: template.status ?? 'DRAFT',
      approvedVersionNumber: template.status === 'APPROVED' ? 1 : null,
      currentVersionNumber: 1,
      variables,
      // The provenance edge, and what makes a re-promotion idempotent.
      sourceTemplateId: template.id,
      departmentId: null,
      scope: 'TENANT_DEFAULT',
      ownerUserId: null,
      // A prompt's tags are CONTENT and travel (the asymmetry with agent tags that
      // `AgentService.cloneFromSystem` records).
      tags: template.tags ?? [],
      createdBy: userId,
    } as never);
    const savedTemplate = await this.promptTemplateRepository.create(copy, tx);

    const v1 = PromptVersionFactory.CreatePromptVersion({
      tenantId: SYSTEM_TENANT_ID,
      promptTemplateId: savedTemplate.id,
      versionNumber: 1,
      content,
      variables,
      changeReason: `Promoted from the Global build tenant (agent '${source.slug}' version ${source.versionNumber})`,
      changedBy: userId,
      createdBy: userId,
    } as never);
    await this.promptVersionRepository.create(v1, tx);

    instruction[PROMPT_TEMPLATE_ID_KEY] = savedTemplate.id;
    // The copy's lineage restarts at 1, so the source's pin numbers a version that is not here.
    instruction[PROMPT_VERSION_NUMBER_KEY] = 1;
    return { instruction, copied: 1 };
  }

  /**
   * The SYSTEM context schema the promoted agent binds: the one carrying the SAME slug, copied
   * from Global when SYSTEM has none.
   *
   * The copy goes through `ConsultationContextSchemaService.create` + `publish` rather than the
   * repositories, so the shape validation, the version checksum and the pin move stay in ONE
   * place — the same reasoning `TenantReferenceSetService.copyDocumentTemplates` records.
   */
  private async resolveContextSchemaInSystem(
    source: AgentEntity,
    warnings: string[],
  ): Promise<{ id: string | null; copied: boolean }> {
    const boundId = source.contextSchemaId ?? null;
    if (!boundId) return { id: null, copied: false };

    const declared = await this.safeFindContextSchema(boundId);
    if (!declared) {
      warnings.push(
        `The source agent binds context schema ${boundId}, which no longer reads in the Global build tenant; the promoted SYSTEM row binds none.`,
      );
      return { id: null, copied: false };
    }
    if (declared.tenantId === SYSTEM_TENANT_ID) return { id: declared.id, copied: false };

    const existing = await runInTenantContext(this.clsService, SYSTEM_TENANT_ID, () =>
      this.contextSchemaRepository.findByTenantAndSlug(SYSTEM_TENANT_ID, declared.slug),
    );
    if (existing) return { id: existing.id, copied: false };

    const schemas = this.port<ContextSchemaWritePort>(IConsultationContextSchemaService);
    if (!schemas) {
      throw new ConflictException({
        message: 'The context-schema service is not wired, so the agent’s bound schema could not be copied into SYSTEM.',
        code: 'CONTEXT_SCHEMA_SERVICE_UNAVAILABLE',
      });
    }

    const pinnedVersionNumber = declared.pinnedVersionNumber ?? null;
    const pinned =
      pinnedVersionNumber === null
        ? null
        : await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () =>
            this.contextSchemaVersionRepository.findBySchemaAndVersionNumber(declared.id, pinnedVersionNumber),
          );
    if (!pinned) {
      throw new ConflictException({
        message: `Context schema '${declared.slug}' carries no pinned version in the Global build tenant, so the SYSTEM copy would never be servable. Publish it there first.`,
        code: 'CONTEXT_SCHEMA_NOT_PUBLISHED',
      });
    }

    return runInTenantContext(this.clsService, SYSTEM_TENANT_ID, async () => {
      const created = await schemas.create({
        slug: declared.slug,
        name: declared.name,
        ...(declared.description ? { description: declared.description } : {}),
        sourceTemplateSlug: declared.slug,
        templateLocked: true,
      });
      await schemas.publish(created.id, {
        definition: pinned.definition as Record<string, unknown>,
        changeReason: `Promoted from the Global build tenant with agent '${source.slug}'`,
      });
      this.logger.log({ message: 'Context schema copied into SYSTEM by an agent promotion', slug: declared.slug, schemaId: created.id });
      return { id: created.id, copied: true };
    });
  }

  /**
   * The model row the SYSTEM copy must bind. A SYSTEM row keeps its id; anything else re-resolves
   * BY SLUG in SYSTEM, and a slug SYSTEM does not carry is a 409 naming it — never a dangling
   * `modelId`. Mirrors `AgentService.resolveModelIdForTarget`.
   */
  private async resolveModelIdInSystem(modelId: string, tx: unknown): Promise<string> {
    const model = await this.aiModelRepository.findByIdOrNull(modelId, tx).catch(() => null);
    if (!model) {
      throw new ConflictException({
        message: `The bound model row ${modelId} could not be read, so the promotion would leave a dangling reference.`,
        code: 'MODEL_NOT_RESOLVABLE',
      });
    }
    if (model.tenantId === SYSTEM_TENANT_ID) return model.id;

    const platform = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, model.slug, tx).catch(() => null);
    if (platform) return platform.id;
    throw new ConflictException({
      message: `The platform catalogue has no model registered as '${model.slug}', so the promotion would leave a dangling reference. Publish it into SYSTEM first.`,
      code: 'MODEL_NOT_RESOLVABLE',
    });
  }

  private async safeFindTemplate(id: string) {
    try {
      return await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () => this.promptTemplateRepository.findById(id));
    } catch {
      return null;
    }
  }

  private async safeFindContextSchema(id: string): Promise<ConsultationContextSchemaEntity | null> {
    try {
      return await runInTenantContext(this.clsService, GLOBAL_PLAYGROUND_TENANT_ID, () => this.contextSchemaRepository.findById(id));
    } catch {
      return null;
    }
  }
}

// ===========================================================================
// Module-local helpers
// ===========================================================================

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * What the WORM record freezes: the VALUES the promotion wrote, not the row id. The compiled
 * artifact is deliberately absent — it is stamped by the publish that follows the commit, and a
 * snapshot taken before it would record something the record's own checksum could not describe.
 */
function promotionSnapshot(agent: AgentEntity, fallbackModelIds: readonly string[]): Record<string, unknown> {
  return {
    slug: agent.slug,
    name: agent.name,
    description: agent.description ?? null,
    task: String(agent.task),
    versionNumber: agent.versionNumber,
    modelId: agent.modelId,
    fallbackModelIds: [...fallbackModelIds],
    contextSchemaId: agent.contextSchemaId ?? null,
    instruction: agent.instruction ?? null,
    parameters: agent.parameters ?? null,
    inputSchema: agent.inputSchema ?? null,
    outputSchema: agent.outputSchema ?? null,
    tools: agent.tools ?? null,
    tags: agent.tags ?? [],
  };
}
