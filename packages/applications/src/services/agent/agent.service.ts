import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { createHash } from 'node:crypto';
import {
  AgentEntity,
  AgentFactory,
  AgentModelFallbackEntity,
  AgentModelFallbackFactory,
  AgentModelFallbackRepository,
  AgentRepository,
  AgentTask,
  AiModelEntity,
  AiModelRepository,
  CoreDatabaseService,
  McpServerRepository,
  ModelTaskType,
  PromptTemplateEntity,
  PromptTemplateRepository,
  PromptVersionRepository,
  ResourceStatusType,
  ResourceType,
  SYSTEM_TENANT_ID,
  SysEventType,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import type { JsonValue } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import type { AgentCompiledConfig } from '@arcaai/types';
import {
  AGENT_INSTRUCTION_SCHEMAS,
  AGENT_IO_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  AGENT_PROTOCOLS,
  AGENT_TASK_MODEL_TASK_TYPE,
  AGENT_TASK_SERVICE,
  agentConfigProblems,
  agentTagProblems,
  buildPortableBundle,
  canonicalJson,
  portableBundleProblems,
  type AgentConfigView,
  type AgentModelView,
  type AgentProviderCapabilities,
} from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { isSuperAdmin } from '../../common/tenant-guards';
import { PolicyEngine } from '../../authorization/policy.engine';
import { IActiveUserContext } from '../../interfaces';
// TASK-889 — the membership-bounded cross-tenant step, declared beside `AgentPromotionService`'s
// ELEVATED one so the two are read together and neither is mistaken for the other.
import { runInTenantContext } from '../agentPromotion/tenant-context';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type { IProviderConnectionService as IProviderConnectionServicePort } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { AgentDtoMapper } from './agent.dto.mapper';
import { codeForConfigProblem, hasBlocking, type AgentFinding, type AgentValidationReport } from './agent-findings';
import {
  agentBundlePayloadProblems,
  buildAgentBundlePayload,
  instructionForImport,
  readPromptTemplateRef,
  toolServerIds,
  EVAL_GATE_KEY,
  PROMPT_TEMPLATE_ID_KEY,
  PROMPT_VERSION_NUMBER_KEY,
  type AgentBundlePayload,
} from './agent-bundle';
import {
  AgentBundleResponse,
  AgentResponse,
  AgentSummaryResponse,
  AgentSyncResponse,
  CloneAgentRequest,
  CreateAgentRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  SyncAgentRequest,
  UpdateAgentRequest,
} from './dto';
import { IAgentService } from './IAgentService';

/**
 * Providers that SERVE weights themselves (an engine process the platform runs and that hosts
 * its own model store), as opposed to a cloud vendor (needs a credential) or weights the
 * platform's own services load from the bucket (`built-in`, `null` — need `localPath` /
 * DOWNLOADED). Engine-served rows are available whenever ENABLED.
 *
 * `built-in` is deliberately NOT here: `apps/stt`/`apps/tts` resolve those weights through
 * `resolve_model_dir`, so a row without staged weights (the nemotron / parakeet.cpp case) must
 * FAIL CLOSED at publish — the ticket's own proof.
 *
 * TODO(TASK-860): replace this whole predicate with the measured `AiModel.availability`.
 */
const ENGINE_SERVED_PROVIDERS: ReadonlySet<string> = new Set(['lm-studio', 'lmstudio', 'ollama', 'vllm', 'llama-cpp']);

const PUBLISHED_OR_DEPRECATED: ReadonlySet<WorkflowDefinitionStatus> = new Set([
  WorkflowDefinitionStatus.PUBLISHED,
  WorkflowDefinitionStatus.DEPRECATED,
]);

type ResolvedPrompt = AgentCompiledConfig['resolvedPrompt'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The Agent authoring lifecycle (TASK-863). Rows are versions; a PUBLISHED/DEPRECATED row is
 * immutable here (`assertMutable`), by the DTO whitelist, and by the DB trigger. Every check
 * that decides publishability lives in `collectFindings` so `validate()` and `publish()` can
 * never disagree about what blocks.
 */
@Injectable()
export class AgentService extends BaseService implements IAgentService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly fallbackRepository: AgentModelFallbackRepository,
    private readonly aiModelRepository: AiModelRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    // Optional() + trailing so positional unit fixtures keep their arity; production DI always
    // supplies them. Absent ⇒ the corresponding check reports an ERROR finding (fail closed),
    // never a silent pass.
    @Optional() @Inject(IAgentAssignmentService) private readonly assignments?: IAgentAssignmentServicePort,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionServicePort,
    @Optional() private readonly promptTemplateRepository?: PromptTemplateRepository,
    @Optional() private readonly promptVersionRepository?: PromptVersionRepository,
    // TASK-884. `PolicyEngine` is what makes "the caller holds manage:Agent in that OTHER
    // tenant" answerable from a service — a route decorator expresses `action + subject` and
    // cannot express "…and also over there" (the `AgentPromotionService` precedent).
    // `McpServerRepository` re-checks tool bindings when a copy crosses a tenant boundary.
    @Optional() private readonly policyEngine?: PolicyEngine,
    @Optional() private readonly mcpServerRepository?: McpServerRepository,
  ) {
    super(eventEmitter, clsService, ResourceType.Agent);
  }

  // ============================================================
  // Reads
  // ============================================================

  async list(task?: AgentTask, includeTemplates = false): Promise<AgentResponse[]> {
    const tenantId = this.requireTenant();
    const own = await this.agentRepository.findAllForTenant(tenantId, task);
    const templates =
      includeTemplates && tenantId !== SYSTEM_TENANT_ID
        ? (await this.agentRepository.findPublishedActiveVisible(tenantId, task)).filter((row) => row.tenantId === SYSTEM_TENANT_ID)
        : [];
    const rows = [...own, ...templates];
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { task: task ?? null, count: rows.length } });
    return this.respondMany(rows);
  }

  async getById(id: string): Promise<AgentResponse> {
    const entity = await this.loadVisible(id);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id });
    return this.respond(entity);
  }

  async listVersions(id: string): Promise<AgentResponse[]> {
    const entity = await this.loadVisible(id);
    const versions = await this.agentRepository.findAllVersionsBySlug(entity.tenantId, entity.slug);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: entity.id, data: { action: 'listVersions', count: versions.length } });
    return this.respondMany(versions);
  }

  async listPublished(task?: AgentTask): Promise<AgentSummaryResponse[]> {
    const tenantId = this.requireTenant();
    const rows = await this.agentRepository.findPublishedActiveVisible(tenantId, task);
    const defaults = await this.tenantDefaultSlugs(tenantId, [...new Set(rows.map((row) => row.task))]);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { data: { action: 'listPublished', task: task ?? null, count: rows.length } });
    return rows.map((row) => AgentDtoMapper.toSummary(row, defaults.get(row.task) === row.slug));
  }

  async getPublishedBySlug(slug: string): Promise<AgentSummaryResponse> {
    const tenantId = this.requireTenant();
    const row = await this.agentRepository.findPublishedActiveBySlug(tenantId, slug);
    if (!row) throw new NotFoundException('Agent not found');
    const defaults = await this.tenantDefaultSlugs(tenantId, [row.task]);
    this.broadcastSysEvent(SysEventType.ResourceViewed, { resourceId: row.id });
    return AgentDtoMapper.toSummary(row, defaults.get(row.task) === row.slug);
  }

  // ============================================================
  // Writes
  // ============================================================

  async create(dto: CreateAgentRequest): Promise<AgentResponse> {
    const tenantId = this.requireTenant();
    this.assertTagGrammar(dto.tags);
    const model = await this.loadModelOrThrow(dto.modelId, tenantId);
    const fallbackModels = await this.loadFallbackModelsOrThrow(dto.fallbackModelIds ?? [], tenantId);

    const view = this.viewOf(dto.task, dto);
    const findings = this.structuralFindings(view, model, fallbackModels);
    this.throwIfBlocking(findings, 'The agent configuration is not valid.');

    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      const maxVersionNumber = await this.agentRepository.findMaxVersionNumber(tenantId, dto.slug, tx);
      const entity = AgentFactory.CreateAgent({
        tenantId,
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        task: dto.task,
        versionNumber: maxVersionNumber + 1,
        modelId: dto.modelId,
        instruction: (dto.instruction ?? null) as JsonValue | null,
        parameters: (dto.parameters ?? null) as JsonValue | null,
        inputSchema: (dto.inputSchema ?? null) as JsonValue | null,
        outputSchema: (dto.outputSchema ?? null) as JsonValue | null,
        tools: (dto.tools ?? null) as JsonValue | null,
        tags: dto.tags ?? [],
        createdBy: this.requestUserId ?? undefined,
      });
      entity.validate();
      const created = await this.agentRepository.create(entity, tx);
      await this.writeFallbacks(created, fallbackModels, tx);
      return created;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { slug: saved.slug, versionNumber: saved.versionNumber, task: saved.task, modelId: saved.modelId },
    });
    return this.respond(saved);
  }

  async update(id: string, dto: UpdateAgentRequest, expectedVersion?: number): Promise<AgentResponse> {
    const entity = await this.loadOwned(id);
    this.assertMutable(entity);
    this.assertTagGrammar(dto.tags);

    const model = await this.loadModelOrThrow(dto.modelId ?? entity.modelId, entity.tenantId);
    const currentFallbacks = await this.fallbackRepository.findByAgentId(entity.id);
    const fallbackModels =
      dto.fallbackModelIds !== undefined
        ? await this.loadFallbackModelsOrThrow(dto.fallbackModelIds, entity.tenantId)
        : await this.loadFallbackModelsOrThrow(
            currentFallbacks.map((row) => row.modelId),
            entity.tenantId,
          );

    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.description !== undefined) entity.description = dto.description;
    if (dto.modelId !== undefined) entity.modelId = dto.modelId;
    if (dto.instruction !== undefined) entity.instruction = dto.instruction as JsonValue;
    if (dto.parameters !== undefined) entity.parameters = dto.parameters as JsonValue;
    if (dto.inputSchema !== undefined) entity.inputSchema = dto.inputSchema as JsonValue;
    if (dto.outputSchema !== undefined) entity.outputSchema = dto.outputSchema as JsonValue;
    if (dto.tools !== undefined) entity.tools = dto.tools as JsonValue;
    if (dto.tags !== undefined) entity.tags = dto.tags;

    const findings = this.structuralFindings(this.viewOf(entity.task, entity), model, fallbackModels);
    this.throwIfBlocking(findings, 'The agent configuration is not valid.');

    // Any edit invalidates a VALIDATED row: the report no longer describes these bytes.
    if (entity.status === WorkflowDefinitionStatus.VALIDATED) {
      entity.status = WorkflowDefinitionStatus.DRAFT;
      entity.validationReport = null;
      entity.validatedAt = null;
    }

    this.assertExpectedVersion(entity, expectedVersion ?? dto.expectedVersion);
    const replaceFallbacks = dto.fallbackModelIds !== undefined;
    if (!entity.hasChanges && !replaceFallbacks) {
      throw new ArgumentInvalidException('No changes to write.');
    }
    entity.updatedBy = this.requestUserId ?? undefined;
    entity.validate();

    const casVersion = expectedVersion ?? dto.expectedVersion ?? entity.version;
    const updated = await this.databaseService.baseClient.$transaction(async (tx) => {
      if (replaceFallbacks) {
        await this.fallbackRepository.deleteAllForAgent(entity.id, tx);
        await this.writeFallbacks(entity, fallbackModels, tx);
      }
      return this.agentRepository.updateWithVersion(entity.id, entity, casVersion, tx);
    });

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'update', previousVersion: casVersion, newVersion: updated.version },
    });
    return this.respond(updated);
  }

  async deleteById(id: string): Promise<AgentResponse> {
    const entity = await this.loadOwned(id);
    if (entity.isActive) {
      throw new ConflictException('This is the ACTIVE published version of its slug — deprecate it (or activate another version) before deleting.');
    }
    const deleted = await this.agentRepository.softDelete(entity.id, this.requestUserId ?? undefined);
    this.broadcastSysEvent(SysEventType.ResourceDeleted, { resourceId: entity.id, data: { slug: entity.slug, versionNumber: entity.versionNumber } });
    return this.respond(deleted ?? entity);
  }

  async validate(id: string): Promise<AgentResponse> {
    const entity = await this.loadOwned(id);
    this.assertMutable(entity);
    const { report } = await this.collectFindings(entity);

    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    entity.status = report.blocking ? WorkflowDefinitionStatus.DRAFT : WorkflowDefinitionStatus.VALIDATED;
    entity.updatedBy = this.requestUserId ?? undefined;
    const updated = await this.agentRepository.update(entity.id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'validate', blocking: report.blocking, findings: report.findings.length },
    });
    return this.respond(updated);
  }

  async publish(id: string, dto: PublishAgentRequest): Promise<AgentResponse> {
    const entity = await this.loadOwned(id);
    this.assertMutable(entity);

    const { report, model, fallbackModels, resolvedPrompt } = await this.collectFindings(entity);
    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    if (report.blocking) {
      // Persist the report so the console can show WHY, then fail closed.
      entity.status = WorkflowDefinitionStatus.DRAFT;
      await this.agentRepository.update(entity.id, entity);
      this.throwIfBlocking(report.findings, 'The agent cannot be published.');
    }

    const fallbackRows = await this.fallbackRepository.findByAgentId(entity.id);
    const compiled = this.compile(entity, model as AiModelEntity, fallbackModels, fallbackRows, resolvedPrompt);
    entity.compiledConfig = compiled as unknown as JsonValue;
    entity.compiledConfigChecksum = checksumOf(compiled);
    entity.status = WorkflowDefinitionStatus.PUBLISHED;
    entity.publishedAt = new Date();
    entity.updatedBy = this.requestUserId ?? undefined;

    const activate = dto.activate ?? true;
    if (activate) {
      entity.isActive = true;
      await this.demoteExistingActive(entity.tenantId, entity.slug, entity.id);
    }
    entity.validate();
    // Not a CAS on purpose (the WorkflowDefinition call): a publish never 412s on unrelated metadata drift.
    const updated = await this.agentRepository.update(entity.id, entity);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'publish', versionNumber: updated.versionNumber, compiledConfigChecksum: updated.compiledConfigChecksum, activate },
    });
    return this.respond(updated);
  }

  async newVersion(sourceId: string, dto: NewAgentVersionRequest): Promise<AgentResponse> {
    const tenantId = this.requireTenant();
    const source = await this.loadVisible(sourceId);
    const ownLineage = source.tenantId === tenantId;
    if (!ownLineage && source.status !== WorkflowDefinitionStatus.PUBLISHED) {
      // A SYSTEM draft is unreleased platform work; only its published rows are templates.
      throw new NotFoundException('Agent not found');
    }
    if (ownLineage && dto.slug !== undefined && dto.slug !== source.slug) {
      throw new BadRequestException('A new version of your own agent keeps its slug; branch a SYSTEM agent to start a new lineage.');
    }
    const slug = ownLineage ? source.slug : (dto.slug ?? source.slug);
    const sourceFallbacks = await this.fallbackRepository.findByAgentId(source.id);
    const fallbackModels = await this.loadFallbackModelsOrThrow(
      sourceFallbacks.map((row) => row.modelId),
      tenantId,
    );

    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      const maxVersionNumber = await this.agentRepository.findMaxVersionNumber(tenantId, slug, tx);
      const entity = AgentFactory.CreateAgent({
        tenantId,
        slug,
        name: dto.name ?? source.name,
        description: dto.description ?? source.description ?? null,
        task: source.task,
        versionNumber: maxVersionNumber + 1,
        parentVersionId: source.id,
        modelId: source.modelId,
        instruction: source.instruction ?? null,
        parameters: source.parameters ?? null,
        inputSchema: source.inputSchema ?? null,
        outputSchema: source.outputSchema ?? null,
        tools: source.tools ?? null,
        tags: source.tags ?? [],
        createdBy: this.requestUserId ?? undefined,
      });
      entity.validate();
      const created = await this.agentRepository.create(entity, tx);
      await this.writeFallbacks(created, fallbackModels, tx);
      return created;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        action: ownLineage ? 'newVersion' : 'branchTemplate',
        slug: saved.slug,
        versionNumber: saved.versionNumber,
        parentVersionId: source.id,
      },
    });
    return this.respond(saved);
  }

  async deprecate(id: string): Promise<AgentResponse> {
    const entity = await this.loadOwned(id);
    if (entity.status !== WorkflowDefinitionStatus.PUBLISHED) {
      throw new BadRequestException(`Only a PUBLISHED agent version can be deprecated (this one is ${entity.status}).`);
    }
    entity.status = WorkflowDefinitionStatus.DEPRECATED;
    entity.deprecatedAt = new Date();
    entity.isActive = false;
    entity.updatedBy = this.requestUserId ?? undefined;
    const updated = await this.agentRepository.update(entity.id, entity);
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { action: 'deprecate', versionNumber: updated.versionNumber },
    });
    return this.respond(updated);
  }

  // ============================================================
  // Portability — clone, export, import, sync (TASK-884)
  // ============================================================
  //
  // Owner decisions #2 and #4 in one place, because they are one mechanism seen from four
  // angles: take an agent version that already exists somewhere and land a DRAFT of it
  // somewhere else, copying VALUES and re-resolving or REFUSING every reference.
  //
  // | Verb | Source | Target | Crosses a tenant boundary? |
  // |---|---|---|---|
  // | `clone` | a SYSTEM template, or any agent visible to the tenant | the caller's tenant (a SUPER_ADMIN may name another) | only for that super-admin case |
  // | `exportBySlug` | the same | a JSON file | yes, potentially — so the bundle carries no id, no tenant and no credential |
  // | `importBundle` | a JSON file | the caller's tenant | yes — every reference is re-resolved against what the CALLER can see |
  // | `syncToTenants` | the caller's OWN agent | other tenants the caller manages | yes |
  //
  // Two rules govern the boundary crossings, and both are the `AgentPromotion` posture:
  //
  //  1. A MODEL travels by SLUG and is re-resolved in the target (its own row first, SYSTEM's
  //     otherwise). Unresolvable ⇒ a 409 that NAMES the slug.
  //  2. A TENANT-OWNED prompt template or MCP server does NOT travel. Its id is unreadable in
  //     the target, and copying the row is a second deep-copy pipeline with its own governance
  //     (that is what promotion is for). Refusing, with the binding named, is the honest
  //     answer — and it is what stops a synced agent quietly losing its instruction.
  //
  // An `evalGate` never crosses: `goldenSetId` names a corpus of Vault-Transit-encrypted
  // `GoldenCase` PHI. It survives a SAME-TENANT clone, where it is still valid.
  //
  // Everything lands as a DRAFT, never `isActive`. A copy must not silently become the agent
  // that serves another tenant's live consultations.

  async clone(slug: string, dto: CloneAgentRequest): Promise<AgentResponse> {
    const callerTenantId = this.requireTenant();
    const targetTenantId = dto.tenantId ?? callerTenantId;
    if (targetTenantId !== callerTenantId && !isSuperAdmin(this.requestUser)) {
      // A PRIVILEGE 403, not the 404-over-403 posture: the caller named a tenant explicitly and
      // is being told the naming itself is above their level, which leaks nothing about whether
      // that tenant exists.
      throw new ForbiddenException('Cloning into another tenant is a platform-administrator action.');
    }
    this.assertTagGrammar(dto.tags);

    const source = await this.resolveVisibleSource(slug, dto.sourceVersionNumber);
    if (targetTenantId === source.tenantId && dto.newSlug === source.slug) {
      throw new BadRequestException(
        'A clone starts a NEW lineage; keeping the slug would be a new VERSION of the same one — use POST /admin/agents/{id}/versions for that.',
      );
    }

    const { saved, fallbacks, warnings } = await this.copyInto(source, targetTenantId, {
      slug: dto.newSlug,
      name: dto.name ?? `${source.name} (copy)`,
      description: dto.description ?? source.description ?? null,
      tags: dto.tags,
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: {
        action: 'clone',
        slug: saved.slug,
        versionNumber: saved.versionNumber,
        // Both tenants travel in the payload: the event's own `tenantId` is CLS-sourced and
        // names the CALLER's, which is not the tenant the row landed in for a super-admin clone.
        sourceTenantId: source.tenantId,
        targetTenantId,
        sourceAgentId: source.id,
        sourceSlug: source.slug,
        sourceVersionNumber: source.versionNumber,
        warnings,
      },
    });
    return this.respondCopy(saved, fallbacks);
  }

  async exportBySlug(slug: string, versionNumber?: number): Promise<AgentBundleResponse> {
    const source = await this.resolveVisibleSource(slug, versionNumber);
    const model = await this.aiModelRepository.findByIdOrNull(source.modelId).catch(() => null);
    if (!model) {
      throw new ConflictException({
        message: `Agent '${source.slug}' binds a model row that is no longer readable, so it cannot be exported by slug.`,
        code: 'MODEL_NOT_RESOLVABLE',
      });
    }

    const fallbackRows = await this.fallbackRepository.findByAgentId(source.id);
    const fallbackModelSlugs: string[] = [];
    for (const row of [...fallbackRows].sort((a, b) => a.priority - b.priority)) {
      const fallbackModel = await this.aiModelRepository.findByIdOrNull(row.modelId).catch(() => null);
      if (fallbackModel) fallbackModelSlugs.push(fallbackModel.slug);
    }

    const template = await this.loadBoundTemplate(source);
    const payload = buildAgentBundlePayload({
      slug: source.slug,
      name: source.name,
      description: source.description ?? null,
      task: String(source.task),
      modelSlug: model.slug,
      fallbackModelSlugs,
      instruction: source.instruction,
      parameters: source.parameters,
      inputSchema: source.inputSchema,
      outputSchema: source.outputSchema,
      tools: source.tools,
      tags: source.tags ?? [],
      boundTemplate: template ? { id: template.id, name: template.name, isSystemOwned: template.tenantId === SYSTEM_TENANT_ID } : null,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: source.id,
      data: { action: 'export', slug: source.slug, versionNumber: source.versionNumber },
    });

    // `tenantKind` is derived from the SYSTEM tenant alone. The Global tenant
    // (`50000000-…`) is a CUSTOMER tenant, not a tier (rule 00), and naming its id in a runtime
    // path is precisely the smell that rule exists to catch — so the server never derives
    // `'global'`; the enum value exists for a client that already knows it is the playground.
    const bundle = buildPortableBundle(
      'agent',
      { tenantKind: source.tenantId === SYSTEM_TENANT_ID ? 'system' : 'tenant', slug: source.slug, version: source.versionNumber },
      payload,
    );
    return bundle as unknown as AgentBundleResponse;
  }

  async importBundle(dto: ImportAgentRequest): Promise<AgentResponse> {
    const tenantId = this.requireTenant();

    const envelopeProblems = portableBundleProblems(dto.bundle, { kind: 'agent' });
    if (envelopeProblems.length > 0) {
      throw new BadRequestException({ message: 'This is not a valid agent bundle.', code: 'BUNDLE_INVALID', findings: envelopeProblems });
    }
    const envelope = dto.bundle as unknown as { source: { slug: string; version: number }; payload: unknown };
    const payloadProblems = agentBundlePayloadProblems(envelope.payload);
    if (payloadProblems.length > 0) {
      throw new BadRequestException({ message: 'The agent bundle payload is not valid.', code: 'BUNDLE_PAYLOAD_INVALID', findings: payloadProblems });
    }
    const payload = envelope.payload as AgentBundlePayload;

    // ---- resolve every reference against what THIS tenant can see -------
    const modelId = await this.resolveModelIdBySlugVisible(payload.modelSlug, tenantId);
    const unresolvable: string[] = modelId === null ? [payload.modelSlug] : [];
    const fallbackModelIds: string[] = [];
    for (const slug of payload.fallbackModelSlugs ?? []) {
      const resolved = await this.resolveModelIdBySlugVisible(slug, tenantId);
      if (resolved === null) unresolvable.push(slug);
      else fallbackModelIds.push(resolved);
    }
    if (unresolvable.length > 0) {
      throw new ConflictException({
        message: `This bundle names model(s) this tenant cannot see: ${[...new Set(unresolvable)].join(', ')}. Register them (or ask a platform administrator to) before importing.`,
        code: 'MODEL_NOT_RESOLVABLE',
      });
    }

    const warnings = [...(payload.notes ?? [])];
    const instruction = await this.instructionForBundleImport(payload, tenantId);
    await this.assertToolsVisible(payload.tools ?? null, tenantId);

    const slug = dto.slug ?? payload.slug;
    this.assertTagGrammar(payload.tags);

    const view = this.viewOf(payload.task as AgentTask, { ...payload, instruction });
    const model = await this.loadModelOrThrow(modelId as string, tenantId);
    const fallbackModels = await this.loadFallbackModelsOrThrow(fallbackModelIds, tenantId);
    this.throwIfBlocking(this.structuralFindings(view, model, fallbackModels), 'The imported agent configuration is not valid.');

    const saved = await this.databaseService.baseClient.$transaction(async (tx) => {
      const maxVersionNumber = await this.agentRepository.findMaxVersionNumber(tenantId, slug, tx);
      const entity = AgentFactory.CreateAgent({
        tenantId,
        slug,
        name: dto.name ?? payload.name,
        description: payload.description ?? null,
        task: payload.task as AgentTask,
        versionNumber: maxVersionNumber + 1,
        modelId: modelId as string,
        instruction: (instruction ?? null) as JsonValue | null,
        parameters: (payload.parameters ?? null) as JsonValue | null,
        inputSchema: (payload.inputSchema ?? null) as JsonValue | null,
        outputSchema: (payload.outputSchema ?? null) as JsonValue | null,
        tools: (payload.tools ?? null) as JsonValue | null,
        tags: payload.tags ?? [],
        // A bundle carries no ROW id and no tenant id, so an import can only record the
        // LINEAGE half of the provenance pair. That is the honest record: it says which
        // lineage and version this came from, and does not invent a row it never saw.
        sourceSlug: envelope.source.slug,
        sourceVersionNumber: envelope.source.version,
        createdBy: this.requestUserId ?? undefined,
      });
      entity.validate();
      const created = await this.agentRepository.create(entity, tx);
      await this.writeFallbacks(created, fallbackModels, tx);
      return created;
    });

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { action: 'import', slug: saved.slug, versionNumber: saved.versionNumber, sourceSlug: envelope.source.slug, warnings },
    });
    return this.respond(saved);
  }

  async syncToTenants(slug: string, dto: SyncAgentRequest): Promise<AgentSyncResponse> {
    const tenantId = this.requireTenant();
    const userId = this.requestUserId;
    if (!userId) throw new ForbiddenException('Syncing an agent requires an authenticated user.');

    // TASK-889 — every step of a sync NAMES the tenant it acts on (`runInTenantContext`), so the
    // tenant-scope extension filters it as it would an ordinary single-tenant request. Here that
    // is the source: the agent version, and — hoisted out of the per-target copy on purpose —
    // its fallback chain. `AgentModelFallback` is a plain tenant-scoped model, so a read of it
    // inside a TARGET's step would answer for the target and the chain would silently vanish.
    const { source, sourceFallbacks } = await runInTenantContext(this.clsService, tenantId, async () => {
      const resolved = await this.resolveOwnSource(slug, dto.sourceVersionNumber);
      return { source: resolved, sourceFallbacks: await this.fallbackRepository.findByAgentId(resolved.id) };
    });
    const targets = [...new Set(dto.targetTenantIds)];
    if (targets.includes(tenantId)) {
      throw new BadRequestException('A sync pushes an agent into OTHER tenants; the source tenant is already where it lives.');
    }

    // THE authorization control, and it runs before any target is read or written — so the
    // 404 below is only ever observable by someone already entitled to observe it.
    for (const target of targets) await this.assertManagesAgentsIn(userId, target);

    // Reference gates that do not depend on the target, checked ONCE and before the write.
    await this.assertPortableAcrossTenants(source);

    const results = await this.databaseService.baseClient.$transaction(
      async (tx) => {
        const out: Array<{ tenantId: string; agentId: string; slug: string; versionNumber: number; warnings: string[] }> = [];
        for (const target of targets) {
          // Each target's copy runs AS that target — never under the caller's own working tenant,
          // and never under a tenant `assertManagesAgentsIn` has not just cleared.
          const { saved, warnings } = await runInTenantContext(this.clsService, target, () =>
            this.writeCopy(source, target, { slug: source.slug, name: source.name, description: source.description ?? null }, tx, sourceFallbacks),
          );
          out.push({ tenantId: target, agentId: saved.id, slug: saved.slug, versionNumber: saved.versionNumber, warnings });
        }
        return out;
      },
      // ONE transaction for every target: "half the tenants got the new agent" is a state no
      // operator can reason about, and the alternative — per-target commits — makes a
      // mid-sequence 409 permanent for the tenants already written.
      { timeout: 30_000 },
    );

    for (const result of results) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: result.agentId,
        data: {
          action: 'sync',
          sourceTenantId: tenantId,
          targetTenantId: result.tenantId,
          sourceAgentId: source.id,
          slug: result.slug,
          versionNumber: result.versionNumber,
          reason: dto.reason ?? null,
        },
      });
    }

    return { sourceSlug: source.slug, sourceVersionNumber: source.versionNumber, targets: results };
  }

  // ------------------------------------------------------------
  // Portability internals
  // ------------------------------------------------------------

  /** The `key:value` grammar owner decision #6 rests on; a bare key is refused, never trimmed away. */
  private assertTagGrammar(tags?: readonly string[]): void {
    if (tags === undefined) return;
    const problems = agentTagProblems(tags);
    if (problems.length > 0) {
      throw new BadRequestException({ message: 'Agent tags must be `key:value` pairs.', code: 'TAG_GRAMMAR', findings: problems });
    }
  }

  /**
   * The version a clone/export starts from: the caller's OWN lineage (any status — a draft is
   * clonable) or a SYSTEM template (PUBLISHED only, since a SYSTEM draft is unreleased platform
   * work — the same line `newVersion` draws). Anything else is 404, cross-tenant included.
   */
  private async resolveVisibleSource(slug: string, versionNumber?: number): Promise<AgentEntity> {
    const tenantId = this.requireTenant();
    const own = await this.agentRepository.findAllVersionsBySlug(tenantId, slug);
    if (own.length > 0) {
      return this.pickVersion(own, slug, versionNumber);
    }
    const shared =
      versionNumber !== undefined
        ? await this.agentRepository.findPublishedVisibleBySlugVersion(tenantId, slug, versionNumber)
        : await this.agentRepository.findPublishedActiveBySlug(tenantId, slug);
    if (!shared) throw new NotFoundException('Agent not found');
    return shared;
  }

  /** A sync pushes the caller's OWN agent; a SYSTEM template is already visible everywhere. */
  private async resolveOwnSource(slug: string, versionNumber?: number): Promise<AgentEntity> {
    const tenantId = this.requireTenant();
    const own = await this.agentRepository.findAllVersionsBySlug(tenantId, slug);
    if (own.length === 0) throw new NotFoundException('Agent not found');
    return this.pickVersion(own, slug, versionNumber);
  }

  /** An explicit version, else the ACTIVE PUBLISHED row, else the newest — never a silent guess between them. */
  private pickVersion(versions: AgentEntity[], slug: string, versionNumber?: number): AgentEntity {
    if (versionNumber !== undefined) {
      const match = versions.find((row) => row.versionNumber === versionNumber);
      if (!match) throw new NotFoundException(`Agent '${slug}' has no version ${versionNumber}`);
      return match;
    }
    return versions.find((row) => row.isActive && row.status === WorkflowDefinitionStatus.PUBLISHED) ?? versions[0];
  }

  private async loadBoundTemplate(entity: AgentEntity): Promise<PromptTemplateEntity | null> {
    const templateId = asRecord(entity.instruction)?.[PROMPT_TEMPLATE_ID_KEY];
    if (typeof templateId !== 'string' || templateId.length === 0 || !this.promptTemplateRepository) return null;
    return this.promptTemplateRepository.findById(templateId).catch(() => null);
  }

  /** A model slug the CALLER's tenant can bind: its own row shadows SYSTEM's. `null` ⇒ the caller must be told which slug failed. */
  private async resolveModelIdBySlugVisible(slug: string, tenantId: string): Promise<string | null> {
    const own = await this.aiModelRepository.findBySlug(tenantId, slug).catch(() => null);
    if (own) return own.id;
    if (tenantId === SYSTEM_TENANT_ID) return null;
    const platform = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug).catch(() => null);
    return platform?.id ?? null;
  }

  /** The instruction an imported bundle stores: the ref resolved back to an id, or a 409 naming it. */
  private async instructionForBundleImport(payload: AgentBundlePayload, tenantId: string): Promise<Record<string, unknown> | null> {
    const ref = readPromptTemplateRef(payload.instruction);
    if (!ref) return instructionForImport(payload.instruction, null);

    if (ref.kind === 'system' && ref.id) {
      const system = await this.promptTemplateRepository?.findById(ref.id).catch(() => null);
      // Same row ⇒ the version pin still numbers a version that exists, so it survives.
      if (system && system.tenantId === SYSTEM_TENANT_ID)
        return instructionForImport(payload.instruction, { templateId: system.id, keepVersionPin: true });
    }

    const own = await this.promptTemplateRepository?.findByName(tenantId, ref.name).catch(() => null);
    if (!own) {
      throw new ConflictException({
        message: `This bundle binds the prompt template '${ref.name}', which this tenant does not have. Create it (or import the template first), then import the agent.`,
        code: 'PROMPT_TEMPLATE_NOT_RESOLVABLE',
      });
    }
    // A DIFFERENT row: its version lineage is its own, so the source's pin numbers a version
    // that may not exist here. Dropping it follows the resolved template's approved version.
    return instructionForImport(payload.instruction, { templateId: own.id, keepVersionPin: false });
  }

  /** Every tool binding must name a server this tenant can actually reach; a dangling one is a 409, never a silent drop. */
  private async assertToolsVisible(tools: Array<Record<string, unknown>> | null, tenantId: string): Promise<void> {
    const ids = toolServerIds(tools);
    if (ids.length === 0 || !this.mcpServerRepository) return;
    const missing: string[] = [];
    for (const id of ids) {
      const server = await this.mcpServerRepository.findEnabledById(id).catch(() => null);
      if (!server || (server.tenantId !== tenantId && server.tenantId !== SYSTEM_TENANT_ID)) missing.push(id);
    }
    if (missing.length > 0) {
      throw new ConflictException({
        message: `This bundle binds MCP server(s) this tenant cannot reach: ${missing.join(', ')}. Configure them before importing.`,
        code: 'MCP_SERVER_NOT_RESOLVABLE',
      });
    }
  }

  /**
   * The two bindings that cannot cross a tenant boundary at all. Checked BEFORE the copy so a
   * refusal costs nothing, and named so the fix is obvious: re-bind to a SYSTEM object, or use
   * export/import and let the target bind its own.
   */
  private async assertPortableAcrossTenants(source: AgentEntity): Promise<void> {
    const template = await this.loadBoundTemplate(source);
    const boundId = asRecord(source.instruction)?.[PROMPT_TEMPLATE_ID_KEY];
    if (typeof boundId === 'string' && boundId.length > 0 && (!template || template.tenantId !== SYSTEM_TENANT_ID)) {
      throw new ConflictException({
        message: `Agent '${source.slug}' binds a prompt template that is not SYSTEM-owned, so it cannot be resolved in another tenant. Re-bind it to a platform template, or export it and let the target tenant bind its own.`,
        code: 'PROMPT_TEMPLATE_NOT_PORTABLE',
      });
    }

    const ids = toolServerIds((Array.isArray(source.tools) ? source.tools : null) as Array<Record<string, unknown>> | null);
    for (const id of ids) {
      const server = await this.mcpServerRepository?.findEnabledById(id).catch(() => null);
      if (!server || server.tenantId !== SYSTEM_TENANT_ID) {
        throw new ConflictException({
          message: `Agent '${source.slug}' binds MCP server ${id}, which is not part of the SYSTEM registry and therefore does not exist in another tenant.`,
          code: 'MCP_SERVER_NOT_PORTABLE',
        });
      }
    }
  }

  /**
   * The caller must hold `manage:Agent` in the target.
   *
   * A customer tenant they do not manage is **404**: the tenant id space is not theirs to probe,
   * so "you may not" and "there is no such tenant" must be one answer.
   *
   * SYSTEM is the exception, and deliberately so — its existence is not a secret (every tenant
   * READS its templates through the shared-read cascade), so hiding it behind a 404 would
   * conceal nothing and mislead the caller about why the push failed. It is a **403** naming the
   * real rule: only a platform administrator manages the platform tier.
   */
  private async assertManagesAgentsIn(userId: string, targetTenantId: string): Promise<void> {
    if (!this.policyEngine) {
      // Fail CLOSED: without the engine there is no way to answer "does this caller manage that
      // tenant?", and a cross-tenant write is not a thing to attempt on an unanswered question.
      throw new ForbiddenException('Agent sync is unavailable: the authorization engine is not wired.');
    }
    const ability = await this.policyEngine.buildAbility({ userId, tenantId: targetTenantId }).catch(() => null);
    if (ability?.can('manage', 'Agent')) return;
    if (targetTenantId === SYSTEM_TENANT_ID) {
      throw new ForbiddenException('Only a platform administrator manages the SYSTEM tier; publish into it through the promotion path.');
    }
    throw new NotFoundException(`Tenant ${targetTenantId} not found`);
  }

  /** Clone/sync body: resolve the references, then write the DRAFT. Own transaction unless one is supplied. */
  private async copyInto(
    source: AgentEntity,
    targetTenantId: string,
    overrides: { slug: string; name?: string; description?: string | null; tags?: string[] },
  ): Promise<{ saved: AgentEntity; fallbacks: AgentModelFallbackEntity[]; warnings: string[] }> {
    if (targetTenantId !== source.tenantId) await this.assertPortableAcrossTenants(source);
    return this.databaseService.baseClient.$transaction(async (tx) => this.writeCopy(source, targetTenantId, overrides, tx));
  }

  private async writeCopy(
    source: AgentEntity,
    targetTenantId: string,
    overrides: { slug: string; name?: string; description?: string | null; tags?: string[] },
    tx: unknown,
    /**
     * The source agent's fallback chain, when the CALLER already read it in the source tenant's
     * context (TASK-889 — `syncToTenants`). Omitted on the clone path, where this method still
     * runs in the caller's own context and the read below is correct as it stands. Passing it is
     * not an optimisation: a target step cannot read a source-tenant row through the scoped
     * client, so the value has to arrive already read.
     */
    knownSourceFallbacks?: readonly AgentModelFallbackEntity[],
  ): Promise<{ saved: AgentEntity; fallbacks: AgentModelFallbackEntity[]; warnings: string[] }> {
    const crossTenant = targetTenantId !== source.tenantId;
    const warnings: string[] = [];

    const modelId = await this.resolveModelIdForTarget(source.modelId, targetTenantId, tx);
    const sourceFallbacks = [...(knownSourceFallbacks ?? (await this.fallbackRepository.findByAgentId(source.id)))].sort(
      (a, b) => a.priority - b.priority,
    );
    const fallbackModelIds: string[] = [];
    for (const row of sourceFallbacks) fallbackModelIds.push(await this.resolveModelIdForTarget(row.modelId, targetTenantId, tx));

    const instruction = { ...(asRecord(source.instruction) ?? {}) };
    const hadInstruction = asRecord(source.instruction) !== undefined;
    if (crossTenant && EVAL_GATE_KEY in instruction) {
      delete instruction[EVAL_GATE_KEY];
      warnings.push(
        'The eval gate was not copied: a golden set is a corpus of encrypted patient data and its pointer never leaves the tenant. Bind one in the target tenant.',
      );
    }
    if (crossTenant && typeof instruction[PROMPT_VERSION_NUMBER_KEY] === 'number' && !(PROMPT_TEMPLATE_ID_KEY in instruction)) {
      delete instruction[PROMPT_VERSION_NUMBER_KEY];
    }

    const maxVersionNumber = await this.agentRepository.findMaxVersionNumber(targetTenantId, overrides.slug, tx);
    const entity = AgentFactory.CreateAgent({
      tenantId: targetTenantId,
      slug: overrides.slug,
      name: overrides.name ?? source.name,
      description: overrides.description ?? source.description ?? null,
      task: source.task,
      versionNumber: maxVersionNumber + 1,
      // `parentVersionId` stays NULL: it means "the previous version of THIS lineage", and a
      // copy starts a different one. The provenance edge is the four `source*` columns.
      modelId,
      instruction: (hadInstruction ? instruction : null) as JsonValue | null,
      parameters: source.parameters ?? null,
      inputSchema: source.inputSchema ?? null,
      outputSchema: source.outputSchema ?? null,
      tools: source.tools ?? null,
      tags: overrides.tags ?? source.tags ?? [],
      sourceAgentId: source.id,
      sourceTenantId: source.tenantId,
      sourceSlug: source.slug,
      sourceVersionNumber: source.versionNumber,
      createdBy: this.requestUserId ?? undefined,
    });
    entity.validate();
    const saved = await this.agentRepository.create(entity, tx);

    const fallbacks: AgentModelFallbackEntity[] = [];
    for (const [priority, id] of fallbackModelIds.entries()) {
      const link = AgentModelFallbackFactory.CreateAgentModelFallback({
        tenantId: targetTenantId,
        agentId: saved.id,
        priority,
        modelId: id,
        createdBy: this.requestUserId ?? undefined,
      });
      link.validate();
      fallbacks.push(await this.fallbackRepository.create(link, tx));
    }

    return { saved, fallbacks, warnings };
  }

  /**
   * The model row the TARGET tenant must bind. Same-tenant (or a SYSTEM row) keeps the id; a
   * different tenant re-resolves BY SLUG — its own row first, SYSTEM's otherwise — and a slug
   * that resolves to nothing is a 409 naming it, never a dangling `modelId`.
   *
   * The reads take `tx`, which is what makes the target-tenant filter explicit rather than the
   * caller-scoped widening the extended client would apply.
   */
  private async resolveModelIdForTarget(modelId: string, targetTenantId: string, tx: unknown): Promise<string> {
    const source = await this.aiModelRepository.findByIdOrNull(modelId, tx).catch(() => null);
    if (!source) {
      throw new ConflictException({
        message: `The bound model row ${modelId} could not be read, so the copy would leave a dangling reference.`,
        code: 'MODEL_NOT_RESOLVABLE',
      });
    }
    if (source.tenantId === targetTenantId || source.tenantId === SYSTEM_TENANT_ID) return source.id;

    const own = await this.aiModelRepository.findBySlug(targetTenantId, source.slug, tx).catch(() => null);
    if (own) return own.id;
    const platform = await this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, source.slug, tx).catch(() => null);
    if (platform) return platform.id;
    throw new ConflictException({
      message: `Tenant ${targetTenantId} has no model registered as '${source.slug}', so the copy would leave a dangling reference. Register it there, or ask a platform administrator to publish it.`,
      code: 'MODEL_NOT_RESOLVABLE',
    });
  }

  /**
   * A copy's response built from the rows the copy itself wrote, rather than re-reading them:
   * a cross-tenant clone's fallback rows are plain tenant-scoped and invisible to the caller,
   * so a re-read would report an empty chain that was in fact written.
   */
  private async respondCopy(entity: AgentEntity, fallbacks: AgentModelFallbackEntity[]): Promise<AgentResponse> {
    const slugs = await this.modelSlugMap([entity.task]);
    return AgentDtoMapper.toResponse(entity, fallbacks, slugs);
  }

  // ============================================================
  // Findings — the ONE place that decides publishability
  // ============================================================

  private async collectFindings(entity: AgentEntity): Promise<{
    report: AgentValidationReport;
    model: AiModelEntity | null;
    fallbackModels: AiModelEntity[];
    resolvedPrompt: ResolvedPrompt;
  }> {
    const findings: AgentFinding[] = [];
    const model = await this.loadModel(entity.modelId, entity.tenantId);
    if (!model) {
      findings.push({
        severity: 'ERROR',
        code: 'MODEL_NOT_FOUND',
        path: 'modelId',
        message: `Model ${entity.modelId} is not visible to this tenant.`,
      });
    }
    const fallbackRows = await this.fallbackRepository.findByAgentId(entity.id);
    const fallbackModels: AiModelEntity[] = [];
    for (const row of fallbackRows) {
      const fallback = await this.loadModel(row.modelId, entity.tenantId);
      if (!fallback) {
        findings.push({
          severity: 'ERROR',
          code: 'MODEL_NOT_FOUND',
          path: `fallbacks[${row.priority}]`,
          message: `Fallback model ${row.modelId} is not visible to this tenant.`,
        });
      } else {
        fallbackModels.push(fallback);
      }
    }

    findings.push(
      ...this.structuralFindings(
        this.viewOf(entity.task, entity),
        model ?? undefined,
        fallbackModels,
        model ? this.capabilitiesOf(model) : undefined,
      ),
    );

    if (model) findings.push(...(await this.availabilityFindings(model, entity.task, entity.tenantId, 'modelId')));
    for (const [index, fallback] of fallbackModels.entries()) {
      findings.push(...(await this.availabilityFindings(fallback, entity.task, entity.tenantId, `fallbacks[${index}]`)));
    }

    let resolvedPrompt: ResolvedPrompt = null;
    if (entity.task === AgentTask.TEXT_GENERATION) {
      const outcome = await this.resolvePrompt(asRecord(entity.instruction));
      findings.push(...outcome.findings);
      resolvedPrompt = outcome.resolvedPrompt;
    }

    const report: AgentValidationReport = { checkedAt: new Date().toISOString(), blocking: hasBlocking(findings), findings };
    return { report, model, fallbackModels, resolvedPrompt };
  }

  /** Pure checks: the contract's `agentConfigProblems` + JSON-Schema value checks + authorable I/O schemas. */
  private structuralFindings(
    view: AgentConfigView,
    model?: AiModelEntity,
    fallbackModels: AiModelEntity[] = [],
    capabilities?: AgentProviderCapabilities,
  ): AgentFinding[] {
    const findings: AgentFinding[] = agentConfigProblems(view, {
      model: model ? toModelView(model) : undefined,
      fallbackModels: fallbackModels.map(toModelView),
      capabilities,
    }).map((problem) => ({ ...problem, code: codeForConfigProblem(problem) }));

    const parameters = asRecord(view.parameters);
    if (parameters) {
      for (const problem of jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS[view.task], parameters, 'parameters')) {
        findings.push({ severity: 'ERROR', code: 'SCHEMA', path: 'parameters', message: problem });
      }
    }
    const instructionSchema = AGENT_INSTRUCTION_SCHEMAS[view.task];
    const instruction = asRecord(view.instruction);
    if (instruction && instructionSchema) {
      for (const problem of jsonSchemaValueProblems(instructionSchema, instruction, 'instruction')) {
        findings.push({ severity: 'ERROR', code: 'SCHEMA', path: 'instruction', message: problem });
      }
    }
    for (const [column, schema] of [
      ['inputSchema', view.inputSchema],
      ['outputSchema', view.outputSchema],
    ] as const) {
      if (schema) {
        for (const problem of authorableJsonSchemaProblems(schema, column)) {
          findings.push({ severity: 'ERROR', code: 'SCHEMA', path: column, message: problem });
        }
      }
    }
    return findings;
  }

  /**
   * Availability, fail-closed (R-7): ENABLED; a cloud provider needs an enabled
   * `AiProviderConnection(service, provider)` at tenant or SYSTEM; an engine-served provider
   * needs nothing more; bucket-staged weights need `localPath` (or a DOWNLOADED status).
   * TODO(TASK-860): switch to the measured `AiModel.availability`.
   */
  private async availabilityFindings(model: AiModelEntity, task: AgentTask, tenantId: string, path: string): Promise<AgentFinding[]> {
    if (model.resourceStatus !== ResourceStatusType.ENABLED) {
      return [{ severity: 'ERROR', code: 'MODEL_DISABLED', path, message: `Model \`${model.slug}\` is ${model.resourceStatus}.` }];
    }
    const service = AGENT_TASK_SERVICE[task];
    const provider = model.provider ?? null;
    if (provider && isCloudByoProvider(service, provider)) {
      // TODO(TASK-862): ProviderCredentialResolver.resolve(service, provider, tenantId) → { override, fundingTier, connectionId }.
      const connection = this.providerConnections ? await this.providerConnections.resolveConnection(service, provider, tenantId) : null;
      if (!connection) {
        return [
          {
            severity: 'ERROR',
            code: 'MODEL_UNAVAILABLE',
            path,
            message: `Model \`${model.slug}\` is served by \`${provider}\` and no enabled ${service}/${provider} provider connection exists at the tenant or SYSTEM tier.`,
          },
        ];
      }
      return [];
    }
    if (provider && ENGINE_SERVED_PROVIDERS.has(provider)) return [];
    const staged = typeof model.localPath === 'string' && model.localPath.length > 0;
    const downloaded = String((model as unknown as { downloadStatus?: unknown }).downloadStatus ?? '') === 'DOWNLOADED';
    if (!staged && !downloaded) {
      return [
        {
          severity: 'ERROR',
          code: 'MODEL_UNAVAILABLE',
          path,
          message: `Model \`${model.slug}\` has no staged weights (no localPath and not DOWNLOADED); publish is refused until the weights are available.`,
        },
      ];
    }
    return [];
  }

  /** Template-bound instruction ⇒ the template must be APPROVED and the pinned version must exist (R-7). */
  private async resolvePrompt(
    instruction: Record<string, unknown> | undefined,
  ): Promise<{ findings: AgentFinding[]; resolvedPrompt: ResolvedPrompt }> {
    if (!instruction) return { findings: [], resolvedPrompt: null };
    const systemPrompt = typeof instruction.systemPrompt === 'string' ? instruction.systemPrompt : undefined;
    const templateId = typeof instruction.promptTemplateId === 'string' ? instruction.promptTemplateId : undefined;
    if (!templateId) {
      return { findings: [], resolvedPrompt: systemPrompt ? { source: 'inline', content: systemPrompt } : null };
    }
    if (!this.promptTemplateRepository || !this.promptVersionRepository) {
      return {
        findings: [
          {
            severity: 'ERROR',
            code: 'TEMPLATE_NOT_FOUND',
            path: 'instruction.promptTemplateId',
            message: 'Prompt templates are not available to this service instance.',
          },
        ],
        resolvedPrompt: null,
      };
    }
    const template = await this.promptTemplateRepository.findById(templateId).catch(() => null);
    if (!template) {
      return {
        findings: [
          {
            severity: 'ERROR',
            code: 'TEMPLATE_NOT_FOUND',
            path: 'instruction.promptTemplateId',
            message: `Prompt template ${templateId} is not visible to this tenant.`,
          },
        ],
        resolvedPrompt: null,
      };
    }
    if (template.status !== 'APPROVED') {
      return {
        findings: [
          {
            severity: 'ERROR',
            code: 'TEMPLATE_NOT_APPROVED',
            path: 'instruction.promptTemplateId',
            message: `Prompt template \`${template.name ?? templateId}\` is ${template.status ?? 'DRAFT'}; an agent instruction must bind an APPROVED template.`,
          },
        ],
        resolvedPrompt: null,
      };
    }
    const versionNumber =
      typeof instruction.promptVersionNumber === 'number'
        ? instruction.promptVersionNumber
        : (template.approvedVersionNumber ?? template.currentVersionNumber ?? null);
    const version =
      versionNumber !== null ? await this.promptVersionRepository.findByVersionNumber(templateId, versionNumber).catch(() => null) : null;
    if (!version || versionNumber === null) {
      return {
        findings: [
          {
            severity: 'ERROR',
            code: 'TEMPLATE_VERSION_NOT_FOUND',
            path: 'instruction.promptVersionNumber',
            message: `Prompt template ${templateId} has no version ${versionNumber ?? '(unpinned)'}.`,
          },
        ],
        resolvedPrompt: null,
      };
    }
    return {
      findings: [],
      resolvedPrompt: {
        source: 'template',
        promptTemplateId: templateId,
        promptVersionNumber: versionNumber,
        content: version.content ?? template.content ?? '',
      },
    };
  }

  /** What the resolved provider configuration declares it can do — read off the model row for now. TODO(TASK-862). */
  private capabilitiesOf(model: AiModelEntity): AgentProviderCapabilities {
    const meta = asRecord(model.metaData) ?? {};
    const caps = asRecord(meta.capabilities) ?? meta;
    const supported = Array.isArray(caps.supportedGenerationParams) ? (caps.supportedGenerationParams as string[]) : undefined;
    const supportsSsml = typeof caps.supportsSsml === 'boolean' ? caps.supportsSsml : undefined;
    return { supportedGenerationParams: supported, supportsSsml, label: `${model.provider ?? 'local'}/${model.slug}` };
  }

  private compile(
    entity: AgentEntity,
    model: AiModelEntity,
    fallbackModels: AiModelEntity[],
    fallbackRows: AgentModelFallbackEntity[],
    resolvedPrompt: ResolvedPrompt,
  ): AgentCompiledConfig {
    const byId = new Map(fallbackModels.map((row) => [row.id, row]));
    const defaults = AGENT_IO_DEFAULTS[entity.task];
    return {
      task: entity.task,
      service: AGENT_TASK_SERVICE[entity.task],
      model: { id: model.id, slug: model.slug, provider: model.provider ?? null, taskType: String(model.taskType) },
      fallbacks: [...fallbackRows]
        .filter((row) => row.enabled)
        .sort((a, b) => a.priority - b.priority)
        .map((row) => {
          const fallback = byId.get(row.modelId);
          return { priority: row.priority, id: row.modelId, slug: fallback?.slug ?? row.modelId, provider: fallback?.provider ?? null };
        }),
      instruction: asRecord(entity.instruction) ?? null,
      resolvedPrompt,
      parameters: asRecord(entity.parameters) ?? {},
      inputSchema: asRecord(entity.inputSchema) ?? (defaults.inputSchema as Record<string, unknown>),
      outputSchema: asRecord(entity.outputSchema) ?? (defaults.outputSchema as Record<string, unknown>),
      tools: (Array.isArray(entity.tools) ? entity.tools : []) as Array<{ mcpServerId: string; toolName: string }>,
      protocols: [...AGENT_PROTOCOLS[entity.task]],
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new ArgumentInvalidException('Tenant context required');
    return tenantId;
  }

  private viewOf(
    task: AgentTask,
    source: { instruction?: unknown; parameters?: unknown; inputSchema?: unknown; outputSchema?: unknown; tools?: unknown },
  ): AgentConfigView {
    return {
      task,
      instruction: asRecord(source.instruction) ?? null,
      parameters: asRecord(source.parameters) ?? null,
      inputSchema: asRecord(source.inputSchema) ?? null,
      outputSchema: asRecord(source.outputSchema) ?? null,
      tools: Array.isArray(source.tools) ? source.tools : null,
    };
  }

  private throwIfBlocking(findings: readonly AgentFinding[], message: string): void {
    const blocking = findings.filter((finding) => finding.severity === 'ERROR');
    if (blocking.length === 0) return;
    throw new BadRequestException({ message, code: blocking[0].code, findings });
  }

  /** A row visible to the tenant (own or SYSTEM); 404 otherwise. */
  private async loadVisible(id: string): Promise<AgentEntity> {
    const tenantId = this.requireTenant();
    const entity = await this.agentRepository.findByIdVisible(id, tenantId);
    if (!entity) throw new NotFoundException('Agent not found');
    return entity;
  }

  /** 404-over-403: a foreign row — and a SYSTEM row, for a write — is indistinguishable from a missing one. */
  private async loadOwned(id: string): Promise<AgentEntity> {
    const tenantId = this.requireTenant();
    const entity = await this.agentRepository.findByIdVisible(id, tenantId);
    if (!entity || entity.tenantId !== tenantId) throw new NotFoundException('Agent not found');
    return entity;
  }

  private assertMutable(entity: AgentEntity): void {
    if (PUBLISHED_OR_DEPRECATED.has(entity.status)) {
      throw new BadRequestException(`Agent ${entity.id} is ${entity.status} and can no longer be edited. Branch a new version instead.`);
    }
  }

  private async loadModel(modelId: string, tenantId: string): Promise<AiModelEntity | null> {
    const model = await this.aiModelRepository.findById(modelId).catch(() => null);
    if (!model) return null;
    return model.tenantId === tenantId || model.tenantId === SYSTEM_TENANT_ID ? model : null;
  }

  private async loadModelOrThrow(modelId: string, tenantId: string): Promise<AiModelEntity> {
    const model = await this.loadModel(modelId, tenantId);
    if (!model) throw new BadRequestException({ message: `Unknown modelId '${modelId}'.`, code: 'MODEL_NOT_FOUND' });
    return model;
  }

  private async loadFallbackModelsOrThrow(modelIds: readonly string[], tenantId: string): Promise<AiModelEntity[]> {
    const models: AiModelEntity[] = [];
    for (const modelId of modelIds) models.push(await this.loadModelOrThrow(modelId, tenantId));
    return models;
  }

  private async writeFallbacks(agent: AgentEntity, models: readonly { id: string }[], tx: unknown): Promise<void> {
    for (const [priority, model] of models.entries()) {
      const link = AgentModelFallbackFactory.CreateAgentModelFallback({
        tenantId: agent.tenantId,
        agentId: agent.id,
        priority,
        modelId: model.id,
        createdBy: this.requestUserId ?? undefined,
      });
      link.validate();
      await this.fallbackRepository.create(link, tx);
    }
  }

  private async demoteExistingActive(tenantId: string, slug: string, exceptId: string): Promise<void> {
    const current = await this.agentRepository.findOwnActiveBySlug(tenantId, slug);
    if (!current || current.id === exceptId) return;
    current.isActive = false;
    current.updatedBy = this.requestUserId ?? undefined;
    await this.agentRepository.update(current.id, current);
  }

  private async tenantDefaultSlugs(tenantId: string, tasks: readonly AgentTask[]): Promise<Map<AgentTask, string | null>> {
    const defaults = new Map<AgentTask, string | null>();
    if (!this.assignments) return defaults;
    for (const task of tasks) {
      const resolved = await this.assignments.resolve(tenantId, task, null);
      defaults.set(task, resolved.agentSlug);
    }
    return defaults;
  }

  private async modelSlugMap(tasks: readonly AgentTask[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const task of new Set(tasks)) {
      const taskType = AGENT_TASK_MODEL_TASK_TYPE[task] as ModelTaskType;
      const models = await this.aiModelRepository.findByTaskTypeSharedRead(taskType).catch(() => [] as AiModelEntity[]);
      for (const model of models) map.set(model.id, model.slug);
    }
    return map;
  }

  private async respond(entity: AgentEntity): Promise<AgentResponse> {
    const fallbacks = await this.fallbackRepository.findByAgentId(entity.id);
    const slugs = await this.modelSlugMap([entity.task]);
    return AgentDtoMapper.toResponse(entity, fallbacks, slugs);
  }

  private async respondMany(entities: AgentEntity[]): Promise<AgentResponse[]> {
    const slugs = await this.modelSlugMap(entities.map((entity) => entity.task));
    const out: AgentResponse[] = [];
    for (const entity of entities) {
      const fallbacks = await this.fallbackRepository.findByAgentId(entity.id);
      out.push(AgentDtoMapper.toResponse(entity, fallbacks, slugs));
    }
    return out;
  }
}

function toModelView(model: AiModelEntity): AgentModelView {
  return { slug: model.slug, taskType: String(model.taskType), provider: model.provider ?? undefined };
}

function checksumOf(compiled: AgentCompiledConfig): string {
  return `sha256:${createHash('sha256').update(canonicalJson(compiled)).digest('hex')}`;
}
