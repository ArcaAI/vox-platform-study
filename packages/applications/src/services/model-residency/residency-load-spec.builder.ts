import { Injectable, Optional } from '@nestjs/common';
import { AiModelRepository, AiRoutingPolicyRepository, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { derivedLocalPath } from '../ai-model/constants';
import { AgentResolverService } from '../agent/agent-resolver.service';
import { toTtsSpecModel } from '../agent/tts-spec';
import { toAsrSpecModel } from '../stt/agent-resolver/build-resolved-asr-spec';
import { ENTAILMENT, NLP_CACHES, type NlpRow, SUGGESTER, isRec, staticNlpSlot, sttSpecRoleFor } from './residency-load-rules';

export { loadBlockedReasonFor, type LoadSpecRow } from './residency-load-rules';

/**
 * TASK-1005 — the `load_spec` a residency agent needs to load a model it does
 * not yet hold (`tests/contracts/model-residency-agent.fixture.json` →
 * `loadSpecExamples`). The agents keep no catalogue, so the gateway supplies
 * it; an EMPTY spec is valid only for a model already resident.
 *
 * stt — TASK-1055 wave 3 (W3-2): ALWAYS the model-only spec `{model: <AsrSpecModel>}`
 * (`model-residency-task1055.fixture.json` → `wave3.sttModelOnly`), built from the
 * SYSTEM row with the SAME projection `buildResolvedAsrSpec` uses for that role
 * (`AgentResolverService` → `ResolvedAgentModel`, then `toAsrSpecModel`) — for ASR
 * AND stage rows (VAD, denoise, diarization embedding, punctuation, endpointing).
 * No agent is consulted to LOAD; stt caches it under the slug sessions use, so a
 * later session reuses it.
 *
 * tts — `{engine, model}` (`wave3.ttsResidency`, + `$amendment`): the engine
 * `apps/tts` registers the provider under, and the `TtsSpecModel` the synth path
 * would carry (`toTtsSpecModel`), so a cold load on a fresh pod builds the same
 * engine instance a request reuses.
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

@Injectable()
export class ResidencyLoadSpecBuilder {
  constructor(
    private readonly aiModels: AiModelRepository,
    // TASK-1055 — the SYSTEM nlp elections that mark (and pair) the medical suggester. Optional: absent, the suggester refuses by name.
    @Optional() private readonly routing?: AiRoutingPolicyRepository,
    // TASK-1055 wave 3 — the row → `ResolvedAgentModel` half of the stt / tts projections (derived `localPath`). Optional: absent, those loads fail closed by name.
    @Optional() private readonly agentModels?: AgentResolverService,
  ) {}

  async build(service: 'stt' | 'nlp' | 'tts', modelRef: string, lastSeenCache?: string): Promise<Record<string, unknown>> {
    if (service === 'stt') return this.sttSpec(modelRef);
    if (service === 'tts') return this.ttsSpec(modelRef);
    return this.nlpSpec(modelRef, lastSeenCache);
  }

  private async sttSpec(modelRef: string): Promise<Record<string, unknown>> {
    const [row] = await this.aiModels.findAll({ filters: { tenantId: SYSTEM_TENANT_ID, slug: modelRef } as never, limit: 1 });
    if (!row) throw new ResidencyLoadSpecError('MODEL_UNKNOWN', `No platform speech-to-text model has the slug '${modelRef}'.`);
    const slot = sttSpecRoleFor(row as never);
    if ('refusal' in slot) throw new ResidencyLoadSpecError('LOAD_FAILED', slot.refusal);
    const model = await this.resolvedModel(modelRef, slot.role === 'asr' ? 'primary' : slot.role, String(row.taskType));
    return { model: toAsrSpecModel(model, slot.role) };
  }

  private async ttsSpec(modelRef: string): Promise<Record<string, unknown>> {
    const [row] = await this.aiModels.findAll({ filters: { tenantId: SYSTEM_TENANT_ID, servedBy: 'tts', slug: modelRef } as never, limit: 1 });
    if (!row) throw new ResidencyLoadSpecError('MODEL_UNKNOWN', `No platform text-to-speech model has the slug '${modelRef}'.`);
    const model = toTtsSpecModel(await this.resolvedModel(modelRef, 'primary', String(row.taskType)), row.metaData);
    if (!model.provider) throw new ResidencyLoadSpecError('MODEL_UNKNOWN', `'${modelRef}' names no text-to-speech engine.`);
    return { engine: model.provider, model };
  }

  /** The SYSTEM row as `AgentResolverService` materialises an agent's model — the projections' only input. */
  private async resolvedModel(modelRef: string, role: 'primary' | 'vad' | 'denoise' | 'embedding' | 'punctuation' | 'endpointing', taskType: string) {
    if (!this.agentModels) {
      throw new ResidencyLoadSpecError('LOAD_FAILED', 'The model projection (AgentResolverService) is not wired in this composition.');
    }
    const model = await this.agentModels.resolveModelBySlug(modelRef, SYSTEM_TENANT_ID, { role, taskType });
    if (!model) throw new ResidencyLoadSpecError('MODEL_UNKNOWN', `No platform model has the slug '${modelRef}'.`);
    return model;
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
