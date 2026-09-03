/**
 * STT graph -> `AsrPipeline` + `AsrPipelineVersion` compiler.
 *
 * central design decision: a published `stt`-palette `WorkflowDefinition` does NOT
 * get a new execution surface. It compiles into `AsrPipeline.configYaml` (`models.asr` /
 * `models.vad` / `models.denoise` slug references — the EXACT shape `apps/stt`'s
 * `PipelineYamlParser`/`PipelineConfigReader` already reads, verified against
 * `apps/stt/src/stt/pipeline/{yaml_parser,dto}.py`), and both of STT's existing entry points
 * (realtime WS, batch Dramatiq) already parameterize on the resulting `pipelineId`. No new
 * schema, no per-node Temporal dispatch, no per-frame audio inside a workflow.
 *
 * Two pieces, deliberately split:
 * - `compileSttGraphToYaml` — a PURE function (no I/O) over `CompiledWorkflowConfig` (the
 *   `@arcaai/workflow-contract` `compile()` output). Throws when the graph cannot produce a
 *   valid `AsrPipeline.configYaml` (no `stt.asrEngine` node, or one with no `modelSlug`) — the
 * ONE piece of Task 2's mandatory-subgraph intent enforces as a HARD publish
 * block, since `validate()`'s DRAFT `WF-STT-*` rules never block a write ( decision
 *   #3) but an `AsrPipeline` with no ASR model is not a row `PipelineYamlParser` can serve.
 * - `SttPipelineCompilerService` — writes the emitted YAML through the EXISTING
 *   `PipelineService` (never a raw repository call), so `PipelineService`'s own
 *   `broadcastSysEvent`/OCC/`AsrPipelineVersion`-snapshot behavior fires unmodified. A
 *   `stt`-palette `WorkflowDefinition`'s `slug` (tenant-invented, stable across republishes —
 *   `workflow-definition.prisma`) maps to a DETERMINISTIC `AsrPipeline` slug
 *   (`sttWorkflowPipelineSlug`), so a republish of the same lineage updates the SAME pipeline
 *   row (`PipelineService.update` snapshots a new `AsrPipelineVersion` on every config change) —
 *   the two versioning schemes stay in lockstep by both being driven from the same publish call.
 */
import { Injectable } from '@nestjs/common';
import type { CompiledWorkflowConfig } from '@arcaai/workflow-contract';
import type { CreatePipelineRequest, PipelineResponse, UpdatePipelineRequest } from '../../stt/pipeline/dto';
import { PipelineService } from '../../stt/pipeline/pipeline.service';

const ASR_ENGINE_NODE = 'stt.asrEngine';
const VAD_NODE = 'stt.vad';
const NOISE_FILTER_NODE = 'stt.noiseFilter';
const DIARIZATION_NODE = 'stt.diarization';
const LANGUAGE_DETECTION_NODE = 'stt.languageDetection';

/**
 * Tags every compiled `AsrPipeline` with the `WorkflowDefinition` id it was compiled from —
 * the provenance convention Task 4 recommended over a new schema column
 *  (`AsrPipeline.tags` already exists, no migration). Read this back with
 *  `tags.includes(\`${STT_WORKFLOW_TAG_PREFIX}${workflowDefinitionId}\`)`.
 */
export const STT_WORKFLOW_TAG_PREFIX = 'workflow-definition:';

/**
 * Mirrors `apps/stt/src/stt/pipeline/language_modes.py`'s `LANGUAGE_MODE_CATALOG` — kept in
 * sync BY HAND ( disclosed cross-language enum-drift risk; no shared contract test
 *  exists yet). Only the fields this compiler needs (`primaryLanguage`, whether the mode
 *  code-switches) — the full per-engine resolution (`resolve_mode_for_engine`) stays entirely
 *  inside `apps/stt`, which is the ONLY thing that ever knows which concrete engine will serve
 *  a session; this compiler only needs to seed `PipelineSpec.inference.language`/`code_switching`.
 */
const LANGUAGE_MODE_TABLE: Readonly<Record<string, { primaryLanguage: string | null; codeSwitch: boolean }>> = Object.freeze({
  en: { primaryLanguage: 'en', codeSwitch: false },
  ml: { primaryLanguage: 'ml', codeSwitch: false },
  'ml-en': { primaryLanguage: 'ml', codeSwitch: true },
  vi: { primaryLanguage: 'vi', codeSwitch: false },
  'vi-en': { primaryLanguage: 'vi', codeSwitch: true },
  auto: { primaryLanguage: null, codeSwitch: false },
});

function flattenNodes(compiledConfig: CompiledWorkflowConfig) {
  return compiledConfig.stages.flatMap((stage) => stage.nodes);
}

function findConfig(compiledConfig: CompiledWorkflowConfig, type: string): Record<string, unknown> | undefined {
  return flattenNodes(compiledConfig).find((node) => node.type === type)?.config;
}

function stringField(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Compile a validated `stt`-palette `CompiledWorkflowConfig` into an `AsrPipeline.configYaml`
 * string. Pure, no I/O. Throws a plain `Error` (the caller — `WorkflowDefinitionService.publish`
 * — is expected to let this propagate; it is a genuine publish-blocking defect in the graph,
 * not a soft warning) when the graph cannot produce a servable pipeline.
 */
export function compileSttGraphToYaml(compiledConfig: CompiledWorkflowConfig): string {
  const asrConfig = findConfig(compiledConfig, ASR_ENGINE_NODE);
  if (asrConfig === undefined) {
    throw new Error(
      `stt-palette WorkflowDefinition '${compiledConfig.definitionId}' has no '${ASR_ENGINE_NODE}' node — cannot compile an AsrPipeline.`,
    );
  }
  const asrSlug = stringField(asrConfig, 'modelSlug');
  if (!asrSlug) {
    throw new Error(
      `stt-palette WorkflowDefinition '${compiledConfig.definitionId}''s '${ASR_ENGINE_NODE}' node has no modelSlug — cannot compile an AsrPipeline.`,
    );
  }

  const vadSlug = stringField(findConfig(compiledConfig, VAD_NODE), 'modelSlug');
  const denoiseSlug = stringField(findConfig(compiledConfig, NOISE_FILTER_NODE), 'modelSlug');
  const diarizationConfig = findConfig(compiledConfig, DIARIZATION_NODE);
  // `stt.diarization`'s `modelSlug` is the SPEAKER_DIARIZATION-taskType model — the segmentation
  // stage that actually performs diarization (ModelRefs.segmentation role); its companion
  // `embeddingModelSlug` is the SPEAKER_EMBEDDING model (ModelRefs.embedding role). See the
  // node's own contract (`contracts/nodes/stt.diarization.schema.json`).
  const segmentationSlug = stringField(diarizationConfig, 'modelSlug');
  const embeddingSlug = stringField(diarizationConfig, 'embeddingModelSlug');
  const languageConfig = findConfig(compiledConfig, LANGUAGE_DETECTION_NODE);

  const modelLines: string[] = [`  asr: ${yamlString(asrSlug)}`];
  if (vadSlug) modelLines.push(`  vad: ${yamlString(vadSlug)}`);
  if (denoiseSlug) modelLines.push(`  denoise: ${yamlString(denoiseSlug)}`);
  if (segmentationSlug) modelLines.push(`  segmentation: ${yamlString(segmentationSlug)}`);
  if (embeddingSlug) modelLines.push(`  embedding: ${yamlString(embeddingSlug)}`);

  const lines: string[] = ['version: "2.0"', 'models:', ...modelLines];

  if (diarizationConfig !== undefined) {
    lines.push('diarization:', '  enabled: true');
  }

  const mode = stringField(languageConfig, 'mode');
  const languageModeId = stringField(languageConfig, 'languageModeId');
  if (mode && mode !== 'auto') {
    const resolved = languageModeId ? LANGUAGE_MODE_TABLE[languageModeId] : undefined;
    if (resolved?.primaryLanguage) {
      lines.push('inference:', `  language: ${yamlString(resolved.primaryLanguage)}`);
      if (resolved.codeSwitch) {
        lines.push('  code_switching: true');
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * The deterministic `AsrPipeline` slug for a given `stt`-palette `WorkflowDefinition.slug`.
 * `WorkflowDefinition.slug` matches `WORKFLOW_DEFINITION_SLUG_PATTERN` (; formerly the node-id grammar `[a-z0-9_]{2,48}`, may start or
 * end with `_`); `AsrPipeline.slug` requires `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (hyphens only, must
 * start/end alphanumeric) — the two grammars are NOT interchangeable, so this is a real,
 * tested mapping, not a bare string swap.
 */
export function sttWorkflowPipelineSlug(workflowDefinitionSlug: string): string {
  const hyphenated = workflowDefinitionSlug.replace(/_/g, '-').replace(/^-+|-+$/g, '');
  const base = hyphenated.length > 0 ? hyphenated : 'workflow';
  return `wf-stt-${base}`.slice(0, 100);
}

export interface SttWorkflowDefinitionRef {
  id: string;
  slug: string;
  versionNumber: number;
  name: string;
}

@Injectable()
export class SttPipelineCompilerService {
  constructor(private readonly pipelineService: PipelineService) {}

  /**
   * Compile `compiledConfig` and write the result through `PipelineService` — create on first
   * publish of this `WorkflowDefinition` slug lineage, update (new `AsrPipelineVersion`
   * snapshot) on every republish. Runs in the SAME tenant/request (CLS) context as the caller
   * (`WorkflowDefinitionService.publish`), so no `tenantId` is threaded explicitly here.
   */
  async compileAndPublish(entity: SttWorkflowDefinitionRef, compiledConfig: CompiledWorkflowConfig): Promise<PipelineResponse> {
    const configYaml = compileSttGraphToYaml(compiledConfig);
    const pipelineSlug = sttWorkflowPipelineSlug(entity.slug);
    const provenanceTag = `${STT_WORKFLOW_TAG_PREFIX}${entity.id}`;
    const changeReason = `Published from WorkflowDefinition '${entity.slug}' v${entity.versionNumber}`;

    const existing = await this.pipelineService.getBySlug(pipelineSlug);
    if (existing) {
      const tags = Array.from(new Set([...(existing.tags ?? []), provenanceTag]));
      const dto: UpdatePipelineRequest = { configYaml, tags, changeReason, expectedVersion: existing.version };
      return this.pipelineService.update(existing.id, dto);
    }

    const dto: CreatePipelineRequest = {
      name: entity.name,
      slug: pipelineSlug,
      description: `Compiled from stt-palette WorkflowDefinition '${entity.slug}' .`,
      configYaml,
      tags: [provenanceTag],
    };
    return this.pipelineService.create(dto);
  }
}
