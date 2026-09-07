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
  AiModelAvailability,
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
  TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  agentConfigProblems,
  agentTagProblems,
  buildPortableBundle,
  canonicalJson,
  portableBundleProblems,
  renderTemplate,
  templateReferenceProblems,
  templateSyntaxProblems,
  type AgentConfigView,
  type DeclaredNamespaces,
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
// TASK-890 L1 §3.7 — the provider CLASS table lives with the connection vocabulary it is derived
// from. This service is one of three consumers (the tenant catalogue and the BYO declaration are
// the others); the private `ENGINE_SERVED_PROVIDERS` that used to sit at the top of THIS file is
// gone, because two copies of "which providers serve their own weights" is two answers. It is not
// imported here either: `providerClassOf` is the only thing that should ever ASK that question,
// and a second reader of the raw set would be the first step back to a second answer.
import { MODEL_TASK_TYPE_SERVICE, providerClassOf, type ProviderClass, type ProviderService } from '../ai-provider-connection/constants';
import { IConsultationContextSchemaService } from '../consultation-context-schema/IConsultationContextSchemaService';
import { soleContextKindSchema, unwrapSingleKindContextPayload } from '../consultation-context-schema/context-schema-definition';
import type {
  ContextSchemaReferenceResolution,
  IConsultationContextSchemaService as IConsultationContextSchemaServicePort,
} from '../consultation-context-schema/IConsultationContextSchemaService';
import { IInferenceReadinessService } from '../ai-readiness/IInferenceReadinessService';
import type { IInferenceReadinessService as IInferenceReadinessServicePort } from '../ai-readiness/IInferenceReadinessService';
import { modelReadinessFrom } from '../ai-readiness/inference-readiness.types';
import type { InferenceReadinessSnapshot, ModelReadiness } from '../ai-readiness/inference-readiness.types';
import { AgentDraftTestService } from './agent-draft-test.service';
import { buildAgentPromptScope } from './agent-prompt-scope';
import { textWireProvider } from './text-generation-spec';
import type { CompiledModelRef } from './agent-wire-model';
import { AgentDtoMapper } from './agent.dto.mapper';
import { codeForConfigProblem, hasBlocking, type AgentFinding, type AgentValidationReport } from './agent-findings';
import { agentReasoningProblems } from './agent-reasoning';
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
  AgentTestAckResponse,
  AgentTestResultResponse,
  CloneAgentRequest,
  CreateAgentRequest,
  FinalizeAgentTestRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  SyncAgentRequest,
  TestAgentRequest,
  UpdateAgentRequest,
} from './dto';
import { IAgentService } from './IAgentService';

const PUBLISHED_OR_DEPRECATED: ReadonlySet<WorkflowDefinitionStatus> = new Set([
  WorkflowDefinitionStatus.PUBLISHED,
  WorkflowDefinitionStatus.DEPRECATED,
]);

type ResolvedPrompt = AgentCompiledConfig['resolvedPrompt'];

/**
 * TASK-890 §3.4 — the frozen context-schema snapshot a published agent carries.
 *
 * The shape lives on `AgentCompiledConfig` (`packages/types/src/agent.ts`) since the wave-2b
 * close; this alias is the local NAME the service reads it under, so the freeze site and the two
 * consumers (`testScope`, `assertContextConforms`) name one type rather than restating it.
 */
export type AgentCompiledContextSchema = NonNullable<AgentCompiledConfig['contextSchema']>;

/**
 * What the caller of `publishFindings` needs to know about ONE agent a `core.agent` node
 * references (`PublishAgentView` in `@arcaai/workflow-contract`). Restated structurally rather
 * than imported so this service does not depend on the publish-gate module's own shape.
 */
export interface AgentPublishView {
  declaredVariables: string[];
  contextPayloadSchema: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Whether a connection row actually CARRIES key material (§3.7, the "resolves but never
 * delivers" split). An ENABLED but KEYLESS row is an incomplete setup, not a working credential:
 * publishing onto it sends the author to a 503 at run time with no clue why.
 */
function hasKeyMaterial(ciphertext: Uint8Array | null | undefined): boolean {
  return ciphertext !== null && ciphertext !== undefined && ciphertext.length > 0;
}

/**
 * TASK-890 §3.14 — the AGENT level of the `node > workflow > agent > true` guardrail precedence.
 *
 * ABSENT MEANS ON, at every level. Guardrail is platform-managed and screening is the floor a
 * tenant opts OUT of; a missing `parameters.guards.enabled` is "no opinion", which resolves to
 * `true`, never to "off because nobody said on".
 */
function guardrailEnabledOf(parameters: unknown): boolean {
  const guards = asRecord(asRecord(parameters)?.guards);
  return guards?.enabled === false ? false : true;
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
    // TASK-890 L8. TRAILING and @Optional() for the same reason as the block above: positional
    // unit fixtures keep their arity. Each absence has a DECLARED consequence, never a silent
    // pass — an unresolvable context pin is an ERROR finding, absent readiness reports
    // `unknown` (which never blocks), and a draft test without its transport is a 400 that
    // names the misconfiguration.
    @Optional() @Inject(IConsultationContextSchemaService) private readonly contextSchemas?: IConsultationContextSchemaServicePort,
    @Optional() @Inject(IInferenceReadinessService) private readonly readiness?: IInferenceReadinessServicePort,
    @Optional() private readonly draftTest?: AgentDraftTestService,
  ) {
    super(eventEmitter, clsService, ResourceType.Agent);
  }

  // ============================================================
  // Reads
  // ============================================================

  /**
   * The caller tenant's OWN agents.
   *
   * TASK-890 L13 (OD-M) — there is no `includeTemplates`. It used to append the SYSTEM library to
   * a tenant's list, which is the shared-read posture §1.5 retires: an agent is CONTENT, so a
   * tenant sees the copies it was PROVISIONED with, each carrying `sourceTenantId = SYSTEM` for
   * the console's "from platform" badge. Nothing reads the SYSTEM library on a tenant-facing path.
   */
  async list(task?: AgentTask): Promise<AgentResponse[]> {
    const tenantId = this.requireTenant();
    const rows = await this.agentRepository.findAllForTenant(tenantId, task);
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
        contextSchemaId: dto.contextSchemaId ?? null,
        contextSchemaVersionNumber: dto.contextSchemaVersionNumber ?? null,
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
    if (dto.contextSchemaId !== undefined) entity.contextSchemaId = dto.contextSchemaId;
    if (dto.contextSchemaVersionNumber !== undefined) entity.contextSchemaVersionNumber = dto.contextSchemaVersionNumber;
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

    const { report, model, fallbackModels, resolvedPrompt, contextSchema } = await this.collectFindings(entity);
    entity.validationReport = report as unknown as JsonValue;
    entity.validatedAt = new Date();
    if (report.blocking) {
      // Persist the report so the console can show WHY, then fail closed.
      entity.status = WorkflowDefinitionStatus.DRAFT;
      await this.agentRepository.update(entity.id, entity);
      this.throwIfBlocking(report.findings, 'The agent cannot be published.');
    }

    const fallbackRows = await this.fallbackRepository.findByAgentId(entity.id);
    const compiled = this.compile(entity, model as AiModelEntity, fallbackModels, fallbackRows, resolvedPrompt, contextSchema);
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
    // TASK-890 H-6, the BRANCH half: a new version off a SYSTEM template must inherit the
    // template's fallback chain, and that chain is only readable under the SOURCE's tenant.
    const sourceFallbacks = await runInTenantContext(this.clsService, source.tenantId, () => this.fallbackRepository.findByAgentId(source.id));
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
        contextSchemaId: ownLineage ? (source.contextSchemaId ?? null) : null,
        contextSchemaVersionNumber: ownLineage ? (source.contextSchemaVersionNumber ?? null) : null,
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
  // The draft-agent test bench (TASK-890 §3.8, F-7)
  // ============================================================
  //
  // The gap this closes: before it, the only way to find out what an agent's prompt actually
  // renders to was to publish it, assign it and start a consultation. Every authoring mistake
  // — an unresolved variable, a template bound to the wrong version, a model nothing serves —
  // surfaced in front of a clinician instead of in front of its author.
  //
  // The bench compiles the DRAFT through the SAME `collectFindings` + `compile` path publish
  // uses and never persists `compiledConfig`. That identity is the whole point: a bench that
  // ran a different assembly would be a second implementation of the thing being tested, and
  // "it worked on the bench" would stop meaning anything.

  /**
   * §3.8 — assemble (and optionally run) one DRAFT agent.
   *
   * A dry run (the DEFAULT) generates nothing, meters nothing and returns the exact bytes that
   * would have gone to TEXT. That is the cheapest possible answer to "why is my prompt wrong",
   * and it is the default precisely so that finding out costs nothing.
   *
   * A non-dry run charges the tenant's own `monthlyLlmTokens` (OD-E: the test COUNTS — a bench
   * that spent platform money invisibly would be the one path where usage did not add up).
   *
   * @throws ConflictException — the row is PUBLISHED/DEPRECATED (a published agent is invoked,
   *   not tested: `POST /agents/{slug}/invocations`)
   * @throws NotFoundException — unknown, foreign, or SYSTEM id (404-over-403)
   * @throws BadRequestException — a blocking finding (with the findings), an unresolved prompt
   *   variable (naming the path), or a partial `{provider, model}` override
   */
  async testDraft(id: string, dto: TestAgentRequest): Promise<AgentTestAckResponse> {
    const entity = await this.loadOwned(id);
    if (PUBLISHED_OR_DEPRECATED.has(entity.status)) {
      throw new ConflictException({
        message: `Agent ${entity.id} is ${entity.status}; a published agent is INVOKED, not tested. Use POST /agents/${entity.slug}/invocations, or branch a new version to keep editing.`,
        code: 'AGENT_NOT_DRAFT',
      });
    }
    if (dto.provider !== undefined || dto.model !== undefined) {
      if (!dto.provider || !dto.model) {
        throw new BadRequestException({ message: '`provider` and `model` must be supplied together.', code: 'PROVIDER_MODEL_PAIR' });
      }
    }

    const { report, model, fallbackModels, resolvedPrompt, contextSchema } = await this.collectFindings(entity);
    // The same refusal publish makes, with the same shape the console already renders. Nothing
    // is persisted: a test must not move a draft's status or overwrite its stored report.
    this.throwIfBlocking(report.findings, 'The agent cannot be tested.');
    const compiled = this.compile(
      entity,
      model as AiModelEntity,
      fallbackModels,
      await this.fallbackRepository.findByAgentId(entity.id),
      resolvedPrompt,
      contextSchema,
    );

    // Built through the same failure mapping as the render below: a `{ path }` binding resolves
    // through the grammar, so an unresolvable one is a 400 naming the path, not a 500.
    const scope = this.renderMapped(() => this.testScope(entity, dto, contextSchema));
    const assembledSystemPrompt = compiled.resolvedPrompt ? this.render(compiled.resolvedPrompt.content, scope, 'instruction') : null;
    const assembledUserPrompt = typeof dto.input?.text === 'string' ? this.render(dto.input.text, scope, 'input.text') : '';

    const resolved = await this.testTarget(entity, model as AiModelEntity, dto);
    const ack: AgentTestAckResponse = {
      mode: 'dry-run',
      findings: report.findings as AgentTestAckResponse['findings'],
      assembledSystemPrompt,
      assembledUserPrompt,
      resolved,
    };
    if (dto.dryRun ?? true) return ack;

    if (entity.task !== AgentTask.TEXT_GENERATION) {
      // ASR / TTS drafts answer dry-run only: there is no prompt to stream and the resolved-spec
      // preview IS the useful answer. Saying so beats pretending to run something.
      throw new BadRequestException({
        message: `A ${entity.task} agent can only be dry-run: there is nothing to stream. Re-send with \`dryRun: true\` to see its resolved spec.`,
        code: 'DRY_RUN_ONLY',
      });
    }
    if (assembledUserPrompt.length === 0) {
      // Refused rather than sent: an empty prompt spends the tenant's own `monthlyLlmTokens`
      // allowance on a generation that answers nothing, and the author would read the resulting
      // noise as a defect in their agent. A DRY run with no `input.text` is fine — it still shows
      // the assembled system prompt and the resolved target.
      throw new BadRequestException({
        message: 'A live agent test needs something to run on: supply `input.text`. (A dry run does not.)',
        code: 'TEST_INPUT_REQUIRED',
      });
    }
    if (!this.draftTest) {
      throw new BadRequestException('A non-dry agent test cannot run: the test transport is not wired in this composition.');
    }

    const submission = await this.draftTest.submit({
      tenantId: entity.tenantId,
      prompt: assembledUserPrompt,
      systemPrompt: assembledSystemPrompt,
      provider: resolved.provider,
      model: resolved.model,
      guardrailEnabled: compiled.guardrail?.enabled ?? true,
    });
    return { ...ack, mode: 'stream', taskId: submission.taskId, streamUrl: submission.streamUrl };
  }

  /** §3.8 — read the finished run back SERVER-SIDE and record what it consumed (`trigger: AGENT_TEST`). */
  async finalizeDraftTest(id: string, dto: FinalizeAgentTestRequest): Promise<AgentTestResultResponse> {
    // The agent is re-checked even though the result comes from TEXT: `taskId` alone would let
    // any caller holding `manage:Agent` read back a generation started by another tenant.
    const entity = await this.loadOwned(id);
    if (!this.draftTest) {
      throw new BadRequestException('An agent test cannot be finalised: the test transport is not wired in this composition.');
    }
    return this.draftTest.finalize(entity.tenantId, dto.taskId);
  }

  /**
   * The §3.3 render scope for a draft test, in the SAME order the runtime builds it:
   * `context.*` (aliased as `trigger.*` so one prompt is portable between the two call shapes),
   * `input.*`, then the bare-name namespace — the agent's own `instruction.variables` bindings
   * resolved FIRST, then overlaid by the caller's `variables` (the caller wins, exactly as
   * `overrides.promptVariables` wins at a `core.agent` node).
   *
   * A `{ path }` binding is resolved through `renderTemplate` itself rather than a private
   * traversal: one grammar, one resolution, one set of edge cases (own properties only, `null`
   * is missing, non-strings canonically serialised).
   */
  private testScope(entity: AgentEntity, dto: TestAgentRequest, contextSchema: AgentCompiledContextSchema | null): Record<string, unknown> {
    const context = dto.context ?? {};
    this.assertContextConforms(context, contextSchema);
    // The SHARED builder, not a bench-local copy: the whole value of a draft test is that what
    // renders here is what will render on the invocation route, the realtime lane and the durable
    // lane. When the bench had its own scope it was the only site that resolved `{ path }`
    // bindings, so it rendered a value the three runtimes did not.
    return buildAgentPromptScope({
      // J3-5 — the object `{{context.*}}` resolves against, which under the single-kind rule is
      // the kind itself rather than the envelope wrapping it.
      trigger: this.contextRenderScope(context, contextSchema),
      input: dto.input ?? {},
      variables: { ...asRecord(asRecord(entity.instruction)?.variables), ...(dto.variables ?? {}) },
      templateRef: `agent:${entity.slug}`,
    });
  }

  /**
   * TASK-890 §3.4 — the frozen payload schema is ENFORCING, not advisory.
   *
   * An agent that pins a context schema declares what it needs to do its job; a call that omits
   * a REQUIRED kind is not a degraded call, it is a call that cannot be answered correctly, and
   * the honest failure is a refusal that NAMES the kind (TASK-859 invariant 3, fail closed).
   * Relaxing this to advisory is deliberately a one-line change: drop the throw.
   */
  private assertContextConforms(context: Record<string, unknown>, contextSchema: AgentCompiledContextSchema | null): void {
    if (!contextSchema) return;
    // J3-5 — the SAME rule the invocation route applies (`AgentInvocationService.contextProblems`).
    // The bench is only worth anything if what it accepts is what production accepts.
    const soleKind = soleContextKindSchema(contextSchema.payloadSchema);
    const problems =
      soleKind === null
        ? jsonSchemaValueProblems(contextSchema.payloadSchema, context, 'context')
        : jsonSchemaValueProblems(soleKind, this.contextRenderScope(context, contextSchema), 'context');
    if (problems.length === 0) return;
    throw new BadRequestException({
      message: `The supplied context does not satisfy the schema this agent binds (version ${contextSchema.versionNumber}).`,
      code: 'CONTEXT_SCHEMA_VIOLATION',
      findings: problems,
    });
  }

  /** One render, with an unresolved variable turned into a 400 that NAMES the path. */
  private render(content: string, scope: Record<string, unknown>, templateRef: string): string {
    return this.renderMapped(() => renderTemplate(content, scope, { templateRef }));
  }

  /** The grammar's two named failures, as the 400s a bench caller can act on. */
  private renderMapped<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof PromptVariableUnresolvedError) {
        throw new BadRequestException({ message: error.message, code: 'PROMPT_VARIABLE_UNRESOLVED', path: error.path });
      }
      if (error instanceof PromptTemplateSyntaxError) {
        throw new BadRequestException({ message: error.message, code: 'PROMPT_TEMPLATE_SYNTAX' });
      }
      throw error;
    }
  }

  /**
   * What the run would go to, and who pays. `override` is the caller's explicit `{provider,
   * model}` pair (verbatim, as the prompt bench accepts one); `row` is the agent's own bound
   * model, sent as the wire provider apps/text registers and the provider-native `wireModelId`.
   *
   * Funding is DERIVED exactly as production derives it: the SYSTEM tier paying makes it
   * `platform`, the tenant's own row makes it `tenant`. Nothing here stamps a `test` tier — a
   * bench run is ordinary spend on an ordinary credential.
   */
  private async testTarget(entity: AgentEntity, model: AiModelEntity, dto: TestAgentRequest): Promise<AgentTestAckResponse['resolved']> {
    const provider = dto.provider ?? textWireProvider(model.provider ?? '');
    // TASK-890 F9 — the ROUTED id, not the locator `sourceUri` (§3.1). The slug stays the last
    // resort for a `built-in` row that declares neither, which only a dry run ever reaches.
    const wireModel = dto.model ?? model.wireModelId ?? model.slug;
    const source: 'row' | 'override' = dto.provider ? 'override' : 'row';

    let fundingTier: 'platform' | 'tenant' = entity.tenantId === SYSTEM_TENANT_ID ? 'platform' : 'tenant';
    const connectionProvider = model.provider ?? null;
    const service = MODEL_TASK_TYPE_SERVICE[model.taskType as ModelTaskType] ?? AGENT_TASK_SERVICE[entity.task];
    if (this.providerConnections && connectionProvider && service) {
      const connection = await this.providerConnections.resolveConnection(service, connectionProvider, entity.tenantId).catch(() => null);
      if (connection) fundingTier = connection.source === 'system' ? 'platform' : 'tenant';
    }
    return { provider, model: wireModel, fundingTier, source };
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

  /**
   * TASK-890 §3.4 (OD-H / OD-M) — the REFERENCE-SET copy: land the SYSTEM agent `slug` in
   * `targetTenantId` as that tenant's OWN published agent.
   *
   * This is `clone` seen from provisioning rather than from a console: no caller ability is
   * consulted (the route above it is `@CanManage('Tenant')`, and `TenantService.create` has no
   * caller ability in a customer tenant at all), the target is named explicitly, and the copy
   * is PUBLISHED — a DRAFT reference set would leave every tenant's assignment pointing at a
   * slug that `findPublishedActiveBySlug` cannot serve, which after the flip is exactly the
   * fail-closed hole provisioning exists to prevent.
   *
   * MISSING-ONLY by lineage: a tenant that already carries the slug — cloned earlier, or
   * authored itself — keeps precisely what it has. Re-copying a pristine clone is the
   * `refresh-locked` mode of the re-sync, an explicit act, never a side effect of provisioning.
   *
   * `promptTemplateId` is the one reference REWRITTEN rather than copied: the caller resolves
   * the tenant's own clone of the bound SYSTEM template and passes it, because after step v the
   * SYSTEM row is not readable from inside the tenant and a copied id would dangle.
   */
  async cloneFromSystem(slug: string, targetTenantId: string): Promise<{ agentId: string; created: boolean; warnings: string[] }> {
    const source = await this.agentRepository.findSystemReferenceBySlug(slug, this.databaseService.baseClient);
    if (!source) {
      throw new NotFoundException(`No PUBLISHED SYSTEM agent '${slug}' to clone from.`);
    }

    return runInTenantContext(this.clsService, targetTenantId, async () => {
      const existing = await this.agentRepository.findAllVersionsBySlug(targetTenantId, slug);
      if (existing.length > 0) {
        const live = existing.find((row) => row.isActive && row.status === WorkflowDefinitionStatus.PUBLISHED);
        if (live) return { agentId: live.id, created: false, warnings: [] };

        // The lineage exists but NOTHING in it serves. That is a provisioning RESIDUE, not a
        // tenant decision: a copy that never reached PUBLISHED leaves the tenant's assignment
        // pointing at a slug `findPublishedActiveBySlug` cannot answer, which after step v is
        // `AGENT_NOT_ASSIGNED` on every call for that task. Re-align a PRISTINE copy — version 1,
        // descended from the SYSTEM source, never re-versioned by the tenant — with its source.
        //
        // Deliberately narrow. A tenant that has authored its own version, or deactivated a
        // later one, has expressed something; only an untouched v1 residue is repaired here.
        const pristine = existing.find(
          (row) => row.versionNumber === 1 && row.sourceTenantId === SYSTEM_TENANT_ID && row.sourceAgentId === source.id,
        );
        if (!pristine) {
          return { agentId: existing[0].id, created: false, warnings: [] };
        }
        pristine.status = source.status;
        pristine.isActive = source.isActive;
        pristine.compiledConfig = source.compiledConfig;
        pristine.compiledConfigChecksum = source.compiledConfigChecksum;
        pristine.validationReport = source.validationReport;
        pristine.validatedAt = source.validatedAt ?? null;
        pristine.publishedAt = pristine.publishedAt ?? new Date();
        pristine.updatedBy = this.requestUserId ?? undefined;
        const repaired = await this.agentRepository.update(pristine.id, pristine);
        return {
          agentId: repaired.id,
          created: false,
          warnings: [`the pristine copy of '${slug}' was not serving (status ${existing[0].status}); it was re-aligned with the platform source`],
        };
      }

      const instruction = await this.referenceInstruction(source, targetTenantId);
      const { saved, warnings } = await this.copyInto(source, targetTenantId, {
        slug: source.slug,
        name: source.name,
        description: source.description ?? null,
        // DROPPED, matching `seed/26-tenant-reference-set.ts` `copyAgents` (TASK-890 J7-2):
        // the platform's tags assert something about the PLATFORM's row, not a tenant's copy.
        // An agent tag is `key:value`, and the platform's values (`platform-default`, the tier
        // markers `modelAllowedForTier` reads) become false claims once they sit on a tenant row
        // the platform does not own. This used to carry `source.tags ?? []` while the seed wrote
        // `[]`, so a synced tenant and a seeded tenant ended up with different rows from the same
        // source. Prompts are the OTHER way round — their tags are content, and they travel.
        tags: [],
        ...(instruction !== undefined ? { instruction } : {}),
      });

      // The copy lands ALREADY PUBLISHED, carrying the SOURCE's compiled artifact — it does not
      // re-run `publish()`.
      //
      // Re-publishing looked more correct and is not. The publish gate asks "is this agent
      // runnable HERE?", and measured on the test stack it answers NO for the ASR and TTS
      // platform agents — `MODEL_UNAVAILABLE`, because their weights are not staged in that
      // environment. That is a fact about the ENVIRONMENT, not about the tenant, and the SYSTEM
      // agent it is a copy of is published regardless; refusing the copy would leave every
      // tenant without an ASR or TTS assignment (the gate below refuses to name a slug that does
      // not resolve) and therefore `AGENT_NOT_ASSIGNED` on its first transcription — a
      // fail-closed hole opened by the very step that exists to prevent one.
      //
      // Copying the artifact is sound for the same reason the seed phase copies it: a compiled
      // config is a FROZEN snapshot (invariant 4), its models are SYSTEM `AiModel` rows that
      // stay shared-read (OD-O), and its resolved prompt carries CONTENT rather than a
      // reference. So the copy is servable wherever the original was, and an unrunnable model
      // still fails at inference with its own named error — exactly as it does today for the
      // SYSTEM row this replaces.
      saved.status = source.status;
      saved.isActive = source.isActive;
      saved.compiledConfig = source.compiledConfig;
      saved.compiledConfigChecksum = source.compiledConfigChecksum;
      saved.validationReport = source.validationReport;
      saved.validatedAt = source.validatedAt ?? null;
      saved.publishedAt = new Date();
      saved.updatedBy = this.requestUserId ?? undefined;
      const published = await this.agentRepository.update(saved.id, saved);

      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: saved.id,
        createdAt: saved.createdAt,
        data: {
          action: 'reference-set-clone',
          slug: saved.slug,
          versionNumber: saved.versionNumber,
          status: published.status,
          sourceTenantId: source.tenantId,
          sourceAgentId: source.id,
          targetTenantId,
          warnings,
        },
      });
      return { agentId: saved.id, created: true, warnings };
    });
  }

  /**
   * The instruction a reference copy stores: the source's, with the prompt binding RE-POINTED at
   * the target tenant's own clone of that SYSTEM template (matched on `sourceTemplateId`).
   *
   * `undefined` ⇒ nothing to rewrite, so `writeCopy` copies the source's instruction verbatim:
   * the agent binds no template at all, or the tenant has no clone of the one it binds — in
   * which case the copy carries the SYSTEM id and `publish()` says so in its findings rather
   * than this method silently unbinding an instruction.
   */
  private async referenceInstruction(source: AgentEntity, targetTenantId: string): Promise<Record<string, unknown> | undefined> {
    const declared = asRecord(source.instruction);
    const boundId = declared?.[PROMPT_TEMPLATE_ID_KEY];
    if (typeof boundId !== 'string' || boundId.length === 0 || !this.promptTemplateRepository) return undefined;

    const clone = await this.promptTemplateRepository.findByTenantAndSourceTemplateId(targetTenantId, boundId);
    if (!clone) return undefined;

    const next: Record<string, unknown> = { ...declared };
    next[PROMPT_TEMPLATE_ID_KEY] = clone.id;
    // The clone's version lineage restarts at 1, so the SOURCE's pin numbers a version that does
    // not exist in the target. Carrying it would pin the agent to a missing snapshot.
    const approved = clone.approvedVersionNumber ?? null;
    if (approved === null) delete next[PROMPT_VERSION_NUMBER_KEY];
    else next[PROMPT_VERSION_NUMBER_KEY] = approved;
    return next;
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
    // TASK-890 L13 — the PLATFORM-LIBRARY branch, now an explicit reference read on the
    // unscoped client rather than the shared-read widening `findPublishedActiveBySlug` used to
    // provide. Same set as before (SYSTEM, PUBLISHED + ACTIVE), said out loud; a foreign
    // tenant's slug still resolves to nothing and leaves as one 404.
    const shared = await this.agentRepository.findSystemReferenceBySlug(slug, this.databaseService.baseClient);
    if (!shared) throw new NotFoundException('Agent not found');
    if (versionNumber !== undefined && shared.versionNumber !== versionNumber) {
      throw new NotFoundException(`Agent '${slug}' has no version ${versionNumber}`);
    }
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
    const own = await this.promptTemplateRepository.findById(templateId).catch(() => null);
    if (own) return own;
    // TASK-890 L13 — `PromptTemplate` leaves `SYSTEM_SHARED_READ_MODELS` (§1.5), so the scoped
    // read above no longer answers for a SYSTEM row. The reference library is still readable,
    // explicitly, on the unscoped client — and this is exactly the caller that needs it: the
    // portability check has to be able to SEE that a bound template is platform-owned before it
    // decides the agent is not portable. Without this, every SYSTEM template would read as
    // "missing" and every clone of a platform agent would refuse.
    return this.promptTemplateRepository.findSystemReferenceById(templateId, this.databaseService.baseClient).catch(() => null);
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
   * SYSTEM is the exception, and deliberately so — its existence is not a secret (it is the
   * platform REFERENCE SET every tenant is provisioned from, and the clone/branch pickers name
   * it out loud), so hiding it behind a 404 would conceal nothing and mislead the caller about
   * why the push failed. It is a **403** naming the real rule: only a platform administrator
   * manages the platform tier. (Before TASK-890 L13 step v this sentence said "every tenant
   * READS its templates through the shared-read cascade" — that cascade is gone for content.)
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
    overrides: { slug: string; name?: string; description?: string | null; tags?: string[]; instruction?: Record<string, unknown> | null },
  ): Promise<{ saved: AgentEntity; fallbacks: AgentModelFallbackEntity[]; warnings: string[] }> {
    if (targetTenantId !== source.tenantId) await this.assertPortableAcrossTenants(source);
    // TASK-890 H-6, the CLONE half. `AgentModelFallback` is a plain tenant-scoped model — it is
    // NOT shared-read — so reading the SOURCE's chain under the CALLER's working tenant answers
    // `[]` for every SYSTEM template, and the copy silently lands with no fallbacks at all. Name
    // the tenant each step acts on, exactly as `syncToTenants` does (`:654`); the runtime half of
    // the same defect was fixed in `AgentResolverService`.
    const sourceFallbacks = await runInTenantContext(this.clsService, source.tenantId, () => this.fallbackRepository.findByAgentId(source.id));
    return this.databaseService.baseClient.$transaction(async (tx) => this.writeCopy(source, targetTenantId, overrides, tx, sourceFallbacks));
  }

  private async writeCopy(
    source: AgentEntity,
    targetTenantId: string,
    /**
     * `instruction`, when present, REPLACES the source's — the reference-set copy uses it to
     * re-point a platform agent's prompt binding at the TARGET tenant's own clone of that
     * template (§3.4: references are rewritten to the tenant's clones, never left pointing at
     * SYSTEM). Absent ⇒ the source's instruction is copied as it always was.
     */
    overrides: { slug: string; name?: string; description?: string | null; tags?: string[]; instruction?: Record<string, unknown> | null },
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

    const overridden = overrides.instruction !== undefined;
    const instruction = { ...(overridden ? (overrides.instruction ?? {}) : (asRecord(source.instruction) ?? {})) };
    const hadInstruction = overridden ? overrides.instruction !== null : asRecord(source.instruction) !== undefined;
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
      // The context pin travels only WITHIN a tenant: a schema is cloned, not shared, so a
      // cross-tenant copy would otherwise point at a row the target cannot read. Re-binding it
      // to the target's own clone is the reference-set's job (L13), not the copier's.
      contextSchemaId: crossTenant ? null : (source.contextSchemaId ?? null),
      contextSchemaVersionNumber: crossTenant ? null : (source.contextSchemaVersionNumber ?? null),
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
    contextSchema: AgentCompiledContextSchema | null;
  }> {
    const findings: AgentFinding[] = [];
    const context = await this.resolveContextSchema(entity);
    findings.push(...context.findings);
    findings.push(...this.guardrailFindings(entity));
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

    // ONE readiness read per validate/publish, shared by the primary model and every fallback:
    // it is a single stored snapshot, and re-reading it per row would say the same thing N times.
    const snapshot = this.readiness ? await this.readiness.getSnapshot().catch(() => null) : null;
    if (model) findings.push(...(await this.availabilityFindings(model, entity.task, entity.tenantId, 'modelId', snapshot)));
    for (const [index, fallback] of fallbackModels.entries()) {
      findings.push(...(await this.availabilityFindings(fallback, entity.task, entity.tenantId, `fallbacks[${index}]`, snapshot)));
    }

    let resolvedPrompt: ResolvedPrompt = null;
    if (entity.task === AgentTask.TEXT_GENERATION) {
      const outcome = await this.resolvePrompt(asRecord(entity.instruction));
      findings.push(...outcome.findings);
      resolvedPrompt = outcome.resolvedPrompt;
      findings.push(...this.promptTemplateFindings(entity, resolvedPrompt, context.resolved));
    }

    const report: AgentValidationReport = { checkedAt: new Date().toISOString(), blocking: hasBlocking(findings), findings };
    return { report, model, fallbackModels, resolvedPrompt, contextSchema: context.resolved };
  }

  /**
   * TASK-890 §3.4 — resolve the agent's context-schema PIN, in the CALLER's tenant only.
   *
   * A schema is CONTENT: it is cloned into a tenant and never shared from SYSTEM (OD-H, §1.5), so
   * `resolveReference` answers 404-shaped for a SYSTEM id exactly as it does for another
   * customer's. That is why an unresolvable pin is a FINDING rather than a throw — the code has
   * to distinguish "no such schema here" from "that version does not exist", and the console
   * offers a different fix for each.
   *
   * The resolved payload schema is FROZEN into `compiledConfig.contextSchema` by `compile()`. The
   * runtime never re-reads the row (TASK-859 invariant 4): a schema published after this agent
   * was must not retroactively change what a live invocation is validated against.
   */
  private async resolveContextSchema(entity: AgentEntity): Promise<{ resolved: AgentCompiledContextSchema | null; findings: AgentFinding[] }> {
    const schemaId = entity.contextSchemaId ?? null;
    if (!schemaId) return { resolved: null, findings: [] };

    if (!this.contextSchemas) {
      // Fail CLOSED: an agent that PINS a schema and cannot have it resolved would otherwise
      // publish with no frozen snapshot, and its invocations would validate against nothing.
      return {
        resolved: null,
        findings: [
          {
            severity: 'ERROR',
            code: 'CONTEXT_SCHEMA_NOT_FOUND',
            path: 'contextSchemaId',
            message: 'Context schemas are not available to this service instance, so the pinned schema cannot be resolved.',
          },
        ],
      };
    }

    let outcome: ContextSchemaReferenceResolution;
    try {
      outcome = await this.contextSchemas.resolveReference(schemaId, entity.contextSchemaVersionNumber ?? null);
    } catch {
      outcome = { outcome: 'failed', failure: 'CONTEXT_SCHEMA_NOT_FOUND' };
    }

    if (outcome.outcome === 'failed') {
      return {
        resolved: null,
        findings: [
          {
            severity: 'ERROR',
            code: outcome.failure,
            path: outcome.failure === 'CONTEXT_SCHEMA_VERSION_NOT_FOUND' ? 'contextSchemaVersionNumber' : 'contextSchemaId',
            message:
              outcome.failure === 'CONTEXT_SCHEMA_VERSION_NOT_FOUND'
                ? `Context schema ${schemaId} has no version ${entity.contextSchemaVersionNumber ?? '(pinned)'} in this tenant.`
                : `Context schema ${schemaId} is not visible to this tenant. A schema is cloned into a tenant, never shared from the platform tier.`,
          },
        ],
      };
    }

    return {
      resolved: {
        schemaId: outcome.schemaId,
        versionNumber: outcome.versionNumber,
        versionId: outcome.versionId,
        payloadSchema: outcome.payloadSchema,
      },
      findings: [],
    };
  }

  /**
   * TASK-890 §3.14 (OD-R) — an agent that opts OUT of platform guardrail says so on its own row.
   *
   * A WARNING, never a block. The point is attribution: the omission is recorded at authoring
   * time (here), on every call (`attributesJson.guardrail`) and in TEXT's own response reason, so
   * "this agent was not screened" is a fact somebody can find rather than a silence.
   */
  private guardrailFindings(entity: AgentEntity): AgentFinding[] {
    if (guardrailEnabledOf(entity.parameters)) return [];
    return [
      {
        severity: 'WARNING',
        code: 'GUARDRAIL_OPTED_OUT',
        path: 'parameters.guards.enabled',
        message:
          'This agent opts OUT of platform guardrail screening: its input and output are not screened, and every call records `guardrail: opted_out`.',
      },
    ];
  }

  /**
   * TASK-890 §3.5 — what `publishFindings` needs to know about the agents a graph's `core.agent`
   * nodes reference, by slug. The workflow publish gate is a PURE function in a package with no
   * database, so the per-agent facts have to be resolved by a service and handed in; this is that
   * resolution, and it is public for exactly one caller.
   *
   * Resolution is the published, active row visible to the caller (the same row the runtime would
   * resolve), and an unknown slug is simply ABSENT from the map — `publishFindings` already emits
   * `AGENT_REF_MISSING` for a node whose agent it was told nothing about, and inventing an empty
   * view here would mask that with a variable finding instead.
   */
  async publishAgentViews(slugs: readonly string[]): Promise<Record<string, AgentPublishView>> {
    const tenantId = this.requireTenant();
    const views: Record<string, AgentPublishView> = {};
    for (const slug of new Set(slugs)) {
      const entity = await this.agentRepository.findPublishedActiveBySlug(tenantId, slug).catch(() => null);
      if (!entity) continue;
      const context = await this.resolveContextSchema(entity);
      views[slug] = {
        declaredVariables: Object.keys(asRecord(asRecord(entity.instruction)?.variables) ?? {}),
        contextPayloadSchema: context.resolved?.payloadSchema ?? null,
      };
    }
    return views;
  }

  /**
   * TASK-890 §3.5 — the resolved prompt is a TEMPLATE, so publish checks it like one.
   *
   * Nothing looked at prompt CONTENT before this ticket: an agent could publish with a prompt no
   * renderer could parse, and the failure surfaced mid-consultation rather than at authoring
   * time. Two checks, two severities, and the split is the whole point:
   *
   * - `PROMPT_TEMPLATE_SYNTAX` is an ERROR. A template that cannot PARSE can never render, on
   *   any lane, for any caller.
   * - `PROMPT_VARIABLE_UNDECLARED` rides the OD-C ramp (WARNING in release 1). A reference to a
   *   variable nobody declared MIGHT still resolve — the invocation can pass it — and no agent
   *   binds a context schema yet (gap 4e), so enforcing it today would be a migration wearing a
   *   gate's clothes.
   *
   * `declared` is built from what an agent HAS today: `input.*` from its own `inputSchema`, bare
   * names from `instruction.variables`. `context.*` / `trigger.*` arrive when the agent binds a
   * context schema (L8 resolves the row and freezes the derived payload schema); until then a
   * reference to them is legitimately undeclared, which is exactly what the WARNING says.
   */
  private promptTemplateFindings(
    entity: AgentEntity,
    resolvedPrompt: ResolvedPrompt,
    contextSchema: AgentCompiledContextSchema | null,
  ): AgentFinding[] {
    const content = resolvedPrompt?.content;
    if (typeof content !== 'string' || content.length === 0) return [];

    const templateRef =
      resolvedPrompt?.source === 'template'
        ? `prompt template ${resolvedPrompt.promptTemplateId} v${resolvedPrompt.promptVersionNumber}`
        : 'instruction.systemPrompt';

    const syntax = templateSyntaxProblems(content);
    if (syntax.length > 0) {
      // A template that does not parse has no meaningful references to cross-check.
      return syntax.map((problem) => ({
        severity: 'ERROR' as const,
        code: 'PROMPT_TEMPLATE_SYNTAX' as const,
        path: 'instruction',
        message: `${templateRef}: ${problem}`,
      }));
    }

    const instruction = asRecord(entity.instruction) ?? {};
    const variables = asRecord(instruction.variables) ?? {};
    const contextPayloadSchema = this.boundContextPayloadSchema(contextSchema);
    // J3-5 — `context.*` resolves against what a RENDER will actually see. Under the single-kind
    // rule (one kind whose key IS the namespace root) the render scope binds the kind's own
    // object, so the gate must check the kind's fields; checking the envelope reported the
    // seeded `{{context.safe_age}}` as undeclared and would have accepted only the one spelling
    // that cannot render. `trigger` keeps the envelope: on a workflow lane that root IS the
    // validated run payload, and the two roots being different is the honest answer.
    const contextRootSchema = contextPayloadSchema === null ? null : (soleContextKindSchema(contextPayloadSchema) ?? contextPayloadSchema);
    const declared: DeclaredNamespaces = {
      roots: {
        ...(contextPayloadSchema === null ? {} : { context: contextRootSchema, trigger: contextPayloadSchema }),
        input: asRecord(entity.inputSchema) ?? null,
      },
      variables: Object.keys(variables),
    };

    return templateReferenceProblems(content, declared).map((problem) => ({
      severity: TEMPLATE_REFERENCE_SEVERITY_RELEASE_1,
      code: 'PROMPT_VARIABLE_UNDECLARED' as const,
      path: 'instruction',
      message: `${templateRef}: ${problem}`,
    }));
  }

  /**
   * The derived payload schema of the agent's bound context schema, or `null` when it binds none.
   *
   * TASK-890 L8 — filled. It is the resolution `collectFindings` already made (one read per
   * validate/publish, not one per finding), projected onto the `context.*` / `trigger.*` roots
   * of §3.3. `null` means the agent pins no schema OR the pin did not resolve — in the second
   * case an ERROR finding is already blocking, so the WARNING-level "undeclared variable" check
   * running against an empty namespace cannot mislead anyone.
   */
  private boundContextPayloadSchema(contextSchema: AgentCompiledContextSchema | null): Record<string, unknown> | null {
    return contextSchema?.payloadSchema ?? null;
  }

  /**
   * The object a `{{context.*}}` reference resolves against, given the supplied payload (J3-5).
   *
   * Mirrors `AgentInvocationService.contextScopeFor` and the durable lane's `_prompt_scope`: one
   * unwrap covers both call shapes, so a prompt an author tests here renders identically on the
   * invocation route, the realtime lane and the Temporal lane.
   */
  private contextRenderScope(context: Record<string, unknown>, contextSchema: AgentCompiledContextSchema | null): Record<string, unknown> {
    const payloadSchema = this.boundContextPayloadSchema(contextSchema);
    if (payloadSchema === null) return context;
    const unwrapped = unwrapSingleKindContextPayload(payloadSchema, context);
    return unwrapped !== null && typeof unwrapped === 'object' && !Array.isArray(unwrapped) ? (unwrapped as Record<string, unknown>) : context;
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
      // TASK-891 C1 (OD-4) — `generation.reasoning`, refused with a message that NAMES the
      // four efforts. The schema gate above refuses the same values and says only "matches
      // none of the `enum`", which is a puzzle rather than a refusal for someone who wrote
      // `effort: "max"`.
      for (const problem of agentReasoningProblems(parameters)) {
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
   * TASK-890 §3.7 / §3.11 / §3.12 — the publish gate, on the SAME provider-class table the
   * tenant catalogue answers from, plus advisory readiness.
   *
   * ## Two axes, deliberately not one
   *
   * `usable` (this ERROR) asks *could an agent bound to this row ever run?* — a class fact about
   * the row and its connection. `readiness` (the WARNING) asks *would it have run at the last
   * moment anybody looked?* — an observation with a timestamp. An engine that is down while an
   * author publishes may be up when the graph runs tomorrow, so readiness must never refuse a
   * publish; that is what the RUN-time 503 is for. Collapsing them would make a transient probe
   * failure permanently unpublishable.
   *
   * ## The class table (`providerClassOf`, `ai-provider-connection/constants.ts`)
   *
   * | Class | usable when |
   * |---|---|
   * | `platform-self-host` | EITHER measurement finds the weights: the bucket inventory says AVAILABLE / NOT_APPLICABLE, **or** the readiness sweep says `ready` |
   * | `engine-served` | the SYSTEM engine connection resolves (ENABLED). There is no credential to bring, so ENABLED is the whole test — but it IS a test: a disabled engine row is a deliberate platform veto |
   * | `cloud-byo` | the tenant's own connection is ENABLED **and carries key material** — the "resolves but never delivers" split |
   * | `cloud-platform` | the cascade resolved a KEYED connection (tenant row wins, SYSTEM on absence, `null` on veto or a withheld platform-credential entitlement) |
   *
   * A row whose provider this platform cannot classify at all (`null`) is refused rather than
   * assumed usable — the seeds carry rows with no provider, and guessing for them is how an
   * agent reaches production bound to something nothing serves.
   *
   * Service comes from the MODEL's own task type (`MODEL_TASK_TYPE_SERVICE`) and falls back to
   * the AGENT's task: a fallback chain may legitimately hold a row whose task type maps to no
   * connection plane, and the agent's own service is the honest answer there.
   */
  private async availabilityFindings(
    model: AiModelEntity,
    task: AgentTask,
    tenantId: string,
    path: string,
    snapshot: InferenceReadinessSnapshot | null,
  ): Promise<AgentFinding[]> {
    if (model.resourceStatus !== ResourceStatusType.ENABLED) {
      return [{ severity: 'ERROR', code: 'MODEL_DISABLED', path, message: `Model \`${model.slug}\` is ${model.resourceStatus}.` }];
    }

    const service: ProviderService | null = MODEL_TASK_TYPE_SERVICE[model.taskType as ModelTaskType] ?? AGENT_TASK_SERVICE[task];
    const providerClass = providerClassOf(service, model.provider ?? null, model);
    // The SAME readiness verdict feeds both axes: it can only ever ADD a way for a self-hosted
    // row to be usable (below), and it is the sole input to the advisory WARNING.
    const readiness = snapshot ? modelReadinessFrom(snapshot, model.id).readiness : 'unknown';
    const unusable = await this.unusableReason(providerClass, service, model, tenantId, readiness);
    if (unusable) {
      return [{ severity: 'ERROR', code: 'MODEL_UNAVAILABLE', path, message: `Model \`${model.slug}\`: ${unusable}` }];
    }
    return this.readinessFindings(model, path, snapshot);
  }

  /** `null` = usable. A string = the reason it is not, in the author's words. */
  private async unusableReason(
    providerClass: ProviderClass | null,
    service: ProviderService | null,
    model: AiModelEntity,
    tenantId: string,
    readiness: ModelReadiness,
  ): Promise<string | null> {
    if (providerClass === null) {
      return `its provider \`${model.provider ?? '(none)'}\` is not one this platform serves, so nothing would run it.`;
    }

    if (providerClass === 'platform-self-host') {
      // TWO measurements, either one sufficient — the SAME rule the tenant catalogue answers
      // from (`AiModelService.usabilityOf`: `bucketHasIt || readiness === 'ready'`). They are not
      // redundant, they look in different places: `availability` is the MinIO bucket inventory,
      // and `readiness` is the serving service answering about its own filesystem. Most of the
      // self-hosted catalogue is resolved out of the HuggingFace cache and never staged in the
      // bucket, so reading `availability` alone made the gate refuse rows the catalogue was
      // simultaneously offering as usable — no tenant could publish an ASR agent at all.
      //
      // `unknown` stays a refusal: nobody looked is not "probably fine". And readiness only ever
      // ADDS usability here — it never subtracts, because a row the bucket HAS stays publishable
      // through a transient engine outage (that outage is the advisory WARNING below, and the
      // 503 at run time).
      const bucketHasIt = model.availability === AiModelAvailability.AVAILABLE || model.availability === AiModelAvailability.NOT_APPLICABLE;
      if (bucketHasIt || readiness === 'ready') return null;
      return (
        `it has no staged weights (availability is ${model.availability}) and the last readiness check ` +
        `${readiness === 'unknown' ? 'never measured it' : `reported \`${readiness}\``}; ` +
        'publish is refused until the weights are available.'
      );
    }

    // TASK-890 §3.1 (L10) — a routed row must name what goes ON THE WIRE.
    //
    // Routing was re-pointed off the locator `sourceUri` onto `wireModelId`, and
    // `toTextCandidate` now DROPS a candidate that declares none — so a `cloud-*` /
    // `engine-served` row without one resolves no candidate at all and the agent fails at RUN
    // time with "no usable candidate", which names neither the row nor the missing column. The
    // gate says it at publish instead.
    //
    // `platform-self-host` is deliberately exempt: `wireModelId` is conditionally NOT NULL for
    // CLOUD only, and the seeded self-hosted catalogue legitimately leaves it null for rows a
    // HOPE service loads by path (measured on dev: 23 such rows, none of them bound to a
    // TEXT_GENERATION agent). Refusing them here would refuse publishes that work.
    if (!model.wireModelId?.trim()) {
      return `it declares no wire model id, so routing has nothing to send as the model name for \`${model.provider ?? '(none)'}\`.`;
    }

    // Every remaining class needs the connection plane. An absent collaborator FAILS CLOSED with
    // a named cause — an optimistic pass here is how an agent publishes onto a credential nobody
    // ever configured.
    const provider = model.provider ?? null;
    if (!this.providerConnections || !service || !provider) {
      return 'its provider connection could not be resolved by this service instance.';
    }

    if (providerClass === 'cloud-byo') {
      const row = this.providerConnections.findRow ? await this.providerConnections.findRow(service, provider, tenantId).catch(() => null) : null;
      if (!row || !row.enabled) {
        return `it is a bring-your-own \`${provider}\` model and this tenant has no ENABLED ${service}/${provider} connection.`;
      }
      if (!hasKeyMaterial(row.encryptedApiKey)) {
        return `it is a bring-your-own \`${provider}\` model and this tenant's ${service}/${provider} connection carries no credential.`;
      }
      return null;
    }

    const connection = await this.providerConnections.resolveConnection(service, provider, tenantId).catch(() => null);
    if (!connection) {
      return `it is served by \`${provider}\` and no enabled ${service}/${provider} provider connection exists at the tenant or platform tier.`;
    }
    if (providerClass === 'cloud-platform' && !hasKeyMaterial(connection.encryptedApiKey)) {
      return `it is served by the cloud provider \`${provider}\` and the resolved ${service}/${provider} connection carries no credential.`;
    }
    // `engine-served`: ENABLED is the whole test — an engine the platform runs brings its own
    // weights and needs no key (`ENGINE_SERVED_PROVIDERS`).
    return null;
  }

  /**
   * §3.12 — ADVISORY. The platform's LAST observation of this model, never a probe: a tenant
   * publishing an agent must not be able to make the gateway call an engine.
   *
   * `unknown` is not a verdict and never produces a finding (cold snapshot, sweep switched off,
   * inventory never ran). `ready` / `loadable` / `credential_missing` say nothing new here —
   * a missing credential is already the ERROR above, and `loadable` only means the first call
   * pays a model load.
   */
  private readinessFindings(model: AiModelEntity, path: string, snapshot: InferenceReadinessSnapshot | null): AgentFinding[] {
    if (!snapshot) return [];
    const verdict = modelReadinessFrom(snapshot, model.id);
    if (verdict.readiness !== 'engine_down' && verdict.readiness !== 'weights_missing') return [];
    return [
      {
        severity: 'WARNING',
        code: 'MODEL_NOT_READY',
        path,
        message:
          `Model \`${model.slug}\` was ${verdict.readiness === 'engine_down' ? 'not answering' : 'missing its weights'} at the last readiness check` +
          `${verdict.checkedAt ? ` (${verdict.checkedAt.toISOString()})` : ''}${verdict.detail ? `: ${verdict.detail}` : ''}. ` +
          'Publishing is allowed — readiness is measured at a moment, not at run time.',
      },
    ];
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

  /**
   * TASK-890 — `compile()` FREEZES two more facts, and freezing is the point (invariant 4: the
   * runtime never re-reads what publish decided).
   *
   * `contextSchema` carries the derived payload schema of the version the agent pinned, so an
   * invocation is validated against the declaration that was in force when the agent was
   * published — a schema published later must not retroactively invalidate a live call, and an
   * earlier one must not silently keep applying.
   *
   * `guardrail` carries the agent's own opt-out decision, so the resolver and every TEXT post can
   * read it without a second lookup and the usage row can attribute it.
   */
  private compile(
    entity: AgentEntity,
    model: AiModelEntity,
    fallbackModels: AiModelEntity[],
    fallbackRows: AgentModelFallbackEntity[],
    resolvedPrompt: ResolvedPrompt,
    contextSchema: AgentCompiledContextSchema | null,
  ): AgentCompiledConfig {
    const byId = new Map(fallbackModels.map((row) => [row.id, row]));
    const defaults = AGENT_IO_DEFAULTS[entity.task];
    // Built as a variable so the additive `wireModelId` rides along: `AgentCompiledConfig['model']`
    // in `@arcaai/types` declares the four required members and the artifact is JSON.
    const compiledModel: CompiledModelRef = {
      id: model.id,
      slug: model.slug,
      provider: model.provider ?? null,
      taskType: String(model.taskType),
      wireModelId: model.wireModelId ?? null,
    };
    return {
      task: entity.task,
      service: AGENT_TASK_SERVICE[entity.task],
      // TASK-890 F9 — the ROUTED id (`AiModel.wireModelId`) is FROZEN beside the reference, so a
      // published version names what goes on the wire without a second catalogue read, exactly as
      // `resolvedPrompt` freezes the instruction. A version published before this carries none and
      // routes off the live row instead (`wireModelIdOf`) — there is no republish.
      model: compiledModel,
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
      contextSchema,
      guardrail: { enabled: guardrailEnabledOf(entity.parameters) },
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
    source: {
      instruction?: unknown;
      parameters?: unknown;
      inputSchema?: unknown;
      outputSchema?: unknown;
      tools?: unknown;
      contextSchemaId?: string | null;
      contextSchemaVersionNumber?: number | null;
    },
  ): AgentConfigView {
    return {
      task,
      // TASK-890 §3.4 — the contract owns "half a reference is not a reference" (a pinned
      // version with no schema id). It can only enforce it if the view CARRIES the pair.
      contextSchemaId: source.contextSchemaId ?? null,
      contextSchemaVersionNumber: source.contextSchemaVersionNumber ?? null,
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
