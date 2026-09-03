/**
 * the realtime transcription agent seed.
 *
 * ## What this suite is actually for
 *
 * PROVENANCE, in two directions rather than one.
 *
 *  - `graph`, `compiledConfig` and the three checksums are ENGINE OUTPUT. This
 *    suite re-runs the REAL `validate()` / `compile()` / `registryChecksum()`
 *    from `packages/workflow-contract` and asserts the seeded literals equal
 *    what the engine produces RIGHT NOW. A fabricated clean report cannot
 *    survive it, and neither can a stale one.
 *  - `AsrPipeline.configYaml` is COMPILER output too, and that half is the one
 *    the runtime actually serves. It is asserted BYTE-IDENTICAL to
 *    `compileSttGraphToYaml(compiledConfig)` — the same pure function
 *    `WorkflowDefinitionService.publish` calls — so the seeded pipeline cannot
 *    diverge from what the next republish of this graph would write. A
 *    hand-tuned YAML that merely looked right is exactly the failure this
 *    catches, and it would be invisible in review.
 *
 * The engine and the compiler are both imported BY COMPUTED PATH, for the
 * reason `task-798-arcaai-workflow-authoring.test.ts` and
 * `task-821-realtime-lane-seeding.test.ts` already do it: `packages/database`
 * deliberately declares no dependency on `@arcaai/workflow-contract` or
 * `@arcaai/applications` (adding one edits the shared root `pnpm-lock.yaml`),
 * and a non-literal specifier is invisible to `tsc` while Vitest resolves it
 * normally. `compileSttGraphToYaml` / `sttWorkflowPipelineSlug` are themselves
 * PURE — no DI, no I/O — but they share a module with a NestJS service, whose
 * one collaborator is stubbed below.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  ARCAAI_TRANSCRIPTION_AGENT_SLUG,
  ARCAAI_TRANSCRIPTION_DEFINITION,
  ARCAAI_TRANSCRIPTION_PIPELINE,
  ARCAAI_TRANSCRIPTION_PIPELINE_SLUG,
  COMPILED_AT,
  PLATFORM_TRANSCRIPTION_DEFINITION,
  REALTIME_TRANSCRIPTION_GRAPH,
  TRANSCRIPTION_ASR_MODEL_SLUG,
  seedArcaaiTranscriptionAgent,
} from '../23a-realtime-transcription-agent';
import { AUDIO_AI_MODELS } from '../ai-models/audio';
import { SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_SRC = path.resolve(HERE, '../../../../../../workflow-contract/src/index.ts');
const STT_COMPILER_SRC = path.resolve(HERE, '../../../../../../applications/src/services/workflow-definition/compilers/stt-pipeline.compiler.ts');

/**
 * `stt-pipeline.compiler.ts` exports the two PURE functions this suite needs
 * AND a NestJS service that injects `PipelineService`, which reaches
 * `@arcaai/domains` — a workspace package with no `dist` unless something built
 * it first. Stubbing that one collaborator is what keeps this test a UNIT test
 * of the compiler rather than a test that silently depends on build order.
 *
 * The stub is deliberately narrow: only the class the compiler's constructor
 * names. Everything actually under test — `compileSttGraphToYaml`,
 * `sttWorkflowPipelineSlug`, `STT_WORKFLOW_TAG_PREFIX` — is the REAL
 * implementation, imported from the same source
 * `WorkflowDefinitionService.publish` calls.
 */
vi.mock('../../../../../../applications/src/services/stt/pipeline/pipeline.service', () => ({
  PipelineService: class PipelineServiceStub {},
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { canonicalJson, compile, nodeInfo, registryChecksum, validate, workflowNodeClassLookup } = contract;
const { compileSttGraphToYaml, sttWorkflowPipelineSlug, STT_WORKFLOW_TAG_PREFIX }: any = await import(/* @vite-ignore */ STT_COMPILER_SRC);

/** Mirrors `WorkflowDefinitionService`'s own publish constants — what a REAL publish stamps. */
const COMPILER_VERSION = '0.1.0';
const RULE_SET_VERSION = 1;
const DEFAULT_CAPS = { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 };
const DEFAULT_POLICY_BINDINGS = {
  guardrailProfile: 'STANDARD',
  redactionRuleSetId: null,
  promptTemplateRefs: [],
  documentTemplateRefs: [],
  contextSchemaVersionId: null,
  entitlementKeys: [],
};

const DEFINITIONS = [
  ['platform template', PLATFORM_TRANSCRIPTION_DEFINITION],
  ['arcaai copy', ARCAAI_TRANSCRIPTION_DEFINITION],
] as const;

const nodeTypes = (graph: any) => graph.nodes.map((n: any) => n.type);
const nodeOf = (graph: any, id: string) => graph.nodes.find((n: any) => n.id === id);

// ---------------------------------------------------------------------------------------------
describe(' D2 — the transcription agent is a real stt-palette definition', () => {
  it('seeds a SYSTEM template and an ArcaAI copy of the SAME graph', () => {
    expect(PLATFORM_TRANSCRIPTION_DEFINITION.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(ARCAAI_TRANSCRIPTION_DEFINITION.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
    // Identical graphs, so identical checksums — a template that differed from
    // its own seeded clone on day one would be a difference nobody decided.
    expect(PLATFORM_TRANSCRIPTION_DEFINITION.graphChecksum).toBe(ARCAAI_TRANSCRIPTION_DEFINITION.graphChecksum);
  });

  it('attributes each row to the right author', () => {
    // The SYSTEM row asserts no human authorship; the tenant row asserts that a
    // TENANT admin authored it, which is the whole claim of the tenant half.
    expect(PLATFORM_TRANSCRIPTION_DEFINITION.createdBy).toBe(SYSTEM_USER_ID);
    expect(ARCAAI_TRANSCRIPTION_DEFINITION.createdBy).toBe(SEED_USER_IDS.ARCAAI_ADMIN);
    expect(ARCAAI_TRANSCRIPTION_DEFINITION.createdBy).not.toBe(SYSTEM_USER_ID);
  });

  it.each(DEFINITIONS)('%s is PUBLISHED, active, and on the stt palette', (_label, row) => {
    expect(row.paletteKey).toBe('stt');
    expect(row.status).toBe('PUBLISHED');
    expect(row.isActive).toBe(true);
    expect(row.publishedAt).toBeTruthy();
    expect(row.validatedAt).toBeTruthy();
  });

  it('is a SINGLE-TASK agent: capture, clean, gate, transcribe, deliver — and nothing else', () => {
    expect(nodeTypes(REALTIME_TRANSCRIPTION_GRAPH)).toEqual([
      'core.start',
      'stt.audioInput',
      'stt.noiseFilter',
      'stt.vad',
      'stt.languageDetection',
      'stt.asrEngine',
      'stt.transcriptOutput',
      'core.end',
    ]);
  });

  it('carries no diarization and no phiHop', () => {
    const types = nodeTypes(REALTIME_TRANSCRIPTION_GRAPH);
    // Diarization would add two models to the compiled block and flip
    // `diarization.enabled` on for a one-microphone consultation.
    expect(types).not.toContain('stt.diarization');
    // `stt.phiHop` is registered `implemented: false`, so `compile()` REFUSES
    // any graph containing it — this is not a preference, the graph would not
    // compile. Asserted so a later "completeness" edit fails here rather than
    // in a regen run nobody re-reads.
    expect(types).not.toContain('stt.phiHop');
  });

  it('binds the q8_0 EN-medical model, and that model is in the seeded catalog', () => {
    expect(nodeOf(REALTIME_TRANSCRIPTION_GRAPH, 'n_asr').config.modelSlug).toBe(TRANSCRIPTION_ASR_MODEL_SLUG);
    const model = AUDIO_AI_MODELS.find((m) => m.slug === TRANSCRIPTION_ASR_MODEL_SLUG);
    expect(model, 'the q8_0 medical model is not in the AiModel catalog').toBeDefined();
    // `computeType` is what `whisper_cpp_loader._select_gguf_file` matches the
    // GGUF FILENAME on, so it is the whole reason this is a separate row from
    // the f16 one rather than the same row with a different name.
    expect(model?.computeType).toBe('q8_0');
    expect(model?.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(model?.sourceUri).toBe('taphuynh/whisper-large-en-medical-2607.26-merged-gguf');
  });

  it('pins the ASR step to language mode `en` through the only node that can carry it', () => {
    // `stt.asrEngine`'s config schema has exactly `modelSlug` + `onError`;
    // there is no language key on it. `stt.languageDetection` is the palette's
    // only carrier of the decision AND the only node the YAML compiler reads to
    // emit `inference.language`.
    expect(nodeOf(REALTIME_TRANSCRIPTION_GRAPH, 'n_lang').config).toEqual({ mode: 'single', languageModeId: 'en' });
  });

  it('fails the ASR step rather than degrading it', () => {
    // Every other node here is a pre-processor whose absence costs quality.
    // This one IS the task: a degraded ASR publishes an empty transcript and
    // reports success, which is the worst outcome available to a clinician.
    expect(nodeOf(REALTIME_TRANSCRIPTION_GRAPH, 'n_asr').config.onError).toBe('fail');
  });
});

// ---------------------------------------------------------------------------------------------
describe(' D2 — derived blobs are real compiler output', () => {
  it.each(DEFINITIONS)('%s: graphChecksum equals sha256(canonicalJson(graph)) from the real engine', (_label, row) => {
    expect(row.graphChecksum).toBe(createHash('sha256').update(canonicalJson(REALTIME_TRANSCRIPTION_GRAPH)).digest('hex'));
  });

  it('validate() returns ok with ZERO findings against the FULL rule set', () => {
    const report = validate(
      REALTIME_TRANSCRIPTION_GRAPH,
      { paletteKey: 'stt', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum(), evaluatedAt: COMPILED_AT },
    );
    // Not `ok` alone: `ok` only means "no ERROR". A clean report must have no
    // WARNINGs either, and printing them is what makes a failure diagnosable.
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(DEFINITIONS)('%s: the seeded validationReport is byte-identical to validate() now', (_label, row) => {
    const report = validate(
      REALTIME_TRANSCRIPTION_GRAPH,
      { paletteKey: 'stt', registry: workflowNodeClassLookup },
      { ruleSetVersion: RULE_SET_VERSION, registryChecksum: registryChecksum(), evaluatedAt: COMPILED_AT },
    );
    expect(row.validationReport).toEqual(report);
  });

  it.each(DEFINITIONS)('%s: the seeded compiledConfig is byte-identical to compile() now', (_label, row) => {
    const result = compile(REALTIME_TRANSCRIPTION_GRAPH, {
      definitionId: row.id,
      slug: row.slug,
      versionNumber: row.versionNumber,
      tenantId: row.tenantId,
      paletteKey: 'stt',
      compilerVersion: COMPILER_VERSION,
      registryChecksum: registryChecksum(),
      ruleSetVersion: RULE_SET_VERSION,
      caps: DEFAULT_CAPS,
      policyBindings: DEFAULT_POLICY_BINDINGS,
      compiledAt: COMPILED_AT,
      nodeInfo,
    });
    expect('config' in result).toBe(true);
    expect(row.compiledConfig).toEqual((result as { config: unknown }).config);
    expect(row.compiledConfigChecksum).toBe((result as { config: { checksum: string } }).config.checksum);
  });

  it.each(DEFINITIONS)('%s: carries the CURRENT registry checksum and real publish constants', (_label, row) => {
    const current = registryChecksum();
    expect(row.registryChecksum).toBe(current);
    expect((row.compiledConfig as { registryChecksum: string }).registryChecksum).toBe(current);
    expect((row.compiledConfig as { compilerVersion: string }).compilerVersion).toBe(COMPILER_VERSION);
    expect((row.compiledConfig as { caps: { maxNodeSeconds: number } }).caps.maxNodeSeconds).toBe(DEFAULT_CAPS.maxNodeSeconds);
  });
});

// ---------------------------------------------------------------------------------------------
describe(' D2 — the compiled AsrPipeline is what a publish would have written', () => {
  const compiledArcaai = () => {
    const result = compile(REALTIME_TRANSCRIPTION_GRAPH, {
      definitionId: ARCAAI_TRANSCRIPTION_DEFINITION.id,
      slug: ARCAAI_TRANSCRIPTION_DEFINITION.slug,
      versionNumber: 1,
      tenantId: ARCAAI_TRANSCRIPTION_DEFINITION.tenantId,
      paletteKey: 'stt',
      compilerVersion: COMPILER_VERSION,
      registryChecksum: registryChecksum(),
      ruleSetVersion: RULE_SET_VERSION,
      caps: DEFAULT_CAPS,
      policyBindings: DEFAULT_POLICY_BINDINGS,
      compiledAt: COMPILED_AT,
      nodeInfo,
    });
    return (result as { config: unknown }).config;
  };

  it('configYaml is BYTE-IDENTICAL to compileSttGraphToYaml over the compiled config', () => {
    // THE point of D2. A hand-written YAML that looked right would diverge from
    // the next republish of this same graph, silently, and the compiled
    // artifact is what `apps/stt` actually serves.
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.configYaml).toBe(compileSttGraphToYaml(compiledArcaai()));
  });

  it('names the q8_0 model as the ASR engine', () => {
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.configYaml).toContain(`asr: "${TRANSCRIPTION_ASR_MODEL_SLUG}"`);
    // And the language the graph pinned reaches the YAML — the whole reason the
    // languageDetection node is in the graph at all.
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.configYaml).toContain('language: "en"');
  });

  it('uses the slug sttWorkflowPipelineSlug derives, not a hand-typed one', () => {
    expect(ARCAAI_TRANSCRIPTION_PIPELINE_SLUG).toBe(sttWorkflowPipelineSlug(ARCAAI_TRANSCRIPTION_AGENT_SLUG));
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.slug).toBe(ARCAAI_TRANSCRIPTION_PIPELINE_SLUG);
    expect(ARCAAI_TRANSCRIPTION_PIPELINE_SLUG).toBe('wf-stt-arcaai-realtime-transcription-medical-en');
  });

  it('carries the provenance tag that leads back to the definition', () => {
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.tags).toContain(`${STT_WORKFLOW_TAG_PREFIX}${ARCAAI_TRANSCRIPTION_DEFINITION.id}`);
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.tags).toEqual(expect.arrayContaining(['medical', 'whisper.cpp']));
  });

  it('is a publish ARTIFACT, not a locked copy of a SYSTEM template', () => {
    // `06-stt.ts`'s full-parity mirror stamps `sourceTemplateSlug = slug` +
    // `templateLocked = true` on every tenant copy of a SYSTEM template. This
    // row descends from no template — same posture as ARCAAI_MANUAL_ASR_PIPELINES.
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.sourceTemplateSlug).toBeNull();
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.templateLocked).toBe(false);
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
  });
});

// ---------------------------------------------------------------------------------------------
describe(' D2 — exactly one default ASR pipeline per tenant', () => {
  it('declares itself the ArcaAI default', () => {
    expect(ARCAAI_TRANSCRIPTION_PIPELINE.isDefault).toBe(true);
  });

  it('DEMOTES every other ArcaAI default in the same pass, then promotes itself', async () => {
    // A data-only assertion cannot cover this: `seedAsrPipelines` deliberately
    // never clobbers `isDefault` on update, so on an existing database a
    // freshly-created `isDefault: true` row would sit beside whatever default
    // that database already had. The reconciliation is what makes "exactly one"
    // true, so the reconciliation is what is asserted.
    const calls: any[] = [];
    await seedArcaaiTranscriptionAgent(mockClient(calls));

    const demote = calls.find((c) => c.model === 'asrPipeline' && c.op === 'updateMany' && c.args.data.isDefault === false);
    expect(demote, 'no demotion of the tenant’s previous default').toBeDefined();
    expect(demote.args.where.tenantId).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
    expect(demote.args.where.isDefault).toBe(true);
    expect(demote.args.where.id).toEqual({ not: ARCAAI_TRANSCRIPTION_PIPELINE.id });

    const promote = calls.find((c) => c.model === 'asrPipeline' && c.op === 'updateMany' && c.args.data.isDefault === true);
    expect(promote, 'the new pipeline is never promoted').toBeDefined();
    expect(promote.args.where.id).toBe(ARCAAI_TRANSCRIPTION_PIPELINE.id);
    // Demote BEFORE promote: the reverse order leaves a window with two.
    expect(calls.indexOf(demote)).toBeLessThan(calls.indexOf(promote));
  });

  it('does not stamp `isDefault` on the pipeline UPDATE branch', async () => {
    // `isDefault` is admin state. Refreshing it from the seed row on every
    // re-seed would silently revert an admin who moved the default, which is
    // the exact rule `seedAsrPipelines` follows and this row must not break.
    const calls: any[] = [];
    await seedArcaaiTranscriptionAgent(mockClient(calls));
    const upsert = calls.find((c) => c.model === 'asrPipeline' && c.op === 'upsert');
    expect(upsert.args.create.isDefault).toBe(true);
    expect(upsert.args.update.isDefault).toBeUndefined();
  });

  it('CREATE-ONLY for the definition: an existing row is skipped, never overwritten', async () => {
    // A PUBLISHED WorkflowDefinition is immutable at three application layers
    // AND at a database trigger; an update branch would raise at the DB.
    const calls: any[] = [];
    await seedArcaaiTranscriptionAgent(mockClient(calls, { definitionExists: true }));
    expect(calls.filter((c) => c.model === 'workflowDefinition' && c.op === 'create')).toEqual([]);
  });
});

/** A minimal recording stand-in for the extended Prisma client. */
function mockClient(calls: any[], options: { definitionExists?: boolean } = {}): any {
  const record = (model: string, op: string) => async (args: unknown) => {
    calls.push({ model, op, args });
    return op === 'updateMany' ? { count: 1 } : {};
  };
  return {
    workflowDefinition: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'workflowDefinition', op: 'findUnique', args });
        return options.definitionExists ? { id: 'x' } : null;
      },
      create: record('workflowDefinition', 'create'),
    },
    asrPipeline: {
      upsert: record('asrPipeline', 'upsert'),
      updateMany: record('asrPipeline', 'updateMany'),
    },
  };
}

// ---------------------------------------------------------------------------------------------
describe(' D2 — seed-mode posture', () => {
  it('gates the ArcaAI half out of `safe` and keeps the SYSTEM template in', async () => {
    const { SEED_PHASES_EXCLUDED_FROM_SAFE, isPhaseEnabled } = await import('../seed-mode');
    // The ArcaAI row claims a named human authored a PUBLISHED clinical
    // workflow — the same objection that gates `23-arcaai-workflow-authoring`.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).toContain('23a-realtime-transcription-agent-arcaai');
    // The SYSTEM row is the clone-from-template library. Excluding it would
    // ship a production tenant a Workflow Studio with nothing to start from.
    expect(SEED_PHASES_EXCLUDED_FROM_SAFE).not.toContain('23a-realtime-transcription-agent');
    expect(isPhaseEnabled('23a-realtime-transcription-agent', 'safe')).toBe(true);
  });
});
