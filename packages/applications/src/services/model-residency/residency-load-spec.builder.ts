import { Injectable, Optional } from '@nestjs/common';
import {
  AgentRepository,
  AgentTask,
  AiModelRepository,
  AiRoutingPolicyRepository,
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
 * nlp — the cache the model was last seen in (from the agent's own report),
 * else the one its catalogue row implies, with `model_path` = the row's derived
 * local path. Derivation, first match wins (TASK-1055, cluster e2e 2026-10-09 —
 * `taskType` alone sent GLiGuard to the transformers text classifier):
 *  - `libraryName` / `architecture` `gliner2` → `nlp_gliner2_guard`;
 *  - `_metadata.entailment` declared → `nlp_entailment_scorer`, + `calibration`
 *    (that object verbatim, camelCase, as the guard route sends it);
 *  - the SYSTEM `nlp.diagnosis` election → `nlp_medical_suggester`, + the
 *    SYSTEM `nlp.ner` election as its NER — the pair the gateway's diagnosis
 *    route sends (`ai-inference.controller.ts#suggestDiagnosis`);
 *  - otherwise `taskType` (token → `nlp_token_classifier`, text → `nlp_text_classifier`).
 * The scorer and the suggester refuse BY NAME when what they need is absent
 * (no calibration, no published path, no `nlp.ner` election) — nlp fails closed
 * on all three anyway, less legibly.
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
const SUGGESTER = 'nlp_medical_suggester';
const ENTAILMENT = 'nlp_entailment_scorer';
/** Every cache `apps/nlp/src/nlp/residency.py#_plan` accepts. */
const NLP_CACHES = new Set([...SIMPLE_NLP_CACHES, SUGGESTER, ENTAILMENT]);

type NlpRow = {
  id: string;
  sourceUri: string;
  taskType?: unknown;
  libraryName?: string | null;
  architecture?: string | null;
  metaData?: unknown;
  bucketPrefix?: string | null;
  primaryObject?: string | null;
};
const isRec = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

@Injectable()
export class ResidencyLoadSpecBuilder {
  constructor(
    private readonly livePath: ImplicitLivePathReader,
    private readonly agents: AgentRepository,
    private readonly aiModels: AiModelRepository,
    // Optional so the controller composes without the STT resolver graph; an stt load then fails closed with a named cause.
    @Optional() private readonly asr?: AsrAgentResolverService,
    // TASK-1055 — the SYSTEM nlp elections that mark (and pair) the medical suggester. Optional like `asr`: absent, the suggester refuses by name.
    @Optional() private readonly routing?: AiRoutingPolicyRepository,
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
    const [found] = await this.aiModels.findAll({ filters: { tenantId: SYSTEM_TENANT_ID, servedBy: 'nlp', sourceUri: modelRef } as never, limit: 1 });
    const row = found as unknown as NlpRow | undefined;
    const modelPath = row ? derivedLocalPath(row as never) : null;

    const cache = (lastSeenCache && NLP_CACHES.has(lastSeenCache) ? lastSeenCache : undefined) ?? (row ? await this.deriveNlpCache(row) : undefined);
    if (!cache) {
      throw new ResidencyLoadSpecError(
        row ? 'LOAD_FAILED' : 'MODEL_UNKNOWN',
        row
          ? `nlp slot for '${modelRef}' cannot be derived from its catalogue row (taskType ${String(row.taskType)}); load it once through the serving path so nlp reports its cache.`
          : `No platform nlp model is served under '${modelRef}'.`,
      );
    }
    if (cache === ENTAILMENT) return this.entailmentSpec(modelRef, row, modelPath);
    if (cache === SUGGESTER) return this.suggesterSpec(modelRef, modelPath);
    return { cache, model_path: modelPath };
  }

  private async deriveNlpCache(row: NlpRow): Promise<string | undefined> {
    if (row.libraryName === 'gliner2' || row.architecture === 'gliner2') return 'nlp_gliner2_guard';
    if (isRec(row.metaData) && row.metaData.entailment !== undefined) return ENTAILMENT;
    if (row.taskType === ModelTaskType.TOKEN_CLASSIFICATION) return 'nlp_token_classifier';
    if (row.taskType === ModelTaskType.TEXT_CLASSIFICATION) {
      return (await this.electedModelId('nlp.diagnosis')) === row.id ? SUGGESTER : 'nlp_text_classifier';
    }
    return undefined;
  }

  /** The groundedness scorer never auto-downloads and fails closed without its calibration: both are required. */
  private entailmentSpec(modelRef: string, row: NlpRow | undefined, modelPath: string | null): Record<string, unknown> {
    const calibration = isRec(row?.metaData) ? row.metaData.entailment : undefined;
    if (!isRec(calibration)) {
      throw new ResidencyLoadSpecError(
        'LOAD_FAILED',
        `nlp_entailment_scorer for '${modelRef}' needs its calibration (AiModel _metadata.entailment), which the catalogue row does not declare; nlp refuses to load the scorer without it.`,
      );
    }
    if (!modelPath) {
      throw new ResidencyLoadSpecError(
        'LOAD_FAILED',
        `nlp_entailment_scorer for '${modelRef}' needs the model's local path, and the catalogue row has none (not published to the models bucket); the scorer never auto-downloads.`,
      );
    }
    return { cache: ENTAILMENT, model_path: modelPath, calibration };
  }

  /** The suggester runs TWO models: the disease classifier and the NER the SYSTEM `nlp.ner` election names. */
  private async suggesterSpec(modelRef: string, modelPath: string | null): Promise<Record<string, unknown>> {
    const nerId = await this.electedModelId('nlp.ner');
    const [ner] = nerId ? await this.aiModels.findAll({ filters: { id: nerId, resourceStatus: ResourceStatusType.ENABLED } as never, limit: 1 }) : [];
    if (!ner?.sourceUri) {
      throw new ResidencyLoadSpecError(
        'LOAD_FAILED',
        `nlp_medical_suggester for '${modelRef}' needs the NER model the SYSTEM 'nlp.ner' election names (the one the diagnosis route pairs it with), and none is elected${this.routing ? '' : ' (routing policies are not wired in this composition)'}.`,
      );
    }
    return { cache: SUGGESTER, model_path: modelPath, ner_model_name: ner.sourceUri, ner_model_path: derivedLocalPath(ner) };
  }

  /** The model id of the SYSTEM election for an `nlp.*` task key (platform-only keys: SYSTEM is the only tier read). */
  private async electedModelId(taskKey: 'nlp.diagnosis' | 'nlp.ner'): Promise<string | null> {
    if (!this.routing) return null;
    const rows = await this.routing.findCandidates([SYSTEM_TENANT_ID], taskKey);
    return (rows.find((row) => row.isDefault) ?? rows[0])?.modelId ?? null;
  }
}
