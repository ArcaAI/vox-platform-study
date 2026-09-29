/**
 * TASK-1021 L1.2 — `buildResolvedServingSpec`: one `AiModel` row → the C-1 engine-build contract
 * `apps/vllm` reads, or a NAMED refusal. Pure: no repository, no tenant, no I/O.
 */
import { describe, expect, it } from 'vitest';
import type { AiModelEntity } from '@arcaai/domains';
import fixture from '../../../../../../../tests/contracts/resolved-serving-spec.fixture.json';
import { buildResolvedServingSpec } from '../build-resolved-serving-spec';

/** The row the committed fixture describes. */
function whisperRow(overrides: Record<string, unknown> = {}): AiModelEntity {
  return {
    id: '00000000-0000-0000-0001-000000000026',
    tenantId: '00000000-0000-0000-0000-000000000000',
    version: 1,
    slug: 'arcaai-whisper-large-ml-en-vllm',
    taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
    format: 'SAFETENSOR',
    libraryName: 'vllm',
    servedBy: 'vllm',
    provider: 'vllm',
    sourceUri: 'hf:arcaai/whisper-large-ml-en',
    sourceRevision: null,
    checksum: null,
    computeType: 'float16',
    bucketPrefix: 'hf/hub/models--arcaai--whisper-large-ml-en/snapshots/0000000000000000000000000000000000000000',
    primaryObject: 'model.safetensors',
    resourceStatus: 'ENABLED',
    metaData: { serving: { vramGiB: 5, maxNumSeqs: 64 } },
    ...overrides,
  } as unknown as AiModelEntity;
}

describe('buildResolvedServingSpec (TASK-1021 C-1)', () => {
  it('builds exactly the committed fixture from the whisper row', () => {
    expect(buildResolvedServingSpec(whisperRow())).toEqual({ ok: true, spec: fixture });
  });

  it.each([
    ['AUTOMATIC_SPEECH_RECOGNITION', 'asr'],
    ['TEXT_GENERATION', 'llm'],
    ['TEXT_TO_SPEECH', 'tts'],
  ])('derives kind from taskType %s → %s', (taskType, kind) => {
    const result = buildResolvedServingSpec(whisperRow({ taskType }));
    expect(result.ok && result.spec.kind).toBe(kind);
  });

  it('refuses a non-SAFETENSOR row with FORMAT_UNSUPPORTED', () => {
    expect(buildResolvedServingSpec(whisperRow({ format: 'WHISPER_CPP' }))).toEqual({ ok: false, reason: 'FORMAT_UNSUPPORTED' });
  });

  it('refuses a task vLLM serves no engine for with FORMAT_UNSUPPORTED', () => {
    expect(buildResolvedServingSpec(whisperRow({ taskType: 'VOICE_ACTIVITY_DETECTION' }))).toEqual({ ok: false, reason: 'FORMAT_UNSUPPORTED' });
  });

  it.each([
    ['no _metadata at all', null],
    ['no _metadata.serving', { asr: { maxModelLen: 448 } }],
    ['a zero vramGiB', { serving: { vramGiB: 0 } }],
    ['a string vramGiB', { serving: { vramGiB: '5' } }],
  ])('refuses %s with SERVING_FACTS_MISSING', (_label, metaData) => {
    expect(buildResolvedServingSpec(whisperRow({ metaData }))).toEqual({ ok: false, reason: 'SERVING_FACTS_MISSING' });
  });

  it.each(['DISABLED', 'ARCHIVED', 'SUSPENDED'])('refuses a %s row with DISABLED', (resourceStatus) => {
    expect(buildResolvedServingSpec(whisperRow({ resourceStatus }))).toEqual({ ok: false, reason: 'DISABLED' });
  });

  it('derives localPath as null when the row has no bucket prefix', () => {
    const result = buildResolvedServingSpec(whisperRow({ bucketPrefix: null, primaryObject: null }));
    expect(result.ok && result.spec.localPath).toBeNull();
  });

  it('hands vLLM the snapshot DIRECTORY, never the primary object inside it', () => {
    const result = buildResolvedServingSpec(
      whisperRow({ bucketPrefix: 'arcaai-whisper-large-ml-en-vllm/fp16-abc/', primaryObject: 'model.safetensors' }),
    );
    expect(result.ok && result.spec.localPath).toBe('/mnt/models-bucket/arcaai-whisper-large-ml-en-vllm/fp16-abc');
  });

  it('reads quantization and maxModelLen from _metadata.asr, and the engine knobs from _metadata.serving', () => {
    const metaData = { asr: { quantization: 'fp8', maxModelLen: 448 }, serving: { vramGiB: 6.5, maxNumSeqs: 32, enforceEager: true } };
    const result = buildResolvedServingSpec(whisperRow({ metaData }));
    expect(result.ok && result.spec).toMatchObject({
      quantization: 'fp8',
      maxModelLen: 448,
      engine: { vramGiB: 6.5, maxNumSeqs: 32, enforceEager: true },
    });
  });

  it('keys the runtime on the checksum when the row has one, else on the version', () => {
    const withChecksum = buildResolvedServingSpec(whisperRow({ checksum: 'sha256:abc' }));
    expect(withChecksum.ok && withChecksum.spec.runtimeKey).toBe('00000000-0000-0000-0001-000000000026:sha256:abc');
    const bumped = buildResolvedServingSpec(whisperRow({ version: 7 }));
    expect(bumped.ok && bumped.spec.runtimeKey).toBe('00000000-0000-0000-0001-000000000026:v7');
  });

  it('names the ROW owner as tenantId', () => {
    const result = buildResolvedServingSpec(whisperRow({ tenantId: 'a0000000-0000-0000-0000-00000000000a' }));
    expect(result.ok && result.spec.tenantId).toBe('a0000000-0000-0000-0000-00000000000a');
  });
});
