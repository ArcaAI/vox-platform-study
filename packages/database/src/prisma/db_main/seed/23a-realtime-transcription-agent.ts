/**
 * the REALTIME TRANSCRIPTION AGENT, as an `stt`-palette
 * `WorkflowDefinition`, twice: a SYSTEM template and the ArcaAI tenant's own
 * published copy, plus the `AsrPipeline` that copy's publish would have
 * produced.
 *
 * ## What was missing
 *
 * A "single-task agent" in this platform is a `WorkflowDefinition` on the
 * palette that owns the task. For transcription that palette is `stt`, and
 * publishing an `stt` graph does NOT create a new execution surface: it
 * compiles into `AsrPipeline.configYaml` through
 * `compileSttGraphToYaml`/`SttPipelineCompilerService`, which the realtime WS
 * bridge and the batch Dramatiq worker already parameterize on
 * (`compilers/stt-pipeline.compiler.ts`).
 *
 * The database held ZERO `stt`-palette definitions — only raw `AsrPipeline`
 * rows, created by hand. So the pipeline a clinician transcribes with had no
 * authored graph behind it, could not be cloned from a platform template, and
 * could not be edited in Workflow Studio. These rows close that.
 *
 * ## Provenance — read before editing any blob below
 *
 * `graph` is AUTHORED. `graphChecksum`, `compiledConfig`, `registryChecksum`
 * and `validationReport` are ENGINE OUTPUT — the literal result of
 * `packages/workflow-contract`'s real `validate()` / `compile()` /
 * `registryChecksum()`, written by
 * `packages/database/scripts/regen-realtime-transcription-agent-seed.ts` and
 * committed verbatim. So is `PIPELINE_CONFIG_YAML`: it is
 * `compileSttGraphToYaml(ARCAAI compiledConfig)`, imported from the REAL
 * compiler in the same script, never hand-written YAML that happens to look
 * right.
 *
 * `task-858-realtime-transcription-agent.test.ts` re-runs all four functions
 * and compares, so none of these literals can drift or be invented.
 *
 * ## Two definitions, and why the SYSTEM one is not a pipeline
 *
 * The SYSTEM row is a TEMPLATE: `findSystemTemplates` serves every SYSTEM,
 * PUBLISHED, active definition to the Studio's clone-from-template flow
 * so a tenant admin gets this agent as a starting point without
 * anyone copying JSON. It compiles to no `AsrPipeline`, and must not: an
 * `AsrPipeline` is what a TENANT publish produces for that tenant's own
 * sessions, and a SYSTEM pipeline row would be a template nothing ever cloned.
 * The seeded ArcaAI-only precedent for a pipeline with no SYSTEM template is
 * `ARCAAI_MANUAL_ASR_PIPELINES` in `06-stt.ts` (`sourceTemplateSlug: null`,
 * `templateLocked: false`), and this row carries the same shape.
 *
 * ## Why the pipeline row lives HERE and not in `06-stt.ts`
 *
 * `06-stt.ts` holds the TEMPLATE CATALOGUE — the SYSTEM matrix and each
 * tenant's full-parity mirror of it. This row is neither: it is a publish
 * ARTIFACT, and its `configYaml` is only correct as long as it equals what the
 * compiler emits for the definition above it. Keeping the two in one file is
 * what makes that checkable in one test; splitting them would let the YAML and
 * the graph drift with nothing to notice.
 */
import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import {
  ARCAAI_TRANSCRIPTION_COMPILED_CONFIG,
  ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM,
  ARCAAI_TRANSCRIPTION_VALIDATION_REPORT,
  PIPELINE_CONFIG_YAML,
  PLATFORM_TRANSCRIPTION_COMPILED_CONFIG,
  PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM,
  PLATFORM_TRANSCRIPTION_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
} from './23a-realtime-transcription-agent.generated';

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

/** Pinned so every derived blob is reproducible; a wall-clock value would make them un-diffable. */
export const COMPILED_AT = '2026-09-03T00:00:00.000Z';

/** The q8_0 medical GGUF row added by (`seed/ai-models/audio.ts`). */
export const TRANSCRIPTION_ASR_MODEL_SLUG = 'whisper-large-en-medical-260726-merged-gguf-q8_0';

export const PLATFORM_TRANSCRIPTION_AGENT_ID = '99000000-0000-0000-0002-000000000001';
export const ARCAAI_TRANSCRIPTION_AGENT_ID = '99000000-0000-0000-0002-000000000002';

export const PLATFORM_TRANSCRIPTION_AGENT_SLUG = 'platform-realtime-transcription-medical-en';
export const ARCAAI_TRANSCRIPTION_AGENT_SLUG = 'arcaai-realtime-transcription-medical-en';

/**
 * The compiled `AsrPipeline` slug, computed the way
 * `sttWorkflowPipelineSlug` computes it (`_` → `-`, trimmed, `wf-stt-` prefix,
 * capped at 100). Restated as a literal rather than imported because
 * `packages/database` takes no dependency on `@arcaai/applications`; the test
 * imports the real function by path and asserts the two agree, so the literal
 * cannot drift from the function that will actually run at the next republish.
 */
export const ARCAAI_TRANSCRIPTION_PIPELINE_SLUG = 'wf-stt-arcaai-realtime-transcription-medical-en';

/** `STT_WORKFLOW_TAG_PREFIX` in `compilers/stt-pipeline.compiler.ts`. */
export const STT_WORKFLOW_TAG_PREFIX = 'workflow-definition:';

// =============================================================================
// The authored graph (regeneration INPUT — everything below it is derived)
// =============================================================================

type SeedEdge = { id: string; from: string; fromPort: string; to: string; toPort: string };

const edges = (specs: readonly (readonly [string, string, string, string])[]): SeedEdge[] =>
  specs.map(([from, fromPort, to, toPort], index) => ({ id: `e${index + 1}`, from, fromPort, to, toPort }));

/**
 * The single-task transcription agent: capture the microphone, clean the
 * audio, gate it on speech, transcribe it, publish the transcript.
 *
 * ```
 * start -> audioInput -> noiseFilter -> vad -> languageDetection -> asrEngine -> transcriptOutput -> end
 * ```
 *
 * The `core.start` / `core.end` markers are not decoration. `WF-S-002/003/004`
 * are palette-AGNOSTIC structural rules — exactly one `core.start`, every node
 * reachable from it, every node reaching a `core.end` — so a graph without them
 * validates with thirteen ERROR findings and is not publishable at all. (This
 * is the same gap `21-workflow-definition.ts` records for the summarization
 * platform default, whose report is scoped to `WF-SUMM-*` for that reason; the
 * consultation graphs in `23-arcaai-workflow-authoring.ts` carry the markers and
 * report clean. This graph follows the consultation graphs, so its report is a
 * FULL-catalogue clean report rather than a scoped one.) They are classed
 * `boundary` in the registry, which is what exempts them from the consultation
 * palette's own reachability rules elsewhere.
 *
 * Every edge is a REAL socket from `node-ports.ts`. The audio pre-processors
 * pass `stream<audio>` through unchanged; `stt.asrEngine` is the only node that
 * turns it into a `transcript`, which is what makes it non-bypassable in TYPE
 * terms as well as under WF-STT-006.
 *
 * ## What is deliberately ABSENT
 *
 * `stt.diarization` — one clinician, one microphone, one speaker label; a
 * diarization stage would add a segmentation and an embedding model to the
 * compiled `models:` block for no clinical gain, and `compileSttGraphToYaml`
 * would emit `diarization.enabled: true` off the node's mere presence.
 *
 * `stt.phiHop` — registered `implemented: false`, so `compile()` REFUSES any
 * graph containing it. Not a judgement call: the graph would not compile.
 *
 * ## Why `stt.languageDetection` IS here
 *
 * The owner asked for language mode `en`, and `stt.asrEngine`'s config schema
 * has exactly two properties — `modelSlug` and `onError`. There is no language
 * key on the ASR node to set. `stt.languageDetection` is the palette's only
 * carrier of that decision (`mode` + `languageModeId`), and it is the only node
 * `compileSttGraphToYaml` reads to emit `inference.language`. Without it the
 * compiled pipeline pins no language at all and the runtime auto-detects —
 * which for an English-only medical fine-tune is a silent quality regression,
 * not a neutral default. `mode: 'single'` (not `'auto'`) is what makes the
 * compiler emit the block; `languageModeId: 'en'` is what it emits.
 */
const transcriptionNodes = [
  { id: 'n_start', type: 'core.start', config: {} },
  // `mode: 'realtime'` — this agent exists for the live consultation surface.
  // A batch definition would be a sibling row, not a config flag flipped at
  // run time: `mode` is compiled, and the two paths have different budgets.
  { id: 'n_audio', type: 'stt.audioInput', config: { mode: 'realtime' } },
  // DeepFilterNet3 — the full-band DNN denoiser, named so the compiled
  // `models.denoise` says WHICH engine rather than leaving the runtime on its
  // legacy `rnnoise` fallback.
  //
  // ⚠ DISCLOSED GAP, not an oversight. `compileSttGraphToYaml` emits a
  // `models:` block and (for a non-auto language node) an `inference:` block,
  // and NOTHING else — it writes no `preprocessing:` section. `apps/stt`'s
  // parser defaults `preprocessing.denoise.enabled` to FALSE (its `vad`
  // sibling defaults to TRUE), so on today's compiler this node names the
  // engine the pipeline WOULD use and does not by itself switch denoising on.
  // The node stays because the graph is the authored statement of intent and
  // the compiler is what has to grow; removing it would hide the gap instead
  // of recording it. Closing it is a change to the compiler in
  // `packages/applications`, which is out of this seed's scope.
  { id: 'n_denoise', type: 'stt.noiseFilter', config: { modelSlug: 'deepfilternet3' } },
  // Silero v5, the detector `apps/stt`'s VAD service actually loads. Named
  // rather than defaulted so the compiled `models.vad` is explicit.
  { id: 'n_vad', type: 'stt.vad', config: { modelSlug: 'silero-vad' } },
  { id: 'n_lang', type: 'stt.languageDetection', config: { mode: 'single', languageModeId: 'en' } },
  // `onError: 'fail'` and NOT `degrade`. Every other node here is a
  // pre-processor whose absence costs quality; this one IS the task. A
  // transcription agent that degraded its ASR step would publish an empty
  // transcript and report success, which is the worst available outcome for a
  // clinician watching the note grow.
  { id: 'n_asr', type: 'stt.asrEngine', config: { modelSlug: TRANSCRIPTION_ASR_MODEL_SLUG, onError: 'fail' } },
  { id: 'n_out', type: 'stt.transcriptOutput', config: {} },
  { id: 'n_end', type: 'core.end', config: {} },
];

const TRANSCRIPTION_EDGES = edges([
  // Ordering (`next` -> `after`) into and out of the boundary markers: they
  // carry no payload, and neither marker has a data socket to carry one on.
  ['n_start', 'next', 'n_audio', 'after'],
  ['n_audio', 'out', 'n_denoise', 'in'],
  ['n_denoise', 'out', 'n_vad', 'in'],
  ['n_vad', 'out', 'n_lang', 'in'],
  ['n_lang', 'out', 'n_asr', 'in'],
  ['n_asr', 'out', 'n_out', 'in'],
  ['n_out', 'next', 'n_end', 'after'],
]);

/**
 * ONE authored graph, seeded twice. The SYSTEM template and the ArcaAI copy
 * are byte-identical by construction — a template a tenant clones and then
 * differs from is the normal case, but a template that differs from its own
 * seeded clone on day one would be a difference nobody decided.
 */
export const REALTIME_TRANSCRIPTION_GRAPH = { version: 1, nodes: transcriptionNodes, edges: TRANSCRIPTION_EDGES };

// =============================================================================
// Derived blobs — GENERATED, never hand-typed. See the module docstring.
// Regenerate: pnpm --filter @arcaai/workflow-contract build
//             pnpm --filter @arcaai/database exec tsx scripts/regen-realtime-transcription-agent-seed.ts
// =============================================================================

export {
  ARCAAI_TRANSCRIPTION_COMPILED_CONFIG,
  ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM,
  ARCAAI_TRANSCRIPTION_VALIDATION_REPORT,
  PIPELINE_CONFIG_YAML,
  PLATFORM_TRANSCRIPTION_COMPILED_CONFIG,
  PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM,
  PLATFORM_TRANSCRIPTION_VALIDATION_REPORT,
  REGISTRY_CHECKSUM,
} from './23a-realtime-transcription-agent.generated';

// =============================================================================
// Rows
// =============================================================================

const DESCRIPTION =
  'Single-task realtime transcription agent: microphone capture, DeepFilterNet-class noise reduction, Silero v5 voice-activity gating, English (single-language) ASR on the in-house EN-medical whisper.cpp GGUF q8_0 fine-tune, and transcript delivery. Publishing it compiles an AsrPipeline the live WebSocket bridge and the batch worker both bind by id.';

/** SYSTEM-owned. `createdBy: SYSTEM_USER_ID` — this row asserts no human authorship. */
export const PLATFORM_TRANSCRIPTION_DEFINITION = {
  id: PLATFORM_TRANSCRIPTION_AGENT_ID,
  tenantId: SYSTEM_TENANT_ID,
  slug: PLATFORM_TRANSCRIPTION_AGENT_SLUG,
  name: 'Realtime Transcription Agent — whisper.cpp EN-Medical q8_0 (platform template)',
  description: `${DESCRIPTION} Platform template — clone it to author a tenant copy.`,
  paletteKey: 'stt',
  versionNumber: 1,
  parentVersionId: null,
  status: 'PUBLISHED' as const,
  isActive: true,
  graph: REALTIME_TRANSCRIPTION_GRAPH,
  graphChecksum: PLATFORM_TRANSCRIPTION_GRAPH_CHECKSUM,
  compiledConfig: PLATFORM_TRANSCRIPTION_COMPILED_CONFIG,
  compiledConfigChecksum: (PLATFORM_TRANSCRIPTION_COMPILED_CONFIG as { checksum: string }).checksum,
  registryChecksum: REGISTRY_CHECKSUM,
  validationReport: PLATFORM_TRANSCRIPTION_VALIDATION_REPORT,
  needsReview: false,
  validatedAt: new Date(COMPILED_AT),
  publishedAt: new Date(COMPILED_AT),
  tags: ['platform-template', 'stt', 'transcription', 'medical', 'whisper.cpp'],
  createdBy: SYSTEM_USER_ID,
};

/** ArcaAI-owned. `createdBy` is the TENANT admin — the whole claim of the row. */
export const ARCAAI_TRANSCRIPTION_DEFINITION = {
  id: ARCAAI_TRANSCRIPTION_AGENT_ID,
  tenantId: ARCAAI,
  slug: ARCAAI_TRANSCRIPTION_AGENT_SLUG,
  name: 'Realtime Transcription Agent — whisper.cpp EN-Medical q8_0',
  description: DESCRIPTION,
  paletteKey: 'stt',
  versionNumber: 1,
  parentVersionId: null,
  status: 'PUBLISHED' as const,
  isActive: true,
  graph: REALTIME_TRANSCRIPTION_GRAPH,
  graphChecksum: ARCAAI_TRANSCRIPTION_GRAPH_CHECKSUM,
  compiledConfig: ARCAAI_TRANSCRIPTION_COMPILED_CONFIG,
  compiledConfigChecksum: (ARCAAI_TRANSCRIPTION_COMPILED_CONFIG as { checksum: string }).checksum,
  registryChecksum: REGISTRY_CHECKSUM,
  validationReport: ARCAAI_TRANSCRIPTION_VALIDATION_REPORT,
  needsReview: false,
  validatedAt: new Date(COMPILED_AT),
  publishedAt: new Date(COMPILED_AT),
  tags: ['arcaai', 'stt', 'transcription', 'medical', 'whisper.cpp', 'tenant-authored'],
  createdBy: SEED_USER_IDS.ARCAAI_ADMIN,
};

/**
 * The `AsrPipeline` the ArcaAI publish would have written, reproduced exactly:
 * the slug `sttWorkflowPipelineSlug` derives, the `configYaml`
 * `compileSttGraphToYaml` emits, and the provenance tag
 * `workflow-definition:<definition id>` that lets a reader get from a pipeline
 * back to the graph it came from.
 *
 * `isDefault: true` — this is the ArcaAI tenant's backend default from now on.
 * See `seedRealtimeTranscriptionAgent` for how the previous default is demoted
 * without racing `switchDefaultSttPipelineToGgufTurbo` in `06-stt.ts`.
 */
export const ARCAAI_TRANSCRIPTION_PIPELINE = {
  id: '81000000-0000-0000-0001-000000000130',
  tenantId: ARCAAI,
  name: 'Realtime Transcription Agent — whisper.cpp EN-Medical q8_0',
  slug: ARCAAI_TRANSCRIPTION_PIPELINE_SLUG,
  description: `Compiled from stt-palette WorkflowDefinition '${ARCAAI_TRANSCRIPTION_AGENT_SLUG}' .`,
  configYaml: PIPELINE_CONFIG_YAML,
  isDefault: true,
  tags: [`${STT_WORKFLOW_TAG_PREFIX}${ARCAAI_TRANSCRIPTION_AGENT_ID}`, 'medical', 'whisper.cpp'],
  // A publish artifact, not a clone of a SYSTEM template — same posture as the
  // `ARCAAI_MANUAL_ASR_PIPELINES` rows in `06-stt.ts`.
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
};

// =============================================================================
// Seed functions
// =============================================================================

/** The SYSTEM template. Platform configuration — runs in `safe` mode too. */
export const seedPlatformTranscriptionAgentTemplate = async (client: CorePrismaClient): Promise<{ created: boolean }> => {
  console.log('Seeding the platform realtime-transcription agent template ...');

  // CREATE-ONLY. A PUBLISHED WorkflowDefinition is immutable at three
  // application layers AND at a database trigger — an upsert with an `update`
  // branch would raise at the DB.
  const existing = await client.workflowDefinition.findUnique({ where: { id: PLATFORM_TRANSCRIPTION_AGENT_ID }, select: { id: true } });
  if (existing) {
    console.log(`  ${PLATFORM_TRANSCRIPTION_AGENT_SLUG} already exists, skipping`);
    return { created: false };
  }

  await client.workflowDefinition.create({
    data: {
      ...PLATFORM_TRANSCRIPTION_DEFINITION,
      graph: PLATFORM_TRANSCRIPTION_DEFINITION.graph as never,
      compiledConfig: PLATFORM_TRANSCRIPTION_DEFINITION.compiledConfig as never,
      validationReport: PLATFORM_TRANSCRIPTION_DEFINITION.validationReport as never,
    },
  });
  console.log(`  created ${PLATFORM_TRANSCRIPTION_AGENT_SLUG} (SYSTEM tenant, PUBLISHED, isActive)`);
  return { created: true };
};

/**
 * The ArcaAI tenant's copy, and the pipeline its publish compiled.
 *
 * ## The default flip, and why it is a reconciliation rather than a flag
 *
 * `seedAsrPipelines` (`06-stt.ts`) deliberately never clobbers `isDefault` on
 * update, because the flag is admin-controlled at runtime. That is right, and
 * it means a freshly-created `isDefault: true` row on an EXISTING database
 * would sit beside whatever default that database already had — two defaults
 * for one tenant. So this function demotes the tenant's other defaults
 * explicitly, in the same pass, exactly as `switchDefaultSttPipelineToGgufTurbo`
 * does for its own cutover.
 *
 * Ordering matters and is stable in both directions: this phase runs AFTER
 * `seedStt`, so it has the last word on a fresh seed; and on the NEXT re-seed
 * `switchDefaultSttPipelineToGgufTurbo` reads this row as "an admin already
 * picked a different default", keeps it, and promotes nothing — its
 * `adminPicked` branch. Neither function fights the other.
 */
export const seedArcaaiTranscriptionAgent = async (client: CorePrismaClient): Promise<{ created: boolean; pipelineDemoted: number }> => {
  console.log('Seeding the ArcaAI realtime-transcription agent + its compiled AsrPipeline ...');

  let created = false;
  const existing = await client.workflowDefinition.findUnique({ where: { id: ARCAAI_TRANSCRIPTION_AGENT_ID }, select: { id: true } });
  if (existing) {
    console.log(`  ${ARCAAI_TRANSCRIPTION_AGENT_SLUG} already exists, skipping`);
  } else {
    await client.workflowDefinition.create({
      data: {
        ...ARCAAI_TRANSCRIPTION_DEFINITION,
        graph: ARCAAI_TRANSCRIPTION_DEFINITION.graph as never,
        compiledConfig: ARCAAI_TRANSCRIPTION_DEFINITION.compiledConfig as never,
        validationReport: ARCAAI_TRANSCRIPTION_DEFINITION.validationReport as never,
      },
    });
    created = true;
    console.log(`  created ${ARCAAI_TRANSCRIPTION_AGENT_SLUG} (ArcaAI tenant, PUBLISHED, isActive)`);
  }

  // The compiled pipeline. Upsert by id: unlike the definition, a republish is
  // supposed to refresh `configYaml` — that is what
  // `SttPipelineCompilerService.compileAndPublish` does through
  // `PipelineService.update`.
  const { isDefault: _pipelineDefault, ...pipelineWithoutDefault } = ARCAAI_TRANSCRIPTION_PIPELINE;
  await client.asrPipeline.upsert({
    where: { id: ARCAAI_TRANSCRIPTION_PIPELINE.id },
    create: ARCAAI_TRANSCRIPTION_PIPELINE as never,
    // `isDefault` is admin state, refreshed by the reconciliation below rather
    // than stamped here — same rule `seedAsrPipelines` follows.
    update: pipelineWithoutDefault as never,
  });

  // Exactly one default per tenant: demote every OTHER ArcaAI default, then
  // promote this one. Idempotent — a converged database matches nothing.
  const demoted = await client.asrPipeline.updateMany({
    where: { tenantId: ARCAAI, isDefault: true, id: { not: ARCAAI_TRANSCRIPTION_PIPELINE.id } },
    data: { isDefault: false },
  });
  await client.asrPipeline.updateMany({
    where: { id: ARCAAI_TRANSCRIPTION_PIPELINE.id, isDefault: false },
    data: { isDefault: true },
  });

  console.log(`  ✓ AsrPipeline ${ARCAAI_TRANSCRIPTION_PIPELINE_SLUG} is the ArcaAI default (${demoted.count} other default(s) demoted)`);
  return { created, pipelineDemoted: demoted.count };
};
