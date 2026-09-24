import { Injectable, Optional } from '@nestjs/common';
import {
  AgentRepository,
  AgentTask,
  AiModelRepository,
  ModelTaskType,
  ResourceStatusType,
  SYSTEM_TENANT_ID,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import { derivedLocalPath } from '../ai-model/constants';
import { AsrAgentResolverService } from '../stt/agent-resolver/asr-agent-resolver.service';
import { ImplicitLivePathReader } from './implicit-live-path';

/**
 * TASK-1005 — the `load_spec` a residency agent needs to load a model it does
 * not yet hold (`tests/contracts/model-residency-agent.fixture.json` →
 * `loadSpecExamples`). The agents keep no catalogue, so the gateway supplies
 * it; an EMPTY spec is valid only for a model already resident.
 *
 * stt — `{resolved_spec: <ResolvedAsrSpec>}`, built by the ONE producer of that
 * contract (`AsrAgentResolverService` → `buildResolvedAsrSpec`), for an ACTIVE
 * PUBLISHED speech-to-text agent whose primary model IS `modelRef`: first an
 * agent already on the implicit live path, else any tenant's agent naming that
 * model. The agent refuses a spec whose primary slug is not `modelRef`, and so
 * does this builder, before sending it.
 *
 * nlp — `{cache, model_path}`: the cache the model was last seen in (from the
 * agent's own report), else the one its catalogue `taskType` implies
 * (token → `nlp_token_classifier`, text → `nlp_text_classifier`), with
 * `model_path` = the row's derived local path. The medical suggester and the
 * groundedness scorer need a second model / a calibration the gateway cannot
 * derive from one row, so they are loadable only when nlp names the slot.
 */

export class ResidencyLoadSpecError extends Error {
  constructor(
    readonly code: 'MODEL_UNKNOWN' | 'LOAD_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ResidencyLoadSpecError';
  }
}

/** nlp caches whose slot needs nothing beyond `{cache, model_path}`. */
const SIMPLE_NLP_CACHES = new Set(['nlp_token_classifier', 'nlp_text_classifier', 'nlp_gliner2_guard']);

@Injectable()
export class ResidencyLoadSpecBuilder {
  constructor(
    private readonly livePath: ImplicitLivePathReader,
    private readonly agents: AgentRepository,
    private readonly aiModels: AiModelRepository,
    // Optional so the controller composes without the STT resolver graph; an stt load then fails closed with a named cause.
    @Optional() private readonly asr?: AsrAgentResolverService,
  ) {}

  async build(service: 'stt' | 'nlp', modelRef: string, lastSeenCache?: string): Promise<Record<string, unknown>> {
    return service === 'stt' ? this.sttSpec(modelRef) : this.nlpSpec(modelRef, lastSeenCache);
  }

  private async sttSpec(modelRef: string): Promise<Record<string, unknown>> {
    if (!this.asr) throw new ResidencyLoadSpecError('LOAD_FAILED', 'The speech-to-text agent resolver is not wired in this composition.');

    const candidates = (await this.livePath.read())
      .filter((m) => m.service === 'stt' && m.modelRef === modelRef)
      .map((m) => ({ tenantId: m.tenantId, slug: m.agentSlug }));
    if (candidates.length === 0) candidates.push(...(await this.agentsNaming(modelRef)));
    if (candidates.length === 0) {
      throw new ResidencyLoadSpecError(
        'MODEL_UNKNOWN',
        `No active published speech-to-text agent names '${modelRef}' as its primary model, so no runnable spec can be built for it.`,
      );
    }

    let lastProblem = '';
    for (const { tenantId, slug } of candidates) {
      try {
        const { spec } = await this.asr.resolve({ tenantId, agentSlug: slug });
        if (spec.models.asr.slug === modelRef) return { resolved_spec: spec };
        lastProblem = `agent '${slug}' resolves primary '${spec.models.asr.slug}', not '${modelRef}'`;
      } catch (error) {
        lastProblem = error instanceof Error ? error.message : String(error);
      }
    }
    throw new ResidencyLoadSpecError('LOAD_FAILED', `No runnable speech-to-text spec for '${modelRef}': ${lastProblem}`);
  }

  /** Active published SPEECH_TO_TEXT agents (any tenant) whose primary is the model with this slug. */
  private async agentsNaming(modelRef: string): Promise<Array<{ tenantId: string; slug: string }>> {
    const models = await this.aiModels.findAll({ filters: { slug: modelRef } as never });
    if (models.length === 0) return [];
    const agents = await this.agents.findAll({
      filters: {
        modelId: { in: models.map((m) => m.id) },
        task: AgentTask.SPEECH_TO_TEXT,
        isActive: true,
        status: WorkflowDefinitionStatus.PUBLISHED,
        resourceStatus: ResourceStatusType.ENABLED,
      } as never,
    });
    // SYSTEM's own agent first: it is the one every tenant was cloned from.
    return agents
      .sort((a, b) => Number(b.tenantId === SYSTEM_TENANT_ID) - Number(a.tenantId === SYSTEM_TENANT_ID))
      .map((a) => ({ tenantId: a.tenantId, slug: a.slug }));
  }

  private async nlpSpec(modelRef: string, lastSeenCache?: string): Promise<Record<string, unknown>> {
    const [row] = await this.aiModels.findAll({ filters: { tenantId: SYSTEM_TENANT_ID, servedBy: 'nlp', sourceUri: modelRef } as never, limit: 1 });
    const modelPath = row ? derivedLocalPath(row) : null;

    let cache = lastSeenCache && SIMPLE_NLP_CACHES.has(lastSeenCache) ? lastSeenCache : undefined;
    if (!cache && row?.taskType === ModelTaskType.TOKEN_CLASSIFICATION) cache = 'nlp_token_classifier';
    if (!cache && row?.taskType === ModelTaskType.TEXT_CLASSIFICATION) cache = 'nlp_text_classifier';
    if (!cache) {
      throw new ResidencyLoadSpecError(
        row ? 'LOAD_FAILED' : 'MODEL_UNKNOWN',
        row
          ? `nlp slot for '${modelRef}' cannot be derived from its catalogue row (taskType ${row.taskType}); load it once through the serving path so nlp reports its cache.`
          : `No platform nlp model is served under '${modelRef}'.`,
      );
    }
    return { cache, model_path: modelPath };
  }
}
