import { ApiProperty } from '@nestjs/swagger';
import type {
  CatalogueAction,
  CatalogueKeepPolicyKind,
  CatalogueModelStatus,
  CatalogueRunsOn,
  CatalogueSizeSource,
  CatalogueUseRole,
  RecommendationAction,
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

const SERVICES = ['stt', 'stt-worker', 'lm-studio', 'nlp'];

export class ModelResidencyDeviceModel {
  @ApiProperty({ enum: SERVICES }) service!: ResidencyServiceName;
  @ApiProperty() modelRef!: string;
  @ApiProperty({ description: 'Catalogue name, or the modelRef when the catalogue does not know the model.' }) name!: string;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Bytes this model holds on THIS device; `null` when unknown — always for LM Studio, which splits one model over every card.',
  })
  bytes!: number | null;
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

export class ModelResidencyPlacement {
  @ApiProperty({ description: '`gpu<N>`, `multi` (LM Studio spans every card), `cpu:<service>`, or the service`s own id when it cannot be mapped.' })
  device!: string;
  @ApiProperty({ description: 'Pod name, or the LM Studio instance id.' }) instance!: string;
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({ enum: ['measured', 'unknown'] }) bytesSource!: ResidencyBytesSource;
  @ApiProperty({ nullable: true, type: Number }) inFlight!: number | null;
  @ApiProperty({ nullable: true, type: Number }) requestsPerMin!: number | null;
  @ApiProperty({ nullable: true, type: Number }) p50LatencyMs!: number | null;
  @ApiProperty({ nullable: true, type: String }) loadedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastUsedAt!: string | null;
}

export class ModelResidencyUse {
  @ApiProperty() tenantId!: string;
  @ApiProperty() tenantName!: string;
  @ApiProperty({ nullable: true, type: String, description: '`null` for a `routing` use (a routing policy has no agent).' }) agentSlug!:
    string | null;
  @ApiProperty({ description: 'The agent`s name; for a routing use, the policy`s display name or its task key.' }) agentName!: string;
  @ApiProperty({ description: 'The agent task (`SPEECH_TO_TEXT`, …) or, for a routing use, the policy`s task key (`nlp.ner`, …).' }) task!: string;
  @ApiProperty({ enum: ['primary', 'fallback', 'routing'] }) role!: CatalogueUseRole;
  @ApiProperty({ description: 'This agent is assigned on the live consultation path and this model is its primary.' }) liveConsultation!: boolean;
}

export class ModelResidencyUsage {
  @ApiProperty({ description: 'Distinct agents among the primary and fallback uses.' }) agentCount!: number;
  @ApiProperty() tenantCount!: number;
  @ApiProperty({ description: 'Any use is on the live consultation path.' }) liveConsultation!: boolean;
  @ApiProperty({ type: [ModelResidencyUse], description: 'Across ALL tenants; only ACTIVE PUBLISHED agents and ACTIVE routing policies count.' })
  uses!: ModelResidencyUse[];
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

export class ModelResidencyCatalogueModel {
  @ApiProperty({ nullable: true, type: String, description: '`null` only for a resident model the catalogue does not know.' }) aiModelId!:
    string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) slug!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The key the service holds it under (stt = slug, nlp = hub id, LM Studio = wire id) — what load / unload take.',
  })
  modelRef!: string | null;
  @ApiProperty({ nullable: true, type: String }) format!: string | null;
  @ApiProperty({ enum: ['loaded', 'loading', 'unloading', 'not_loaded'] }) status!: CatalogueModelStatus;
  @ApiProperty({ type: ModelResidencySize }) size!: ModelResidencySize;
  @ApiProperty({ nullable: true, type: Number, description: 'Seconds the last load took (measured).' }) loadSeconds!: number | null;
  @ApiProperty({ type: ModelResidencyPlacement, nullable: true, description: '`null` when not loaded.' }) residency!: ModelResidencyPlacement | null;
  @ApiProperty({ type: ModelResidencyUsage }) usage!: ModelResidencyUsage;
  @ApiProperty({ type: ModelResidencyKeepPolicy }) keepPolicy!: ModelResidencyKeepPolicy;
  @ApiProperty({ enum: ['load', 'unload', 'reload', 'edit_policy'], isArray: true, description: 'What the console may offer for this row now.' })
  actions!: CatalogueAction[];
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
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
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
  @ApiProperty({ type: [ModelResidencyCatalogueService], description: 'Always four groups, in this order: stt, stt-worker, lm-studio, nlp.' })
  services!: ModelResidencyCatalogueService[];
  @ApiProperty({ type: [ModelResidencySuggestion], description: 'The controller`s recommendations, newest first, one plain sentence each.' })
  suggestions!: ModelResidencySuggestion[];
}
