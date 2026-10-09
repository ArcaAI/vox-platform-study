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
 * `taskType` alone sent GLiGuard to the transformers text classifier, and Prompt
 * Guard 2 to it too):
 *  - `libraryName` / `architecture` `gliner2` → `nlp_gliner2_guard`;
 *  - `_metadata.entailment` declared → `nlp_entailment_scorer`, + `calibration`
 *    (that object verbatim, camelCase, as the guard route sends it);
 *  - `_metadata.judge` declared → `nlp_judge_guard` (`POST /guard/judge`), when its
 *    `protocol` is `qwen3guard_native` — the only judge runtime nlp has; another
 *    protocol is refused by name. (The seeded judges are LM Studio-served, so
 *    they never reach here; this is the nlp-served transport guardrail's judge
 *    runner also supports.)
 *  - `_metadata.labelTaxonomy` declared → the row is a guardrail CLASSIFIER, served
 *    by `POST /guard/classify`, whose runtime `libraryName` picks exactly as
 *    guardrail's client sends it: `transformers` → `nlp_seq_cls_guard` (Prompt
 *    Guard 2); `gliner2` was taken above; anything else is refused by name;
 *  - the SYSTEM `nlp.diagnosis` election → `nlp_medical_suggester`, + the
 *    SYSTEM `nlp.ner` election as its NER — the pair the gateway's diagnosis
 *    route sends (`ai-inference.controller.ts#suggestDiagnosis`);
 *  - otherwise `taskType` (token → `nlp_token_classifier`, text → `nlp_text_classifier`).
 * The scorer and the suggester refuse BY NAME when what they need is absent
 * (no calibration, no published path, no `nlp.ner` election) — nlp fails closed
 * on all three anyway, less legibly.
 *
 * Every refusal that depends on the ROW alone is `loadBlockedReasonFor` — the
 * catalogue shows it before a Load is attempted, and this builder throws the
 * same words, so the two can never disagree.
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

const SEQ_CLS_GUARD = 'nlp_seq_cls_guard';
const JUDGE_GUARD = 'nlp_judge_guard';
/** nlp caches whose slot needs nothing beyond `{cache, model_path}`. */
const SIMPLE_NLP_CACHES = new Set(['nlp_token_classifier', 'nlp_text_classifier', 'nlp_gliner2_guard', SEQ_CLS_GUARD, JUDGE_GUARD]);
const SUGGESTER = 'nlp_medical_suggester';
const ENTAILMENT = 'nlp_entailment_scorer';
/** Every cache `apps/nlp/src/nlp/residency.py#_plan` accepts. */
const NLP_CACHES = new Set([...SIMPLE_NLP_CACHES, SUGGESTER, ENTAILMENT]);
/** The one judge protocol nlp's `/guard/judge` has a runtime for (`api/v1/rest/guard.py`). */
const NLP_JUDGE_PROTOCOL = 'qwen3guard_native';
/** `/guard/classify` runtimes by `libraryName` (guardrail `external_nlp_client.py`); `gliner2` is matched first. */
const GUARD_CLASSIFY_LIBRARIES: Record<string, string> = { transformers: SEQ_CLS_GUARD };
const ASR_TASK_TYPE = 'AUTOMATIC_SPEECH_RECOGNITION';

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

/** The slice of a catalogue row the static rules read. `AiModelEntity` satisfies it. */
export type LoadSpecRow = Omit<NlpRow, 'id' | 'sourceUri'> & { slug?: string; sourceUri?: string };

/**
 * What the row ALONE says about the nlp slot: a cache, a refusal, or "a text classifier — the SYSTEM
 * `nlp.diagnosis` election decides whether it is the suggester". Pure; no repository read.
 */
type StaticNlpSlot = { cache: string } | { refusal: string } | { electionDecides: true };

function staticNlpSlot(row: LoadSpecRow): StaticNlpSlot {
  const ref = row.sourceUri ?? row.slug ?? 'this model';
  const meta = isRec(row.metaData) ? row.metaData : {};
  if (row.libraryName === 'gliner2' || row.architecture === 'gliner2') return { cache: 'nlp_gliner2_guard' };
  if (meta.entailment !== undefined) {
    if (!isRec(meta.entailment)) {
      return {
        refusal: `nlp_entailment_scorer for '${ref}' needs its calibration (AiModel _metadata.entailment), which the catalogue row does not declare; nlp refuses to load the scorer without it.`,
      };
    }
    if (!derivedLocalPath(row as never)) {
      return {
        refusal: `nlp_entailment_scorer for '${ref}' needs the model's local path, and the catalogue row has none (not published to the models bucket); the scorer never auto-downloads.`,
      };
    }
    return { cache: ENTAILMENT };
  }
  if (meta.judge !== undefined) {
    const protocol = isRec(meta.judge) ? meta.judge.protocol : undefined;
    if (protocol === NLP_JUDGE_PROTOCOL) return { cache: JUDGE_GUARD };
    return {
      refusal: `'${ref}' is a guard judge (AiModel _metadata.judge) with protocol '${String(protocol)}', and nlp's /guard/judge runs only '${NLP_JUDGE_PROTOCOL}'; serve it from LM Studio (servedBy lmstudio) or change its protocol.`,
    };
  }
  if (meta.labelTaxonomy !== undefined) {
    const cache = row.libraryName ? GUARD_CLASSIFY_LIBRARIES[row.libraryName] : undefined;
    if (cache) return { cache };
    return {
      refusal: `'${ref}' is a guardrail classifier (AiModel _metadata.labelTaxonomy) on library '${String(row.libraryName)}', and nlp's /guard/classify runs only gliner2 and transformers; nlp would refuse it.`,
    };
  }
  if (row.taskType === ModelTaskType.TOKEN_CLASSIFICATION) return { cache: 'nlp_token_classifier' };
  if (row.taskType === ModelTaskType.TEXT_CLASSIFICATION) return { electionDecides: true };
  return {
    refusal: `nlp slot for '${ref}' cannot be derived from its catalogue row (taskType ${String(row.taskType)}); load it once through the serving path so nlp reports its cache.`,
  };
}

/**
 * TASK-1055 — why a catalogue model cannot be loaded from the console, when the ROW alone says so
 * (`null` = nothing static stands in the way; the load may still be refused at run time, e.g. an ASR
 * model no published agent names, or a suggester with no `nlp.ner` election). The same words the
 * builder throws.
 */
export function loadBlockedReasonFor(service: string, row: LoadSpecRow & { taskType?: unknown }): string | null {
  if (service === 'nlp') {
    const slot = staticNlpSlot(row);
    return 'refusal' in slot ? slot.refusal : null;
  }
  if (service === 'stt' && row.taskType !== undefined && row.taskType !== null && row.taskType !== ASR_TASK_TYPE) {
    return `'${row.slug ?? row.sourceUri}' is a ${String(row.taskType)} stage, not a speech recognition model: stt loads it with the pipeline of the speech-to-text agent that uses it, never on its own. Load that agent's ASR model instead.`;
  }
  return null;
}

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
      const [row] = await this.aiModels.findAll({ filters: { slug: modelRef } as never, limit: 1 });
      const blocked = row ? loadBlockedReasonFor('stt', row as never) : null;
      if (blocked) throw new ResidencyLoadSpecError('LOAD_FAILED', blocked);
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

    const reported = lastSeenCache && NLP_CACHES.has(lastSeenCache) ? lastSeenCache : undefined;
    if (!reported && !row) throw new ResidencyLoadSpecError('MODEL_UNKNOWN', `No platform nlp model is served under '${modelRef}'.`);
    const cache = reported ?? (await this.deriveNlpCache(row!));
    if (cache === ENTAILMENT) return this.entailmentSpec(modelRef, row, modelPath);
    if (cache === SUGGESTER) return this.suggesterSpec(modelRef, modelPath);
    return { cache, model_path: modelPath };
  }

  private async deriveNlpCache(row: NlpRow): Promise<string> {
    const slot = staticNlpSlot(row);
    if ('refusal' in slot) throw new ResidencyLoadSpecError('LOAD_FAILED', slot.refusal);
    if ('cache' in slot) return slot.cache;
    return (await this.electedModelId('nlp.diagnosis')) === row.id ? SUGGESTER : 'nlp_text_classifier';
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
