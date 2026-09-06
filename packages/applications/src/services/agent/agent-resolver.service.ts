import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import {
  AgentEntity,
  AgentModelFallbackRepository,
  AgentRepository,
  AgentTask,
  AiModelEntity,
  AiModelRepository,
  SYSTEM_TENANT_ID,
} from '@arcaai/domains';
import type { AgentCompiledConfig, ResolvedAgent, ResolvedAgentModel, ResolvedAgentModelRole } from '@arcaai/types';
import type { IActiveUserContext } from '../../interfaces';
import { AGENT_TASK_SERVICE } from '@arcaai/workflow-contract';
import { IAgentAssignmentService } from '../agent-assignment/IAgentAssignmentService';
import type { IAgentAssignmentService as IAgentAssignmentServicePort } from '../agent-assignment/IAgentAssignmentService';
import { IProviderConnectionService } from '../ai-provider-connection/IProviderConnectionService';
import type { IProviderConnectionService as IProviderConnectionServicePort } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { derivedLocalPath } from '../ai-model/constants';
import { runInTenantContext } from '../agentPromotion/tenant-context';

export interface ResolveAgentInput {
  tenantId: string;
  task?: AgentTask;
  agentSlug?: string | null;
  departmentId?: string | null;
}

/** Where the ASR spec references auxiliary registry models (TASK-861 §3.2). */
const ASR_AUX_MODEL_PATHS: ReadonlyArray<{ role: ResolvedAgentModelRole; path: readonly string[] }> = [
  { role: 'vad', path: ['audioFrontEnd', 'vad', 'modelSlug'] },
  { role: 'denoise', path: ['audioFrontEnd', 'denoise', 'modelSlug'] },
  { role: 'embedding', path: ['audioFrontEnd', 'diarization', 'embeddingModelSlug'] },
  { role: 'punctuation', path: ['postProcessing', 'punctuation', 'modelSlug'] },
  // TASK-880 H-4 — the end-of-utterance model TASK-877 gave a role and a schema property, but no resolver path.
  { role: 'endpointing', path: ['streaming', 'semantic', 'modelSlug'] },
];

function dig(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * TASK-890 §3.14 (OD-R) — the AGENT tier of the guardrail precedence, normalised.
 *
 * `compiledConfig.guardrail` is additive-optional (every artifact published before this ticket
 * has none) and the runtime needs an ANSWER, not a maybe. Absence is INHERIT and the bottom of
 * the chain is screening ON, so absence resolves to `true`.
 *
 * A non-boolean is treated identically to absence, deliberately: publish closes the `guards`
 * object so a malformed value should be unreachable, and if one is reached anyway the call is
 * SCREENED. The failure direction on a safety gate is never "off".
 */
function guardrailOf(compiled: AgentCompiledConfig): { enabled: boolean } {
  const declared = (compiled as { guardrail?: { enabled?: unknown } }).guardrail?.enabled;
  return { enabled: typeof declared === 'boolean' ? declared : true };
}

/**
 * ONE resolution for two callers (TASK-863 §3.4): the gateway (standalone invocation, STT
 * sessions — TASK-861) and the harness `core.agent` activity (TASK-864, over
 * `GET /internal/agents/resolve`).
 *
 *  1. explicit slug → the ACTIVE PUBLISHED version visible to the tenant ([tenant, SYSTEM]);
 *     foreign / unknown / unpublished → one 404;
 *  2. else the assignment cascade `department → tenant → SYSTEM`;
 *  3. materialise: `compiledConfig` + every model row the runtime needs (primary, fallbacks,
 *     ASR auxiliaries) + the provider credential override for a cloud provider, funding tier
 *     derived from the tier that supplied the row.
 */
@Injectable()
export class AgentResolverService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly fallbackRepository: AgentModelFallbackRepository,
    private readonly aiModelRepository: AiModelRepository,
    @Inject(IAgentAssignmentService) private readonly assignments: IAgentAssignmentServicePort,
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionServicePort,
    // TASK-890 H-6 — the fallback chain of a SYSTEM agent is read under the
    // AGENT's tenant, not the caller's (see `materialiseModels`). `@Optional()`
    // and trailing so the positional unit fixtures keep their arity; production
    // DI always supplies it.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
  ) {}

  async resolve(input: ResolveAgentInput): Promise<ResolvedAgent> {
    const { tenantId } = input;
    let entity: AgentEntity | null;
    let source: ResolvedAgent['source'];

    if (input.agentSlug) {
      entity = await this.agentRepository.findPublishedActiveBySlug(tenantId, input.agentSlug);
      if (!entity) throw new NotFoundException('Agent not found');
      if (input.task && entity.task !== input.task) {
        throw new BadRequestException(`Agent '${input.agentSlug}' is a ${entity.task} agent; this call needs ${input.task}.`);
      }
      source = 'explicit';
    } else {
      if (!input.task) throw new BadRequestException('Either agentSlug or task is required.');
      const assigned = await this.assignments.resolve(tenantId, input.task, input.departmentId ?? null);
      if (!assigned.agentSlug) throw new NotFoundException(`No published ${input.task} agent is assigned for this tenant.`);
      entity = await this.agentRepository.findPublishedActiveBySlug(tenantId, assigned.agentSlug);
      if (!entity) throw new NotFoundException('Agent not found');
      source = assigned.source;
    }

    const compiledConfig = entity.compiledConfig as unknown as AgentCompiledConfig | null;
    if (!compiledConfig || typeof compiledConfig !== 'object') {
      throw new ConflictException(`Agent '${entity.slug}' v${entity.versionNumber} is published without a compiledConfig; republish it.`);
    }

    const models = await this.materialiseModels(entity, compiledConfig, tenantId);
    const override = await this.providerOverrideFor(compiledConfig, tenantId);

    return {
      agentId: entity.id,
      agentVersionId: entity.id,
      slug: entity.slug,
      versionNumber: entity.versionNumber,
      task: entity.task,
      tenantId: entity.tenantId,
      source,
      compiledConfig,
      models,
      guardrail: guardrailOf(compiledConfig),
      ...(override ? { providerOverride: override.entry, fundingTier: override.fundingTier } : {}),
    };
  }

  private async materialiseModels(entity: AgentEntity, compiled: AgentCompiledConfig, tenantId: string): Promise<ResolvedAgentModel[]> {
    const out: ResolvedAgentModel[] = [];
    const primary = (await this.modelById(compiled.model.id, tenantId)) ?? (await this.modelBySlug(compiled.model.slug, tenantId));
    if (!primary)
      throw new ConflictException(`Agent '${entity.slug}' binds model '${compiled.model.slug}', which is no longer visible to this tenant.`);
    out.push(toResolvedModel(primary, 'primary'));

    // TASK-890 H-6. `AgentModelFallback` is tenant-scoped and NOT shared-read, so
    // this read under the CALLER's tenant returns `[]` for a SYSTEM agent — a
    // silently fallback-less resolve rather than an error. The fix is CONTEXT,
    // not a widening of the shared-read set: the chain belongs to the agent, so
    // it is read standing in the agent's own tenant, exactly as the
    // membership-bounded sync does. The wrap inherits the CLS store (user,
    // correlation id) and restores the caller's tenant on return.
    const fallbacks = await this.inAgentTenant(entity.tenantId, () => this.fallbackRepository.findByAgentId(entity.id));
    for (const link of fallbacks.filter((row) => row.enabled).sort((a, b) => a.priority - b.priority)) {
      const model = await this.modelById(link.modelId, tenantId);
      if (model) out.push({ ...toResolvedModel(model, 'fallback'), priority: link.priority });
    }

    if (entity.task === AgentTask.SPEECH_TO_TEXT) {
      for (const aux of ASR_AUX_MODEL_PATHS) {
        const slug = dig(compiled.parameters, aux.path);
        if (typeof slug !== 'string' || slug.length === 0) continue;
        const model = await this.modelBySlug(slug, tenantId);
        if (!model)
          throw new ConflictException(`Agent '${entity.slug}' references ${aux.role} model '${slug}', which is not visible to this tenant.`);
        out.push(toResolvedModel(model, aux.role));
      }
    }
    return out;
  }

  /**
   * Run one read under the AGENT's tenant. Without a CLS service (positional
   * unit fixtures) the read happens as before — the wrap is the only behaviour
   * this adds, and it can only ever widen what a SYSTEM agent sees of its OWN
   * rows.
   */
  private inAgentTenant<T>(agentTenantId: string, work: () => Promise<T>): Promise<T> {
    if (!this.clsService) return work();
    return runInTenantContext(this.clsService, agentTenantId, work);
  }

  /**
   * TODO(TASK-862): ProviderCredentialResolver.resolve(service, provider, tenantId) →
   * { override, fundingTier, connectionId }. Today: the existing per-service override map.
   */
  private async providerOverrideFor(
    compiled: AgentCompiledConfig,
    tenantId: string,
  ): Promise<{ entry: ResolvedAgent['providerOverride']; fundingTier: ResolvedAgent['fundingTier'] } | null> {
    const provider = compiled.model.provider;
    const service = AGENT_TASK_SERVICE[compiled.task];
    if (!provider || !this.providerConnections || !isCloudByoProvider(service, provider)) return null;
    const resolved = await this.providerConnections.resolveTenantCloudOverrides(service, tenantId);
    const entry = resolved.overrides[provider];
    if (!entry) return null;
    return { entry: { provider, ...entry }, fundingTier: entry.funding };
  }

  private async modelById(id: string, tenantId: string): Promise<AiModelEntity | null> {
    const model = await this.aiModelRepository.findById(id).catch(() => null);
    return model && (model.tenantId === tenantId || model.tenantId === SYSTEM_TENANT_ID) ? model : null;
  }

  private async modelBySlug(slug: string, tenantId: string): Promise<AiModelEntity | null> {
    const own = tenantId === SYSTEM_TENANT_ID ? null : await this.aiModelRepository.findBySlug(tenantId, slug).catch(() => null);
    if (own) return own;
    return this.aiModelRepository.findBySlug(SYSTEM_TENANT_ID, slug).catch(() => null);
  }
}

function toResolvedModel(model: AiModelEntity, role: ResolvedAgentModelRole): ResolvedAgentModel {
  return {
    role,
    slug: model.slug,
    sourceUri: model.sourceUri,
    sourceRevision: model.sourceRevision ?? null,
    // TASK-890 §3.11 — DERIVED from the bucket identity, never the column L2
    // drops. The wire value is unchanged; only its source is.
    localPath: derivedLocalPath(model),
    // TASK-890 §3.1 — the ROUTED vendor id, beside the locator `sourceUri`.
    wireModelId: model.wireModelId ?? null,
    checksum: model.checksum ?? null,
    format: String(model.format),
    computeType: model.computeType ?? null,
    provider: model.provider ?? null,
    tenantId: model.tenantId,
    // TASK-880 H-4 — the runtime-relevant slice of `AiModel._metadata`: ASR decode geometry (which
    // replaced `stt.whisperCpp.maxAudioSeconds` / `stt.streaming.partialWindowS`) and the
    // speaker-embedding width the ASR spec builder validates. `buildResolvedAsrSpec` reads only the
    // declared members; everything else in `_metadata` belongs to other planes.
    ...(model.metaData ? { metaData: model.metaData as ResolvedAgentModel['metaData'] } : {}),
  };
}
