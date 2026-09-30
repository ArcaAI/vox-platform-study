/**
 * TASK-1023 B5 (OD-9) — a vLLM-served row is servable the moment it is registered.
 *
 * `vramGiB` is REQUIRED by the serving spec (`SERVING_FACTS_MISSING` otherwise). Registration
 * writes a derived estimate, `ceil(weightsGiB × 1.25 + 1)`, flagged `derived: true`, ONLY when the
 * row is vLLM-served and carries no `vramGiB` yet — an admin's value is never overwritten.
 */
import { describe, expect, it } from 'vitest';
import { buildResolvedServingSpec } from '../build-resolved-serving-spec';
import { deriveVramGiB, isVllmServed, withDerivedServingFacts } from '../derive-serving-facts';

const GiB = 1024 ** 3;

describe('deriveVramGiB', () => {
  it.each([
    [0, 1],
    [1 * GiB, 3], // 1.25 + 1 = 2.25 → 3
    [4 * GiB, 6], // 5 + 1
    [2 * GiB, 4], // 2.5 + 1 → 4
    [15.5 * GiB, 21], // 19.375 + 1 → 21
  ])('%d bytes → %d GiB', (bytes, expected) => {
    expect(deriveVramGiB(bytes)).toBe(expected);
  });
});

describe('isVllmServed', () => {
  it('is the serving-spec route rule: servedBy === "vllm"', () => {
    expect(isVllmServed('vllm')).toBe(true);
    expect(isVllmServed('stt')).toBe(false);
    expect(isVllmServed('lmstudio')).toBe(false);
    expect(isVllmServed(null)).toBe(false);
  });
});

describe('withDerivedServingFacts', () => {
  it('writes the derived vramGiB when absent, keeping every other _metadata key', () => {
    const out = withDerivedServingFacts({ download: { jobId: 'j' }, serving: { maxNumSeqs: 8 } }, { servedBy: 'vllm', weightBytes: 4 * GiB });
    expect(out).toEqual({ download: { jobId: 'j' }, serving: { maxNumSeqs: 8, vramGiB: 6, derived: true } });
  });

  it('writes it onto an empty _metadata', () => {
    expect(withDerivedServingFacts(null, { servedBy: 'vllm', weightBytes: GiB })).toEqual({ serving: { vramGiB: 3, derived: true } });
  });

  it('never overwrites a vramGiB that is present', () => {
    const meta = { serving: { vramGiB: 10 } };
    expect(withDerivedServingFacts(meta, { servedBy: 'vllm', weightBytes: 40 * GiB })).toBe(meta);
  });

  it('never writes for a row vLLM does not serve', () => {
    const meta = { asr: { beamSize: 5 } };
    expect(withDerivedServingFacts(meta, { servedBy: 'stt', weightBytes: 4 * GiB })).toBe(meta);
    expect(withDerivedServingFacts(undefined, { servedBy: 'lmstudio', weightBytes: 4 * GiB })).toBeUndefined();
  });

  it('the serving spec then resolves for such a row (the extra `derived` key is tolerated)', () => {
    const metaData = withDerivedServingFacts(null, { servedBy: 'vllm', weightBytes: 3 * GiB });
    const built = buildResolvedServingSpec({
      id: 'm-1',
      slug: 'whisper-large-v3',
      tenantId: '00000000-0000-0000-0000-000000000000',
      resourceStatus: 'ENABLED',
      taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
      format: 'SAFETENSOR',
      servedBy: 'vllm',
      libraryName: 'transformers',
      bucketPrefix: 'hf/hub/models--openai--whisper-large-v3/snapshots/abc/',
      primaryObject: null,
      sourceUri: 'hf:openai/whisper-large-v3',
      sourceRevision: 'abc',
      checksum: null,
      computeType: 'float16',
      version: 1,
      metaData,
    } as never);
    expect(built).toMatchObject({ ok: true, spec: { engine: { vramGiB: 5, maxNumSeqs: null, enforceEager: null } } });
  });
});
