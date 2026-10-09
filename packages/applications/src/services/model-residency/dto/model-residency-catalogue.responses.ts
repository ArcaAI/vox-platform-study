import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  CatalogueAction,
  CatalogueDeviceBytesSource,
  CatalogueKeepPolicyKind,
  CatalogueModelKind,
  CatalogueModelStatus,
  CatalogueRunsOn,
  CatalogueSizeSource,
  CatalogueUseRole,
  RuntimeKeyMatchStrength,
  RecommendationAction,
  RecommendationReason,
  ResidencyBytesSource,
  ResidencyClassSource,
  ResidencyMode,
  ResidencyServiceName,
} from '../model-residency.types';
import { ModelResidencyFreshness } from './model-residency.responses';

/**
 * TASK-1005 §13 — `GET /api/v1/admin/model-residency/catalogue`, key for key
 * `tests/contracts/model-residency-catalogue.fixture.json` (the console lane
 * builds against the same file). Catalogue-first: every loadable model, loaded
 * or not, grouped by the workload that runs it.
 */

const SERVICES = ['stt', 'stt-worker', 'lm-studio', 'nlp', 'tts'];

export class ModelResidencyDeviceModel {
  @ApiProperty({ enum: SERVICES }) service!: ResidencyServiceName;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ description: 'Catalogue name, or the modelRef when the catalogue does not know the model.' }) name!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'Bytes this model holds on THIS device. A split LM Studio model carries its per-card SHARE (estimated); `null` only when nothing is known.',
  })
  bytes!: number | null;
  @ApiProperty({
    enum: ['measured', 'estimated', 'unknown'],
    description: 'TASK-1051 — `measured` = the service`s own load delta; `estimated` = the catalogue size or a split model`s per-card share.',
  })
  bytesSource!: CatalogueDeviceBytesSource;
}

export class ModelResidencyCatalogueDevice {
  @ApiProperty({ example: 'gpu0', description: '`gpu<N>` = DCGM device N; `cpu:<service>` = that service`s host memory pool.' }) id!: string;
  @ApiProperty({ enum: ['gpu', 'cpu'] }) kind!: 'gpu' | 'cpu';
  @ApiProperty({ example: 'GPU 0 — NVIDIA RTX 2000 Ada Generation' }) label!: string;
  @ApiProperty() totalBytes!: number;
  @ApiProperty() usedBytes!: number;
  @ApiProperty() freeBytes!: number;
  @ApiProperty({ nullable: true, type: Number }) utilisationPercent!: number | null;
  @ApiProperty({ description: 'The `residency.headroomPercent` in force.' }) headroomPercent!: number;
  @ApiProperty({ description: 'TASK-1051 — bytes the controller keeps free on this device (`totalBytes × headroomPercent / 100`).' })
  headroomBytes!: number;
  @ApiProperty({ description: 'TASK-1051 — `freeBytes < headroomBytes`: a cold load here would breach the budget.' }) overHeadroom!: boolean;
  @ApiProperty({ description: 'TASK-1051 — the sum of `models[].bytes` (measured + estimated).' }) attributedBytes!: number;
  @ApiProperty({
    description: 'TASK-1051 — `usedBytes − attributedBytes`, floored at 0: CUDA contexts and other processes on a time-sliced card.',
  })
  unattributedBytes!: number;
  @ApiProperty({ type: [ModelResidencyDeviceModel], description: 'The models resident on this device right now.' })
  models!: ModelResidencyDeviceModel[];
}

export class ModelResidencySize {
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({
    enum: ['measured', 'catalogue', 'unknown'],
    description: '`measured` = the resident report or `AiModel.observedMemoryMb`; `catalogue` = the `memorySizeMb` estimate; `unknown` = neither.',
  })
  source!: CatalogueSizeSource;
}

export class ModelResidencyDeviceShare {
  @ApiProperty({ example: 'gpu0' }) device!: string;
  @ApiProperty() bytes!: number;
}

export class ModelResidencyLoadConfig {
  @ApiProperty({ nullable: true, type: Number }) contextLength!: number | null;
  @ApiProperty({ nullable: true, type: Number }) parallel!: number | null;
  @ApiProperty({ nullable: true, type: Boolean }) flashAttention!: boolean | null;
  @ApiProperty({ nullable: true, type: String, example: 'q8_0' }) kvCacheQuantK!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'q8_0' }) kvCacheQuantV!: string | null;
  @ApiProperty({ nullable: true, type: String, description: '`gpu<N>` when pinned to one card, `multi` when split.' }) device!: string | null;
}

export class ModelResidencyPlacement {
  @ApiProperty({ description: '`gpu<N>`, `multi` (LM Studio spans every card), `cpu:<service>`, or the service`s own id when it cannot be mapped.' })
  device!: string;
  @ApiProperty({ description: 'Pod name, or the LM Studio instance id.' }) instance!: string;
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({ enum: ['measured', 'estimated', 'unknown'] }) bytesSource!: ResidencyBytesSource;
  @ApiProperty({ nullable: true, type: Number }) inFlight!: number | null;
  @ApiProperty({ nullable: true, type: Number }) requestsPerMin!: number | null;
  @ApiProperty({ nullable: true, type: Number }) p50LatencyMs!: number | null;
  @ApiProperty({ nullable: true, type: String }) loadedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastUsedAt!: string | null;
  @ApiPropertyOptional({
    type: () => ModelResidencyDeviceShare,
    isArray: true,
    description: 'TASK-1055 — bytes this instance holds per card, as the service measured them (LM Studio splits one model over several).',
  })
  deviceBytes?: ModelResidencyDeviceShare[];
  @ApiPropertyOptional({
    type: () => ModelResidencyLoadConfig,
    nullable: true,
    description: 'TASK-1055 — LM Studio only: the config the instance was ACTUALLY loaded with (prefills Reload with options).',
  })
  loadConfig?: ModelResidencyLoadConfig | null;
}

export class ModelResidencyUse {
  @ApiProperty() tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ nullable: true, type: String, description: '`null` for a `routing` use (a routing policy has no agent).' }) agentSlug!:
    string | null;
  @ApiProperty({ description: 'The agent`s name; for a routing use, the policy`s display name or its task key.' }) agentName!: string;
  @ApiProperty({ description: 'The agent task (`SPEECH_TO_TEXT`, …) or, for a routing use, the policy`s task key (`nlp.ner`, …).' }) task!: string;
  @ApiProperty({ enum: ['primary', 'fallback', 'routing', 'pipeline_stage', 'workflow_node'] }) role!: CatalogueUseRole;
  @ApiProperty({ description: 'This agent is assigned on the live consultation path and this model is its primary.' }) liveConsultation!: boolean;
}

export class ModelResidencyConsumerCounts {
  @ApiProperty({ description: 'Agents whose PRIMARY model this is.' }) agents!: number;
  @ApiProperty({ description: 'Agents holding it in a fallback chain.' }) fallbacks!: number;
  @ApiProperty({ description: 'Active routing policies (guardrail, NLP, judge) naming it.' }) routingPolicies!: number;
  @ApiProperty({ description: 'ASR agents whose resolved spec uses it as a stage (VAD, denoise, diarization, embedding).' }) pipelineStages!: number;
  @ApiProperty({ description: 'Published workflow `core.agent` nodes whose agent runs on it.' }) workflowNodes!: number;
}

export class ModelResidencyUsage {
  @ApiProperty({ description: 'Distinct agents among the primary and fallback uses.' }) agentCount!: number;
  @ApiProperty() tenantCount!: number;
  @ApiProperty({ description: 'Any use is on the live consultation path.' }) liveConsultation!: boolean;
  @ApiProperty({ type: [ModelResidencyUse], description: 'Across ALL tenants; only ACTIVE PUBLISHED agents and ACTIVE routing policies count.' })
  uses!: ModelResidencyUse[];
  @ApiProperty({
    type: ModelResidencyConsumerCounts,
    description: 'TASK-1051 — every kind of consumer, counted; any of them on a live path makes `liveConsultation` true.',
  })
  consumers!: ModelResidencyConsumerCounts;
}

export class ModelResidencyKeepPolicy {
  @ApiProperty({ enum: ['always', 'warm', 'on_demand'], description: 'PINNED → always, WARM → warm, ON_DEMAND → on_demand.' })
  kind!: CatalogueKeepPolicyKind;
  @ApiProperty({ example: 'Always loaded' }) label!: string;
  @ApiProperty({ example: 'Used by a live-consultation agent' }) reason!: string;
  @ApiProperty({ enum: ['policy', 'implicit-live-path', 'default'] }) source!: ResidencyClassSource;
  @ApiProperty({ nullable: true, type: String }) policyId!: string | null;
  @ApiProperty({ nullable: true, type: Number }) policyVersion!: number | null;
  @ApiProperty({ nullable: true, type: Number }) idleTtlSeconds!: number | null;
}

export class ModelResidencyLoadError {
  @ApiProperty({ example: 'LOAD_FAILED', description: 'The error code the failed load raised (an agent exception class name, or a gateway code).' })
  code!: string;
  @ApiProperty({ description: 'What the load said, truncated to 500 characters.' }) message!: string;
  @ApiProperty({ nullable: true, type: String, description: 'When it failed (ISO); `null` when the source carries no time (the stt-worker gauge).' })
  at!: string | null;
}

export class ModelResidencyRuntimeKeyCandidate {
  @ApiProperty() aiModelId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['strong', 'weak'] }) strength!: RuntimeKeyMatchStrength;
  @ApiProperty({ example: 'Same key once the quantisation/instance suffix is removed' }) reason!: string;
}

export class ModelResidencyIdentity {
  @ApiProperty({ description: 'The reported instance is tied to this catalogue row (by normalised key or an operator-confirmed key).' })
  matched!: boolean;
  @ApiProperty({ type: [String], description: 'Every key this row is recognised under: its catalogue ref, then the confirmed keys.' })
  runtimeKeys!: string[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The key the service actually reported for the resident instance; `null` when not resident.',
  })
  reportedKey!: string | null;
  @ApiProperty({
    type: [ModelResidencyRuntimeKeyCandidate],
    description: 'Only on an UNMATCHED resident row: catalogue rows it could be, best first.',
  })
  candidates!: ModelResidencyRuntimeKeyCandidate[];
}

export class ModelResidencyCatalogueModel {
  @ApiProperty({ nullable: true, type: String, description: '`null` only for a resident model the catalogue does not know.' }) aiModelId!:
    string | null;
  @ApiProperty() name!: string;
  @ApiProperty({
    enum: ['resident', 'remote', 'builtin'],
    description: 'TASK-1051 — `remote` (a cloud API) and `builtin` (compiled into a library) hold no memory and offer no load/unload.',
  })
  kind!: CatalogueModelKind;
  @ApiProperty({ nullable: true, type: String }) slug!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The key the service holds it under (stt = slug, nlp = hub id, LM Studio = wire id) — what load / unload take.',
  })
  modelRef!: string | null;
  @ApiProperty({ nullable: true, type: String }) format!: string | null;
  @ApiProperty({
    enum: ['loaded', 'loading', 'unloading', 'not_loaded', 'failed'],
    description: '`failed` = the last load of this model raised and nothing has cleared it yet (a later load or unload does). `error` says why.',
  })
  status!: CatalogueModelStatus;
  @ApiProperty({ type: ModelResidencyLoadError, nullable: true, description: 'Set only while `status` is `failed`.' })
  error!: ModelResidencyLoadError | null;
  @ApiProperty({ type: ModelResidencySize }) size!: ModelResidencySize;
  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'TASK-1051 — what admission reserves for a load: the measured footprint, else the catalogue size × 1.2; `null` = no size (a load is refused unless forced).',
  })
  budgetBytes!: number | null;
  @ApiProperty({ type: ModelResidencyIdentity }) identity!: ModelResidencyIdentity;
  @ApiProperty({ nullable: true, type: Number, description: 'Seconds the last load took (measured).' }) loadSeconds!: number | null;
  @ApiProperty({ type: ModelResidencyPlacement, nullable: true, description: '`null` when not loaded.' }) residency!: ModelResidencyPlacement | null;
  @ApiProperty({ type: ModelResidencyUsage }) usage!: ModelResidencyUsage;
  @ApiProperty({ type: ModelResidencyKeepPolicy }) keepPolicy!: ModelResidencyKeepPolicy;
  @ApiProperty({ enum: ['load', 'unload', 'reload', 'edit_policy'], isArray: true, description: 'What the console may offer for this row now.' })
  actions!: CatalogueAction[];
  @ApiPropertyOptional({
    type: String,
    description:
      'TASK-1055 — present only while `actions` offers `load` and the catalogue row ALONE says the load cannot succeed (an stt stage model that loads with its ASR agent, an entailment scorer not published to the models bucket or with no calibration, a guard judge or classifier on a runtime nlp does not have). The same words the load refusal carries. Absent = nothing static stands in the way.',
    example:
      "nlp_entailment_scorer for 'nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF' needs the model's local path, and the catalogue row has none (not published to the models bucket); the scorer never auto-downloads.",
  })
  loadBlockedReason?: string;
}

export class ModelResidencyCatalogueService {
  @ApiProperty({ enum: SERVICES }) service!: ResidencyServiceName;
  @ApiProperty({ example: 'Speech-to-text — live sessions' }) label!: string;
  @ApiProperty({ enum: ['gpu', 'cpu'] }) runsOn!: CatalogueRunsOn;
  @ApiProperty({ description: '`false` for stt-worker, which has no control API (observed through Prometheus only).' }) controllable!: boolean;
  @ApiProperty({ description: 'The service`s last report is fresh (stt-worker: Prometheus answered).' }) reachable!: boolean;
  @ApiProperty() loadedCount!: number;
  @ApiProperty({ type: [ModelResidencyCatalogueModel] }) models!: ModelResidencyCatalogueModel[];
}

export class ModelResidencySuggestion {
  @ApiProperty({ description: 'Stable for the life of this standing recommendation — the id `POST suggestions/:id/dismiss` takes.' }) id!: string;
  @ApiProperty({ description: 'Last confirmed (the controller reached the same conclusion again).' }) at!: string;
  @ApiProperty({ description: 'TASK-1051 — when the controller first reached this conclusion.' }) firstSeenAt!: string;
  @ApiProperty({ description: 'TASK-1051 — how many ticks have re-confirmed it (1 = once).' }) repeats!: number;
  @ApiProperty({ enum: ['idle_ttl_expired', 'promotion_rate', 'live_path_pin', 'make_room', 'admission_rejected'] }) reason!: RecommendationReason;
  @ApiProperty({ example: 'Unload Medical NER on nlp — idle for 20 minutes and no live agent uses it.' }) text!: string;
  @ApiProperty({ enum: ['load', 'unload', 'pin', 'unpin'] }) action!: RecommendationAction;
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ description: 'The command was sent AND succeeded. Always `false` in shadow mode.' }) applied!: boolean;
}

export class ModelResidencyCatalogueResponse {
  @ApiProperty({ enum: ['shadow', 'enforce'] }) mode!: ResidencyMode;
  @ApiProperty() reportedAt!: string;
  @ApiProperty({ type: ModelResidencyFreshness }) freshness!: ModelResidencyFreshness;
  @ApiProperty({ type: [ModelResidencyCatalogueDevice] }) devices!: ModelResidencyCatalogueDevice[];
  @ApiProperty({ type: [ModelResidencyCatalogueService], description: 'Always five groups, in this order: stt, stt-worker, lm-studio, nlp, tts.' })
  services!: ModelResidencyCatalogueService[];
  @ApiProperty({
    type: [ModelResidencySuggestion],
    description:
      'TASK-1051 — STANDING recommendations: one per (action, service, model), most recently confirmed first, never one the current policy already satisfies, dismissed ones omitted; at most 20.',
  })
  suggestions!: ModelResidencySuggestion[];
}
