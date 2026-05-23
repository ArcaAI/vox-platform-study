/**
 * @arcaai/med-ner - MedNERProcessor init() / pipeline-options Tests
 *
 * Targets:
 * - H-6: `aggregation_strategy: 'simple'` MUST be passed to the pipeline.
 * - R-12: `revision` from MODEL_MAP MUST be forwarded to the pipeline.
 * - H-1: chosen device MUST be exposed via `getActiveDevice()`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pipelineFactory, pipelineCallable, recommendedDeviceMock } = vi.hoisted(() => {
  // The callable doubles as the "pipeline" object: it is invoked by
  // MedNERProcessor for inference AND its `.tokenizer` field is read by
  // `buildTokenizer` to count tokens for the chunker. Using a word-based
  // tokenizer keeps the chunker deterministic in tests.
  const pipelineCallable: ReturnType<typeof vi.fn> & { tokenizer?: unknown } = vi.fn().mockResolvedValue([
    { entity_group: 'Disease', score: 0.95, word: 'Type 2 Diabetes', start: 0, end: 15 },
    { entity_group: 'Drug', score: 0.89, word: 'Metformin', start: 30, end: 39 },
  ]);
  pipelineCallable.tokenizer = (text: string) => {
    const words = text.trim().length === 0 ? [] : text.trim().split(/\s+/);
    return { input_ids: words.map((_, i) => i) };
  };
  const pipelineFactory = vi.fn().mockResolvedValue(pipelineCallable);
  const recommendedDeviceMock = vi.fn().mockResolvedValue('wasm');
  return { pipelineFactory, pipelineCallable, recommendedDeviceMock };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineFactory,
  env: {
    allowLocalModels: false,
    useBrowserCache: true,
  },
}));

vi.mock('../utils/browserSupport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/browserSupport.js')>();
  return {
    ...actual,
    getRecommendedDevice: recommendedDeviceMock,
  };
});

import { MedNERProcessor } from '../processors/MedNERProcessor.js';
import { MODEL_MAP, MedicalEntityType } from '../types/index.js';

describe('MedNERProcessor.init() pipeline options', () => {
  beforeEach(() => {
    pipelineFactory.mockClear();
    pipelineCallable.mockClear();
  });

  it('should call pipeline() with aggregation_strategy: "simple" (H-6)', async () => {
    const processor = new MedNERProcessor({ model: 'biomedical' });
    await processor.init();

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    const [, , options] = pipelineFactory.mock.calls[0];
    expect(options).toMatchObject({ aggregation_strategy: 'simple' });
  });

  it('should forward the pinned revision from MODEL_MAP to pipeline() (R-12)', async () => {
    const processor = new MedNERProcessor({ model: 'biomedical' });
    await processor.init();

    const [task, modelId, options] = pipelineFactory.mock.calls[0];
    expect(task).toBe('token-classification');
    const expected = MODEL_MAP.biomedical;
    expect(modelId).toBe(expected.id);
    expect(options).toMatchObject({ revision: expected.revision });
  });

  it('should expose the resolved active device via getActiveDevice() (H-1)', async () => {
    const processor = new MedNERProcessor({ model: 'default' });

    // Before init, no device has been resolved.
    expect(processor.getActiveDevice()).toBeNull();

    await processor.init();

    // After init, the chosen device is surfaced.
    expect(processor.getActiveDevice()).toBe('wasm');

    const [, , options] = pipelineFactory.mock.calls[0];
    expect(options).toMatchObject({ device: 'wasm' });
  });

  it('should chunk long input via the token-aware chunker and merge entities (C-2)', async () => {
    // Build a long, sentence-rich input that exceeds maxLength (so chunked
    // path triggers) and contains the target entity in the middle, surrounded
    // by filler sentences.
    const filler = Array.from({ length: 40 }, (_, i) => `Filler sentence number ${i}.`).join(' ');
    const target = 'Patient has Type 2 Diabetes today.';
    const text = `${filler} ${target} ${filler}`;
    expect(text.length).toBeGreaterThan(512); // ensure chunked path

    // Mock the pipeline to return the target entity whenever it sees the
    // sentence containing the target; otherwise return nothing.
    pipelineCallable.mockImplementation(async (chunk: string) => {
      if (chunk.includes(target)) {
        // Aggregated output - positions are chunk-local (start where the
        // target appears in this specific chunk).
        const start = chunk.indexOf('Type 2 Diabetes');
        return [
          { entity_group: 'Disease', score: 0.95, word: 'Type 2 Diabetes', start, end: start + 15 },
        ];
      }
      return [];
    });

    const processor = new MedNERProcessor({ model: 'biomedical', maxTokens: 64, stride: 16 });
    await processor.init();
    const result = await processor.extract(text);

    // We expect exactly ONE diabetes entity in the merged output (the chunker
    // overlap would otherwise produce duplicates).
    const diseases = result.entities.filter((e) => e.type === MedicalEntityType.DISEASE);
    expect(diseases).toHaveLength(1);
    expect(diseases[0].text).toBe('Type 2 Diabetes');

    // Absolute position must round-trip into the original text — proving
    // chunk offsets were correctly added back.
    const absStart = diseases[0].start;
    const absEnd = diseases[0].end;
    expect(text.slice(absStart, absEnd)).toBe('Type 2 Diabetes');

    // The pipeline was invoked multiple times (one per chunk) → off-main-
    // thread is unnecessary here, but chunking definitely happened.
    expect(pipelineCallable.mock.calls.length).toBeGreaterThan(1);

    // Reset the default impl so the suite-wide mock is restored for the
    // remaining tests.
    pipelineCallable.mockResolvedValue([
      { entity_group: 'Disease', score: 0.95, word: 'Type 2 Diabetes', start: 0, end: 15 },
      { entity_group: 'Drug', score: 0.89, word: 'Metformin', start: 30, end: 39 },
    ]);
  });

  it('should normalise aggregation-strategy "simple" output to EntitySpan with mapped MedicalEntityType', async () => {
    const processor = new MedNERProcessor({ model: 'biomedical', threshold: 0.5 });
    await processor.init();

    const result = await processor.extract('Patient has Type 2 Diabetes and takes Metformin');

    // The post-processor must NOT pass through BIO labels as the entity text;
    // 'Type 2 Diabetes' must arrive intact and typed as DISEASE.
    const disease = result.entities.find((e) => e.type === MedicalEntityType.DISEASE);
    expect(disease, 'expected a DISEASE entity in the result').toBeDefined();
    expect(disease!.text).toBe('Type 2 Diabetes');
    expect(disease!.rawLabel.startsWith('B-') || disease!.rawLabel.startsWith('I-')).toBe(false);

    const drug = result.entities.find((e) => e.type === MedicalEntityType.MEDICATION);
    expect(drug, 'expected a MEDICATION entity in the result').toBeDefined();
    expect(drug!.text).toBe('Metformin');
  });
});
