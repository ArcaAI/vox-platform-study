/**
 * TASK-724 Task 4 — STT graph -> `AsrPipeline`/`AsrPipelineVersion` compiler.
 *
 * `compileSttGraphToYaml` is a pure function (no I/O) that walks a `CompiledWorkflowConfig`
 * (the output of `@arcaai/workflow-contract`'s `compile()`, per §1's central design decision:
 * a published STT `WorkflowDefinition` compiles to `AsrPipeline.configYaml` — no per-node
 * Temporal dispatch). `SttPipelineCompilerService` wraps it and writes through the EXISTING
 * `PipelineService` (never a raw repository call), so `PipelineService`'s own
 * `broadcastSysEvent`/OCC/version-snapshot behavior is reused unmodified (README §4 Task 4).
 *
 * RED-first: this file was authored, and run RED (`compileSttGraphToYaml`/
 * `SttPipelineCompilerService` did not exist), before `stt-pipeline.compiler.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CompiledWorkflowConfig } from '@arcaai/workflow-contract';
import { compileSttGraphToYaml, SttPipelineCompilerService, STT_WORKFLOW_TAG_PREFIX, sttWorkflowPipelineSlug } from '../stt-pipeline.compiler';

function compiledConfig(nodes: Array<{ type: string; config: Record<string, unknown> }>): CompiledWorkflowConfig {
  return {
    formatVersion: 1,
    definitionId: 'def-1',
    slug: 'my_stt_flow',
    versionNumber: 1,
    tenantId: 'tenant-1',
    paletteKey: 'stt',
    compiledAt: '2026-08-17T00:00:00.000Z',
    compilerVersion: '0.1.0',
    registryChecksum: 'reg-checksum',
    ruleSetVersion: 1,
    stages: [
      {
        stageIndex: 0,
        nodes: nodes.map((n, i) => ({
          nodeId: `n${i}`,
          type: n.type,
          activity: `interpreter.${n.type}`,
          config: n.config,
          timeoutSeconds: 60,
          retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
          inputs: [],
          onError: 'fail' as const,
          emitsTrajectory: true as const,
        })),
      },
    ],
    gates: [],
    policyBindings: { guardrailProfile: 'STANDARD', redactionRuleSetId: null, promptTemplateRefs: [], contextSchemaVersionId: null, entitlementKeys: [] },
    caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
    checksum: 'checksum-1',
  };
}

describe('compileSttGraphToYaml', () => {
  it('emits models.asr from the mandatory stt.asrEngine node, parseable YAML', () => {
    const config = compiledConfig([{ type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } }]);

    const yaml = compileSttGraphToYaml(config);
    const parsed = parseYaml(yaml) as { models: { asr: string } };

    expect(parsed.models.asr).toBe('whisper-large-v3');
  });

  it('throws (no PipelineService write attempted) when no stt.asrEngine node is present', () => {
    const config = compiledConfig([{ type: 'stt.transcriptOutput', config: {} }]);
    expect(() => compileSttGraphToYaml(config)).toThrow(/stt\.asrEngine/);
  });

  it('throws when the stt.asrEngine node carries no modelSlug', () => {
    const config = compiledConfig([{ type: 'stt.asrEngine', config: {} }]);
    expect(() => compileSttGraphToYaml(config)).toThrow(/modelSlug/);
  });

  it('adds models.vad and models.denoise when their optional nodes are present', () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'stt.vad', config: { modelSlug: 'silero-vad-v4' } },
      { type: 'stt.noiseFilter', config: { modelSlug: 'rnnoise' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as { models: { asr: string; vad: string; denoise: string } };

    expect(parsed.models.vad).toBe('silero-vad-v4');
    expect(parsed.models.denoise).toBe('rnnoise');
  });

  it('omits vad/denoise from models when their optional nodes are absent', () => {
    const config = compiledConfig([{ type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } }]);
    const parsed = parseYaml(compileSttGraphToYaml(config)) as { models: Record<string, unknown> };

    expect(parsed.models.vad).toBeUndefined();
    expect(parsed.models.denoise).toBeUndefined();
  });

  it('maps a stt.diarization node to diarization.enabled + models.segmentation/embedding', () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'stt.diarization', config: { modelSlug: 'pyannote-seg', embeddingModelSlug: 'speaker-embed' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as {
      models: { segmentation: string; embedding: string };
      diarization: { enabled: boolean };
    };

    expect(parsed.models.segmentation).toBe('pyannote-seg');
    expect(parsed.models.embedding).toBe('speaker-embed');
    expect(parsed.diarization.enabled).toBe(true);
  });

  it("resolves a single-mode stt.languageDetection node to inference.language (mirrors apps/stt's language_modes.py catalog)", () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'stt.languageDetection', config: { mode: 'single', languageModeId: 'ml' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as { inference: { language: string; code_switching?: boolean } };

    expect(parsed.inference.language).toBe('ml');
    expect(parsed.inference.code_switching).toBeUndefined();
  });

  it('resolves a code_switch-mode node to inference.language + inference.code_switching', () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'stt.languageDetection', config: { mode: 'code_switch', languageModeId: 'ml-en' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as { inference: { language: string; code_switching: boolean } };

    expect(parsed.inference.language).toBe('ml');
    expect(parsed.inference.code_switching).toBe(true);
  });

  it('emits no inference section for auto-mode language detection (runtime auto-detects)', () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'stt.languageDetection', config: { mode: 'auto' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as { inference?: unknown };

    expect(parsed.inference).toBeUndefined();
  });

  it('ignores nodes belonging to other palettes/types (defensive: only reads stt.* config)', () => {
    const config = compiledConfig([
      { type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } },
      { type: 'noop', config: { modelSlug: 'should-be-ignored' } },
    ]);

    const parsed = parseYaml(compileSttGraphToYaml(config)) as { models: { asr: string } };
    expect(parsed.models.asr).toBe('whisper-large-v3');
  });
});

describe('sttWorkflowPipelineSlug', () => {
  it('converts underscores to hyphens and prefixes wf-stt-', () => {
    expect(sttWorkflowPipelineSlug('my_stt_flow')).toBe('wf-stt-my-stt-flow');
  });

  it('never emits a slug ending in a hyphen even when the source slug ends in an underscore', () => {
    expect(sttWorkflowPipelineSlug('trailing_')).toMatch(/[a-z0-9]$/);
  });
});

describe('SttPipelineCompilerService', () => {
  const mockPipelineService = {
    getBySlug: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  let service: SttPipelineCompilerService;

  const entity = { id: 'def-1', slug: 'my_stt_flow', versionNumber: 2, name: 'My STT Flow', tenantId: 'tenant-1' };
  const config = compiledConfig([{ type: 'stt.asrEngine', config: { modelSlug: 'whisper-large-v3' } }]);

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new SttPipelineCompilerService(mockPipelineService as any);
  });

  it('creates a new AsrPipeline via PipelineService when none exists for the deterministic slug', async () => {
    mockPipelineService.getBySlug.mockResolvedValue(null);
    mockPipelineService.create.mockResolvedValue({ id: 'pipe-1', slug: 'wf-stt-my-stt-flow', version: 1 });

    const result = await service.compileAndPublish(entity, config);

    expect(mockPipelineService.getBySlug).toHaveBeenCalledWith('wf-stt-my-stt-flow');
    expect(mockPipelineService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'wf-stt-my-stt-flow',
        name: entity.name,
        tags: [`${STT_WORKFLOW_TAG_PREFIX}${entity.id}`],
      }),
    );
    expect(mockPipelineService.update).not.toHaveBeenCalled();
    expect(result.id).toBe('pipe-1');
  });

  it('updates (new AsrPipelineVersion snapshot) the existing AsrPipeline via OCC when the slug already exists', async () => {
    mockPipelineService.getBySlug.mockResolvedValue({ id: 'pipe-1', slug: 'wf-stt-my-stt-flow', version: 3, tags: ['other-tag'] });
    mockPipelineService.update.mockResolvedValue({ id: 'pipe-1', slug: 'wf-stt-my-stt-flow', version: 4 });

    const result = await service.compileAndPublish(entity, config);

    expect(mockPipelineService.update).toHaveBeenCalledWith(
      'pipe-1',
      expect.objectContaining({
        expectedVersion: 3,
        tags: expect.arrayContaining(['other-tag', `${STT_WORKFLOW_TAG_PREFIX}${entity.id}`]),
      }),
    );
    expect(mockPipelineService.create).not.toHaveBeenCalled();
    expect(result.id).toBe('pipe-1');
  });

  it('propagates a compile failure (missing stt.asrEngine) without calling PipelineService at all', async () => {
    const badConfig = compiledConfig([{ type: 'stt.transcriptOutput', config: {} }]);

    await expect(service.compileAndPublish(entity, badConfig)).rejects.toThrow(/stt\.asrEngine/);
    expect(mockPipelineService.getBySlug).not.toHaveBeenCalled();
    expect(mockPipelineService.create).not.toHaveBeenCalled();
  });
});
