import { describe, expect, it } from 'vitest';
import { AiModelAvailability, ModelTaskType } from '@arcaai/domains';
import { loadBlockedReasonFor } from '../residency-load-rules';
import { type CatalogueBuildInput, type CatalogueModelRow, buildResidencyCatalogue } from '../residency-catalogue';

/**
 * TASK-1055 §10.7 follow-up 3 — a row whose weights the inventory MEASURED as absent says so on the
 * console instead of offering a Load that fails at load time (`qwen3guard-gen-0.6b`: no GGUF on the LM
 * Studio tier; `arcaai-whisper-large-ml-en-gguf-q8_0`: only an f16 file published). Only a CHECKED
 * MISSING blocks — an unmeasured row, or any other verdict, never does.
 */

const CHECKED = new Date('2026-10-10T00:00:00Z');
const QWEN_MISSING_REASON = "not on the LM Studio serving tier (no 'qwen3guard-gen-0.6b-gguf/' prefix in the bucket)";

const lmRow = (o: Record<string, unknown> = {}) => ({
  slug: 'qwen3guard-gen-0.6b',
  sourceUri: 'qwen3guard-gen-0.6b',
  taskType: ModelTaskType.GUARDRAIL,
  libraryName: 'llama.cpp',
  availability: AiModelAvailability.MISSING,
  availabilityCheckedAt: CHECKED,
  availabilityDetail: { reason: QWEN_MISSING_REASON },
  ...o,
});

describe('loadBlockedReasonFor — measured availability', () => {
  it('a checked MISSING row is blocked with the inventory`s own reason', () => {
    expect(loadBlockedReasonFor('lm-studio', lmRow())).toBe(`Weights are not published to the models bucket — ${QWEN_MISSING_REASON}`);
  });

  it('the same holds for an stt row the inventory found without its quant file', () => {
    const reason = "no snapshot file matches quantization 'q8_0' (files seen: ggml-whisper-turbo-ml-en-codeswitch-f16.bin)";
    const stt = lmRow({
      slug: 'arcaai-whisper-large-ml-en-gguf-q8_0',
      taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
      libraryName: 'whisper.cpp',
      availabilityDetail: { reason },
    });
    expect(loadBlockedReasonFor('stt', stt)).toBe(`Weights are not published to the models bucket — ${reason}`);
  });

  it('a MISSING row with no detail reason is still blocked, without a dangling dash', () => {
    expect(loadBlockedReasonFor('lm-studio', lmRow({ availabilityDetail: null }))).toBe('Weights are not published to the models bucket');
  });

  it.each([AiModelAvailability.AVAILABLE, AiModelAvailability.PARTIAL, AiModelAvailability.NOT_APPLICABLE, AiModelAvailability.UNKNOWN])(
    'a checked %s row is never blocked on availability',
    (availability) => {
      expect(loadBlockedReasonFor('lm-studio', lmRow({ availability }))).toBeNull();
    },
  );

  it('an UNCHECKED MISSING row (no availabilityCheckedAt) is not blocked', () => {
    expect(loadBlockedReasonFor('lm-studio', lmRow({ availabilityCheckedAt: null }))).toBeNull();
    expect(loadBlockedReasonFor('lm-studio', lmRow({ availabilityCheckedAt: undefined }))).toBeNull();
  });
});

describe('the catalogue projection carries availability into the rule', () => {
  const usage = {
    get: () => ({
      agentCount: 0,
      tenantCount: 0,
      liveConsultation: false,
      uses: [],
      consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
    }),
  } as never;
  const model = (o: Record<string, unknown>): CatalogueModelRow =>
    ({
      id: 'qwen',
      name: 'Qwen3Guard-Gen 0.6B',
      format: 'GGUF',
      deploymentKind: 'SELF_HOSTED',
      servedBy: 'lmstudio',
      provider: 'lm-studio',
      wireModelId: 'qwen3guard-gen-0.6b',
      memorySizeMb: 800,
      ...lmRow(),
      ...o,
    }) as unknown as CatalogueModelRow;
  const input = (catalogue: CatalogueModelRow[]): CatalogueBuildInput => ({
    now: Date.now(),
    mode: 'shadow',
    reportedAt: 't',
    freshness: { maxAgeSeconds: 1, staleServices: [], oldestReportAt: null } as never,
    headroomPercent: 15,
    devices: [],
    staleServices: [],
    entries: [],
    failed: [],
    loading: [],
    catalogue,
    modelById: () => undefined,
    usage,
    classify: () => ({ class: 'ON_DEMAND', classSource: 'default', policy: null }),
    observedBytes: () => undefined,
    observedLoadSeconds: () => null,
    recommendations: [],
  });
  const find = (catalogue: CatalogueModelRow[]) =>
    buildResidencyCatalogue(input(catalogue))
      .services.flatMap((s) => s.models)
      .find((m) => m.aiModelId === 'qwen')!;

  it('a measured-MISSING LM Studio row shows the reason beside its Load action', () => {
    const m = find([model({})]);
    expect(m.actions).toContain('load');
    expect(m.loadBlockedReason).toBe(`Weights are not published to the models bucket — ${QWEN_MISSING_REASON}`);
  });

  it('the same row measured AVAILABLE carries no reason', () => {
    expect(find([model({ availability: AiModelAvailability.AVAILABLE })])).not.toHaveProperty('loadBlockedReason');
  });
});
