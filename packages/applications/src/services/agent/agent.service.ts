import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
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
  ModelTaskType,
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
  canonicalJson,
  type AgentConfigView,
  type AgentModelView,
  type AgentProviderCapabilities,
} from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type { IProviderConnectionService as IProviderConnectionServicePort } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { AgentDtoMapper } from './agent.dto.mapper';
import { codeForConfigProblem, hasBlocking, type AgentFinding, type AgentValidationReport } from './agent-findings';
import { AgentResponse, AgentSummaryResponse, CreateAgentRequest, NewAgentVersionRequest, PublishAgentRequest, UpdateAgentRequest } from './dto';
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

  private async writeFallbacks(agent: AgentEntity, models: readonly AiModelEntity[], tx: unknown): Promise<void> {
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
