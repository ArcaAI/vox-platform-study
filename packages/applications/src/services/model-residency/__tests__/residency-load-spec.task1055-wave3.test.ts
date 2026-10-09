import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentResolverService } from '../../agent/agent-resolver.service';
import { ResidencyLoadSpecBuilder, ResidencyLoadSpecError, loadBlockedReasonFor } from '../residency-load-spec.builder';

/**
 * TASK-1055 wave 3 (README §10, W3-2 / G2 / G3) — a console load never needs an agent.
 *
 *  - stt sends the MODEL-ONLY spec `{model: <AsrSpecModel>}`, built from the AiModel row with the same
 *    projection `buildResolvedAsrSpec` uses for that role — for ASR rows AND stage rows (VAD, denoise,
 *    diarization embedding, punctuation, endpointing). No agent is looked up.
 *  - tts sends `{engine, model: <TtsSpecModel>}` (contract `wave3.ttsResidency.$amendment`), the engine
 *    being `ttsEngineProvider(row)` and the model the same projection `tts-spec.ts` uses.
 *
 * The real `AgentResolverService` supplies the row → `ResolvedAgentModel` half (derived `localPath`), so
 * these tests exercise the production projection end to end.
 */

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'));
const [ASR_EXAMPLE, VAD_EXAMPLE] = contract.wave3.sttModelOnly.loadSpecExamples as Array<{ model_ref: string; load_spec: { model: Record<string, unknown> } }>;

type Row = Record<string, unknown> & { id: string; slug: string; tenantId: string };
const row = (slug: string, fields: Record<string, unknown>): Row => ({
  id: `id-${slug}`,
  slug,
  tenantId: SYSTEM,
  sourceRevision: null,
  checksum: null,
  computeType: null,
  provider: null,
  bucketPrefix: null,
  primaryObject: null,
  metaData: {},
  deploymentKind: 'SELF_HOSTED',
  resourceStatus: 'ENABLED',
  ...fields,
});

const WHISPER = row(ASR_EXAMPLE.model_ref, {
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  format: 'WHISPER_CPP',
  libraryName: 'whisper.cpp',
  sourceUri: 'taphuynh/whisper-large-en-medical-260726-merged-GGUF',
  computeType: 'q8_0',
  servedBy: 'stt',
  bucketPrefix: 'whisper-large-en-medical',
  primaryObject: 'ggml-model-q8_0.gguf',
});
const SILERO = row('silero-vad', {
  taskType: 'VOICE_ACTIVITY_DETECTION',
  format: 'ONNX',
  libraryName: 'onnxruntime',
  sourceUri: 'onnx-community/silero-vad',
  servedBy: 'stt',
});
const stage = (slug: string, taskType: string) => row(slug, { taskType, format: 'PYTORCH', libraryName: 'speechbrain', sourceUri: `hub/${slug}`, servedBy: 'stt' });
const KOKORO = row('kokoro-82m', {
  taskType: 'TEXT_TO_SPEECH',
  format: 'PYTORCH',
  libraryName: 'kokoro',
  sourceUri: 'hexgrad/Kokoro-82M',
  provider: 'built-in',
  servedBy: 'tts',
  bucketPrefix: 'tts/kokoro-82m',
  metaData: { ttsProvider: 'kokoro' },
});

function build(rows: Row[], { wired = true } = {}) {
  const matches = (m: Row, filters: Record<string, unknown>) => Object.entries(filters).every(([key, want]) => m[key] === want);
  const aiModels = {
    findAll: async ({ filters }: { filters: Record<string, unknown> }) => rows.filter((m) => matches(m, filters)),
    findBySlug: async (tenantId: string, slug: string) => rows.find((m) => m.tenantId === tenantId && m.slug === slug) ?? null,
  };
  const resolver = new AgentResolverService({} as never, {} as never, aiModels as never, {} as never);
  return new ResidencyLoadSpecBuilder(aiModels as never, undefined, wired ? resolver : undefined);
}

const refusal = async (promise: Promise<unknown>): Promise<ResidencyLoadSpecError> => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ResidencyLoadSpecError);
  return error as ResidencyLoadSpecError;
};

describe('stt — the model-only load spec (W3-2: an agent is never consulted to LOAD)', () => {
  it('an ASR row → the contract example, its localPath derived from the row`s bucket identity', async () => {
    const spec = await build([WHISPER]).build('stt', ASR_EXAMPLE.model_ref);

    expect(spec).toEqual({
      model: { ...ASR_EXAMPLE.load_spec.model, localPath: '/mnt/models-bucket/whisper-large-en-medical/ggml-model-q8_0.gguf' },
    });
  });

  it('a VAD row → exactly the contract example', async () => {
    expect(await build([SILERO]).build('stt', 'silero-vad')).toEqual(VAD_EXAMPLE.load_spec);
  });

  it.each([
    ['deepfilternet3', 'AUDIO_TO_AUDIO', 'denoise'],
    ['ecapa-tdnn-voxceleb', 'SPEAKER_EMBEDDING', 'embedding'],
    ['pyannote-diarization', 'SPEAKER_DIARIZATION', 'embedding'],
    ['cadence-fast', 'TOKEN_CLASSIFICATION', 'punctuation'],
    ['turn-detector', 'TEXT_CLASSIFICATION', 'endpointing'],
  ])('a %s row (%s) loads in the %s role', async (slug, taskType, role) => {
    const spec = (await build([stage(slug, taskType)]).build('stt', slug)) as { model: Record<string, unknown> };
    expect(spec.model).toMatchObject({ role, slug, sourceUri: `hub/${slug}`, tenantId: SYSTEM });
  });

  it('a slug no platform row has is MODEL_UNKNOWN', async () => {
    const error = await refusal(build([SILERO]).build('stt', 'no-such-model'));
    expect(error.code).toBe('MODEL_UNKNOWN');
  });

  it('a row of a kind no pipeline role loads is refused by name — the catalogue states the same words', async () => {
    const odd = stage('odd-model', 'TEXT_TO_SPEECH');
    const error = await refusal(build([odd]).build('stt', 'odd-model'));
    expect(error.code).toBe('LOAD_FAILED');
    expect(loadBlockedReasonFor('stt', odd as never)).toBe(error.message);
  });

  it('stage rows are no longer refused by the catalogue', () => {
    for (const r of [SILERO, stage('ecapa-tdnn-voxceleb', 'SPEAKER_EMBEDDING'), stage('deepfilternet3', 'AUDIO_TO_AUDIO')]) {
      expect(loadBlockedReasonFor('stt', r as never)).toBeNull();
    }
  });

  it('fails closed, by name, when the model projection is not wired', async () => {
    const error = await refusal(build([SILERO], { wired: false }).build('stt', 'silero-vad'));
    expect(error.code).toBe('LOAD_FAILED');
  });
});

describe('tts — {engine, model} (contract wave3.ttsResidency, $amendment)', () => {
  it('a self-hosted Kokoro row → the contract example, its localPath derived from the row`s bucket identity', async () => {
    // The amended example (orchestrator commit 843184d3a), spelled out: this lane's base predates it.
    expect(await build([KOKORO]).build('tts', 'kokoro-82m')).toEqual({
      engine: 'kokoro',
      model: {
        role: 'primary',
        slug: 'kokoro-82m',
        taskType: 'TEXT_TO_SPEECH',
        format: 'PYTORCH',
        sourceUri: 'hexgrad/Kokoro-82M',
        sourceRevision: null,
        localPath: '/mnt/models-bucket/tts/kokoro-82m/',
        checksum: null,
        computeType: null,
        provider: 'kokoro',
        tenantId: SYSTEM,
        artifacts: {},
        voices: [],
      },
    });
  });

  it('a row naming no engine falls back to its slug with - → _ (the name apps/tts registers)', async () => {
    const parler = row('indic-parler', { taskType: 'TEXT_TO_SPEECH', format: 'SAFETENSOR', sourceUri: 'ai4b/parler', provider: 'built-in', servedBy: 'tts' });
    const spec = (await build([parler]).build('tts', 'indic-parler')) as { engine: string; model: { provider: string } };
    expect(spec.engine).toBe('indic_parler');
    expect(spec.model.provider).toBe('indic_parler');
  });

  it('a slug no platform tts row has is MODEL_UNKNOWN', async () => {
    const error = await refusal(build([SILERO]).build('tts', 'silero-vad'));
    expect(error.code).toBe('MODEL_UNKNOWN');
  });
});
